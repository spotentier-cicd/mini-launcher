const express = require("express") as typeof import("express");
const { spawn, execFileSync } = require("node:child_process") as typeof import("node:child_process");
const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const net = require("node:net") as typeof import("node:net");
const crypto = require("node:crypto") as typeof import("node:crypto");
const launcherEnv = (require("dotenv") as typeof import("dotenv")).config();
const logger = require("./logger.ts") as import("winston").Logger & {
  logPath: string;
  logDir: string;
};

type Request = import("express").Request;
type Response = import("express").Response;
type NextFunction = import("express").NextFunction;
type ChildProcess = import("node:child_process").ChildProcess;

/** Un projet tel que découvert sur le disque, avant calcul de son statut. */
interface Project {
  id: string;
  name: string;
  cwd: string;
  scripts: string[];
  defaultScript: string | null;
  port: number | null;
  url: string | null;
  /** Fournis par une override de config.json. */
  command?: string;
  args?: string[];
  pinnedPort?: boolean;
}

type Status = import("./src/types.js").Status;
/** Un projet enrichi de son état courant, tel qu'envoyé au client. */
type ProjectState = import("./src/types.js").ProjectState;

/** Une entrée de `running` : un process vivant que le dashboard suit. */
interface RunningEntry {
  pid: number;
  startedAt: number;
  script: string | null;
  /** `null` pour un process réadopté : ses pipes sont perdus. */
  proc: ChildProcess | null;
  adopted: boolean;
  port: number | null;
}

/** Ce que `logs/running.json` conserve entre deux démarrages. */
interface PersistedEntry {
  pid: number;
  startedAt: number;
  script: string | null;
  port: number | null;
}

interface Override {
  name?: string;
  port?: number;
  url?: string;
  command?: string;
  args?: string[];
}

/** Une erreur portant le code HTTP à renvoyer au client. */
type HttpError = Error & { status?: number };

/** `noUncheckedIndexedAccess` rend `req.params.id` optionnel : on le ramène à une chaîne. */
function paramId(req: Request): string {
  return req.params.id ?? "";
}

/**
 * Express 4 ne rattrape pas le rejet d'un handler `async` : l'erreur n'atteint
 * jamais le middleware d'erreur et la requête reste pendante jusqu'au timeout
 * du client. On redirige donc explicitement vers `next`.
 */
function asyncRoute(handler: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void handler(req, res).catch(next);
  };
}

/** `catch (e)` donne un `unknown` : on le ramène à une Error exploitable. */
function asError(e: unknown): HttpError {
  if (e instanceof Error) return e;
  // `String(objet)` donnerait « [object Object] », inexploitable dans un journal.
  if (typeof e === "object" && e !== null) {
    try {
      return new Error(JSON.stringify(e));
    } catch {
      return new Error("[objet non sérialisable]"); // référence circulaire
    }
  }
  return new Error(String(e));
}

/** `Number(x) || défaut` avale un 0 légitime : SCAN_DEPTH=0 devenait 2 en silence. */
function envNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const PORT = envNumber(process.env.PORT, 7777);
// Le dashboard exécute des commandes arbitraires : il n'a rien à faire sur une
// interface publique. Ouvrir au-delà de la boucle locale doit rester un geste
// explicite, et impose alors un mot de passe (voir le garde avant listen()).
const BIND_HOST = process.env.BIND_HOST || "127.0.0.1";
const ROOT_DIR = process.env.ROOT_DIR || "../";
const SCAN_DEPTH = envNumber(process.env.SCAN_DEPTH, 2);
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, "config.json");

// La config du launcher ne doit pas fuiter dans les projets qu'il lance :
// dotenv n'écrase jamais une variable déjà définie, donc un PORT hérité gagne
// silencieusement sur le .env du projet — qui se met alors à écouter sur le
// port du dashboard. Et DASHBOARD_PASSWORD n'a rien à faire dans un enfant.
const LAUNCHER_ENV_KEYS = new Set([
  ...Object.keys(launcherEnv.parsed || {}),
  "PORT",
  "ROOT_DIR",
  "SCAN_DEPTH",
  "DASHBOARD_PASSWORD",
  "BIND_HOST",
  "LOG_DIR",
  "CONFIG_PATH",
  "STOP_TIMEOUT_MS",
  "PORT_RELEASE_TIMEOUT_MS",
  "LOCKOUT_MS",
  "STATE_DIR",
]);

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of LAUNCHER_ENV_KEYS) delete env[key];
  return env;
}

const PASSWORD = process.env.DASHBOARD_PASSWORD || "";
const AUTH_ENABLED = PASSWORD.length > 0;
const SESSION_COOKIE = "launcher_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;   // 12 h
const MAX_ATTEMPTS = 8;                        // avant blocage temporaire
const LOCKOUT_MS = envNumber(process.env.LOCKOUT_MS, 5 * 60 * 1000);

/** @type {Map<string, number>} token de session -> date d'expiration */
const sessions = new Map<string, number>();
/** @type {Map<string, { count: number, lockedUntil: number }>} ip -> tentatives ratées */
const attempts = new Map<string, { count: number; lockedUntil: number; seenAt: number }>();

// Chemins accessibles sans être authentifié (page de login et son habillage).
const OPEN_PATHS = new Set(["/login", "/style.css", "/favicon.ico"]);

const app = express();
app.disable('x-powered-by');
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

/* --------------------------------------------------------------- auth --- */

// Comparaison à temps constant : on hashe d'abord pour travailler sur deux
// buffers de même longueur, timingSafeEqual refusant des tailles différentes.
function passwordMatches(candidate: string): boolean {
  const a = crypto.createHash("sha256").update(String(candidate)).digest();
  const b = crypto.createHash("sha256").update(PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function currentToken(req: Request): string | null {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const expiresAt = sessions.get(token);
  if (!expiresAt) return null;
  if (expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return token;
}

function openSession(res: Response): void {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_TTL_MS,
  });
}

app.get("/login", (req: Request, res: Response) => {
  if (!AUTH_ENABLED || currentToken(req)) return res.redirect("/");
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.post("/login", (req: Request, res: Response) => {
  if (!AUTH_ENABLED) return res.redirect("/");

  const ip = req.ip || "unknown";
  const record = attempts.get(ip);
  if (record && record.lockedUntil > Date.now()) {
    logger.warn("Tentative de connexion pendant le blocage", { ip });
    return res.redirect("/login?error=locked");
  }

  if (!passwordMatches(req.body.password || "")) {
    // Un blocage expiré remet le compteur à zéro : sans ça `count` reste à
    // MAX_ATTEMPTS et la première erreur suivante re-bloque aussitôt, à vie.
    const expired = Boolean(record?.lockedUntil);
    const count = (record && !expired ? record.count : 0) + 1;
    const locked = count >= MAX_ATTEMPTS;
    attempts.set(ip, { count, lockedUntil: locked ? Date.now() + LOCKOUT_MS : 0, seenAt: Date.now() });
    logger.warn(locked ? "Trop de tentatives, IP bloquée" : "Mot de passe invalide", { ip, count });
    return res.redirect("/login?error=invalid");
  }

  attempts.delete(ip);
  openSession(res);
  res.redirect("/");
});

app.post("/logout", (req: Request, res: Response) => {
  const token = currentToken(req);
  if (token) sessions.delete(token);
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.redirect("/login");
});

app.get("/api/session", (_req: Request, res: Response) => {
  res.json({ authEnabled: AUTH_ENABLED });
});

// Barrière : tout le reste (pages, assets, API) exige une session valide.
app.use((req: Request, res: Response, next: NextFunction) => {
  if (!AUTH_ENABLED || OPEN_PATHS.has(req.path) || currentToken(req)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Not authenticated" });
  res.redirect("/login");
});

app.use(express.static(path.join(__dirname, "public")));

const running = new Map<string, RunningEntry>();
/** @type {Map<string, string[]>} sortie conservée après l'arrêt, pour pouvoir lire un crash */
const logsById = new Map<string, string[]>();
/** @type {Map<string, number>} compteur monotone par projet, pour que le client détecte un trou */
const logSeq = new Map<string, number>();
/** @type {Map<string, number>} port lu dans la sortie du projet, plus fiable que son .env */
const detectedPorts = new Map<string, number>();

// Le registre des process n'est pas un journal : il a son propre réglage, qui
// retombe sur le dossier des journaux pour rester compatible avec l'existant.
const STATE_DIR = process.env.STATE_DIR || logger.logDir;
fs.mkdirSync(STATE_DIR, { recursive: true });
const STATE_PATH = path.join(STATE_DIR, "running.json");

// Vite, Next, Hono… annoncent tous leur adresse au démarrage. La lire évite de
// dépendre d'un PORT dans le .env du projet, que la plupart n'ont pas.
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})/;
// L'échappement ANSI est exactement ce qu'on cherche ici : sans ce nettoyage, les
// URL colorées d'un Vite passent à travers URL_RE et le port n'est pas détecté.
// biome-ignore lint/suspicious/noControlCharactersInRegex: caractère de contrôle voulu
const ANSI_RE = /\u001B\[[0-9;]*[a-zA-Z]/g;
const MAX_LOG_LINES = 200;
// MAX_LOG_LINES compte des chunks, pas des octets : sans plafond, un projet qui
// écrit 10 Mo d'un coup les garde en mémoire et les pousse à tous les clients.
const MAX_CHUNK_CHARS = 8 * 1024;

const STATE_INTERVAL_MS = 2000;   // rythme du scan tant qu'un client est connecté
const READY_TIMEOUT_MS = 30000;   // au-delà, on cesse de sonder le port au démarrage
const STOP_TIMEOUT_MS = envNumber(process.env.STOP_TIMEOUT_MS, 5000); // avant SIGKILL
const KILL_GRACE_MS = 1000;       // après SIGKILL, avant de renoncer
const PORT_RELEASE_TIMEOUT_MS = envNumber(process.env.PORT_RELEASE_TIMEOUT_MS, 3000);

const WINDOWS = process.platform === "win32";

const PREFERRED_SCRIPTS = ["dev", "start", "serve"];
const IGNORED_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", ".turbo", ".cache"]);

// `config.json` ne sert plus qu'à ça : `rootDir` et `scanDepth` viennent de .env
// (ROOT_DIR, SCAN_DEPTH). La fonction s'appelait loadConfig() et retournait ces
// deux champs, que personne ne lisait — le nom faisait chercher au mauvais endroit.
function loadOverrides(): Record<string, Override> {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  return config.overrides || {};
}

function makeId(rootDir: string, projectDir: string): string {
  const rel = path.relative(rootDir, projectDir);
  return (rel === "" ? path.basename(projectDir) : rel).split(path.sep).join("__");
}

function detectDefaultScript(scripts: Record<string, string>): string | null {
  return PREFERRED_SCRIPTS.find((name) => scripts[name]) || null;
}

function detectPort(dir: string): number | null {
  const envPath = path.join(dir, ".env");
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, "utf-8");
      const m = content.match(/^(?:[ \t]*)PORT[ \t]*=[ \t]*(\d+)/m);
      if (m?.[1]) return Number.parseInt(m[1], 10);
    } catch {
      // fichier illisible, on ignore
    }
  }
  return null;
}

function discoverProjects(rootDir: string, maxDepth: number): Project[] {
  const results: Project[] = [];

  function scanDir(dir: string, depth: number): void {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        const scripts = pkg.scripts || {};
        const port = detectPort(dir);
        results.push({
          id: makeId(rootDir, dir),
          name: pkg.name || path.basename(dir),
          cwd: dir,
          scripts: Object.keys(scripts),
          defaultScript: detectDefaultScript(scripts),
          port,
          url: port ? `http://localhost:${port}` : null,
        });
      } catch {
        // package.json invalide, on ignore ce dossier
      }
      return; // ne pas descendre dans un projet déjà détecté
    }
    if (depth >= maxDepth) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
      scanDir(path.join(dir, entry.name), depth + 1);
    }
  }

  scanDir(rootDir, 0);
  return results;
}

function applyOverrides(project: Project, overrides: Record<string, Override>): Project {
  const o = overrides[project.id];
  if (!o) return project;
  const merged = { ...project, ...o };
  if (o.port && !o.url) merged.url = `http://localhost:${o.port}`;
  // Une url sans port fige la détection tout en laissant le port inconnu : le
  // statut ne peut alors plus passer par le port. On le relit dans l'url.
  if (o.url && !o.port) {
    try {
      merged.port = Number(new URL(o.url).port) || null;
    } catch {
      merged.port = null; // url inexploitable, on n'en tire rien
    }
  }
  // Un port posé à la main dans config.json l'emporte sur ce qu'on détecterait.
  if (o.port || o.url) merged.pinnedPort = true;
  return merged;
}

function detectPortFromOutput(id: string, text: string): void {
  if (detectedPorts.has(id)) return; // on garde la première adresse annoncée
  const match = text.replace(ANSI_RE, "").match(URL_RE);
  if (!match) return;
  if (!match[1]) return;
  detectedPorts.set(id, Number.parseInt(match[1], 10));
  persistRunning(); // le registre doit connaître le port : il sert de garde-fou à la reprise
  pushState();
}

function pushLog(id: string, chunk: string): void {
  const line =
    chunk.length > MAX_CHUNK_CHARS
      ? `${chunk.slice(0, MAX_CHUNK_CHARS)}\n--- ${chunk.length - MAX_CHUNK_CHARS} caractères tronqués ---\n`
      : chunk;
  let lines = logsById.get(id);
  if (!lines) {
    lines = [];
    logsById.set(id, lines);
  }
  lines.push(line);
  if (lines.length > MAX_LOG_LINES) lines.shift();

  const seq = (logSeq.get(id) || 0) + 1;
  logSeq.set(id, seq);
  broadcast("log", { id, seq, chunk: line });
}

function probePort(port: number, host: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(400);
    socket
      .once("connect", () => {
        socket.destroy();
        resolve(true);
      })
      .once("timeout", () => {
        socket.destroy();
        resolve(false);
      })
      .once("error", () => resolve(false))
      .connect(port, host);
  });
}

// Les deux familles en parallèle, pas l'une après l'autre : un projet qui
// n'écoute que sur ::1 restait « starting » à vie, et sonder en série doublerait
// la latence de chaque tour de boucle pour tous les ports fermés.
async function checkPort(port: number): Promise<boolean> {
  const [v4, v6] = await Promise.all([probePort(port, "127.0.0.1"), probePort(port, "::1")]);
  return v4 || v6;
}

/* -------------------------------------------------------- état partagé --- */

// Un seul calcul d'état pour tous les clients, poussé via SSE : les navigateurs
// n'interrogent plus le serveur en boucle.

// Le scan est synchrone (readdirSync, readFileSync) et bloque donc la boucle
// d'évènements pendant que le SSE diffuse. Il tournait à chaque tour de boucle
// *et* à chaque route — trois scans complets pour un seul restart. Le cache est
// délibérément court : plus bref que STATE_INTERVAL_MS, pour qu'un tour de boucle
// voie toujours le disque tel qu'il est.
const SCAN_TTL_MS = 1500;
let scanCache: { at: number; projects: Project[] } | null = null;

function listProjects(fresh = false): Project[] {
  if (!fresh && scanCache && Date.now() - scanCache.at < SCAN_TTL_MS) return scanCache.projects;
  if (!fs.existsSync(ROOT_DIR)) {
    throw new Error(`Directory not found: ${ROOT_DIR}. Fix "ROOT_DIR" in .env.`);
  }
  const overrides = loadOverrides();
  const projects = discoverProjects(ROOT_DIR, SCAN_DEPTH).map((p) => applyOverrides(p, overrides));
  scanCache = { at: Date.now(), projects };
  return projects;
}

function invalidateScan(): void {
  scanCache = null;
}

function resolveProject(id: string): Project | null {
  const known = listProjects().find((p) => p.id === id);
  if (known) return known;
  // Un projet qui vient d'apparaître sur le disque ne doit pas rester
  // introuvable le temps que le cache expire : on ne rescanne que sur échec.
  return listProjects(true).find((p) => p.id === id) || null;
}

// « starting » = lancé par le dashboard, mais rien ne répond encore sur son port.
// C'est ce qui permet de n'activer « Open » qu'une fois le service joignable.
async function computeState(): Promise<ProjectState[]> {
  const discovered = listProjects();
  return Promise.all(
    discovered.map(async (p): Promise<ProjectState> => {
      const entry = running.get(p.id);
      const detected = p.pinnedPort ? null : detectedPorts.get(p.id);
      const port = detected || p.port || null;
      const url = detected ? `http://localhost:${detected}` : p.url || null;

      const portOpen = port ? await checkPort(port) : null;
      let status: Status;
      if (entry) {
        status = !port || portOpen ? "running" : "starting";
      } else {
        status = portOpen ? "external" : "stopped";
      }
      // Composé champ par champ, pas étalé : TypeScript dispense un spread du
      // contrôle de propriétés excédentaires, donc `...p` laissait passer les
      // champs internes de `Project` (aujourd'hui `pinnedPort`) jusqu'au
      // navigateur — et laisserait passer tout champ ajouté un jour à `Override`.
      return {
        id: p.id,
        name: p.name,
        cwd: p.cwd,
        scripts: p.scripts,
        defaultScript: p.defaultScript,
        port,
        url,
        status,
        pid: entry ? entry.pid : null,
        startedAt: entry ? entry.startedAt : null,
        adopted: entry ? Boolean(entry.adopted) : false,
        ...(p.command === undefined ? {} : { command: p.command }),
        ...(p.args === undefined ? {} : { args: p.args }),
      };
    })
  );
}

/* ----------------------------------------------------------------- SSE --- */

/** @type {Set<import('express').Response>} */
const sseClients = new Set<Response>();
// Comparaison par client, et non sur un unique dernier état diffusé : ce dernier
// était écrit à la fois par la boucle et par chaque nouvelle connexion, si bien
// qu'une connexion pouvait faire passer un état pour déjà diffusé et en priver
// les autres clients. Un compteur global ne sait pas qui a reçu quoi.
const lastSentByClient = new Map<Response, string>();
let stateTimer: NodeJS.Timeout | null = null;
let lastFailure = "";

function send(res: Response, event: string, data: unknown): void {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (e) {
    // Socket morte dont le « close » n'est pas encore passé : écrire dessus
    // lèverait, et ce rejet remonterait dans un pushState() appelé sans await.
    sseClients.delete(res);
    lastSentByClient.delete(res);
    logger.warn(`Client SSE injoignable : ${asError(e).message}`);
  }
}

function broadcast(event: string, data: unknown): void {
  for (const res of sseClients) send(res, event, data);
}

// Un tour peut durer plus longtemps que STATE_INTERVAL_MS (sondages de port) :
// sans ce verrou, deux calculs s'entrelacent et l'un écrase la comparaison de
// l'autre — un client peut alors ne jamais recevoir un état pourtant nouveau.
let pushing = false;
let pushPending = false;

async function pushState(): Promise<void> {
  if (sseClients.size === 0) return;
  if (pushing) {
    pushPending = true;
    return;
  }
  pushing = true;
  try {
    let state: ProjectState[];
    try {
      state = await computeState();
    } catch (e) {
      // La boucle tourne toutes les 2 s : on ne journalise qu'au changement
      // d'erreur, sinon une mauvaise config remplirait error.log.
      const error = asError(e);
      if (error.message !== lastFailure) {
        lastFailure = error.message;
        logger.error("Calcul de l'état impossible", error);
      }
      broadcast("failure", { error: error.message });
      return;
    }
    lastFailure = "";
    pruneVanished(new Set(state.map((p) => p.id)));
    const json = JSON.stringify(state);
    for (const res of sseClients) {
      if (lastSentByClient.get(res) === json) continue; // rien de neuf pour lui
      send(res, "projects", state);
      lastSentByClient.set(res, json);
    }
  } finally {
    pushing = false;
    if (pushPending) {
      pushPending = false;
      void pushState();
    }
  }
}

// Les tampons de sortie survivent volontairement à la mort d'un process, mais
// pas à la disparition de son dossier : plus personne ne peut les consulter.
function pruneMap<V>(map: Map<string, V>, known: Set<string>): void {
  for (const id of map.keys()) if (!known.has(id) && !running.has(id)) map.delete(id);
}

function pruneVanished(known: Set<string>): void {
  pruneMap(logsById, known);
  pruneMap(logSeq, known);
  pruneMap(detectedPorts, known);
}

function startStateLoop() {
  if (!stateTimer) stateTimer = setInterval(pushState, STATE_INTERVAL_MS);
}

// Personne ne regarde : on arrête de scanner le disque.
function stopStateLoop(): void {
  if (stateTimer) clearInterval(stateTimer);
  stateTimer = null;
}

// Ni les sessions ni les tentatives n'expiraient d'elles-mêmes : seules celles
// qu'on relisait disparaissaient. unref() pour ne pas retenir le process.
const JANITOR_INTERVAL_MS = 10 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [token, expiresAt] of sessions) if (expiresAt < now) sessions.delete(token);
  for (const [ip, record] of attempts) {
    if (record.lockedUntil <= now && now - record.seenAt > LOCKOUT_MS) attempts.delete(ip);
  }
}, JANITOR_INTERVAL_MS).unref();

app.get("/api/events", asyncRoute(async (req: Request, res: Response) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("retry: 2000\n\n");
  sseClients.add(res);
  startStateLoop();

  try {
    // Envoi au seul nouveau client, et mémorisé pour lui seul : les autres
    // gardent leur propre point de comparaison.
    const state = await computeState();
    send(res, "projects", state);
    lastSentByClient.set(res, JSON.stringify(state));
  } catch (e) {
    send(res, "failure", { error: asError(e).message });
  }

  // Une connexion sans trafic peut être coupée en chemin.
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
    lastSentByClient.delete(res);
    if (sseClients.size === 0) stopStateLoop();
  });
}));

/* ------------------------------------------------ persistance / reprise --- */

// Les enfants sont lancés en detached : ils survivent à l'arrêt du launcher.
// Sans registre on les retrouve en « external », donc impossibles à arrêter
// depuis l'interface. On note donc qui tourne, pour se réattacher au démarrage.
function persistRunning(): void {
  const snapshot: Record<string, PersistedEntry> = {};
  for (const [id, entry] of running) {
    snapshot[id] = {
      pid: entry.pid,
      startedAt: entry.startedAt,
      script: entry.script,
      // Le port sert de garde-fou anti-réutilisation de PID à la reprise : celui
      // du .env du projet compte autant que celui lu dans sa sortie.
      port: detectedPorts.get(id) ?? entry.port ?? null,
    };
  }
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(snapshot, null, 2));
  } catch (e) {
    logger.warn(`Registre des process non écrit : ${asError(e).message}`);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // ne tue rien, teste juste l'existence
    return true;
  } catch {
    return false;
  }
}

async function recoverOrphans() {
  let snapshot: Record<string, PersistedEntry>;
  try {
    snapshot = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
  } catch {
    return; // pas de registre, ou illisible : rien à reprendre
  }

  for (const [id, entry] of Object.entries(snapshot) as [string, PersistedEntry][]) {
    if (!entry.pid || !isAlive(entry.pid)) continue;
    // Un PID peut avoir été réattribué depuis. Si on connaissait son port,
    // on exige qu'il réponde toujours avant de revendiquer le process.
    if (entry.port && !(await checkPort(entry.port))) continue;

    running.set(id, {
      pid: entry.pid,
      startedAt: entry.startedAt,
      script: entry.script,
      proc: null, // les pipes de la session précédente sont perdus
      adopted: true,
      port: entry.port || null,
    });
    if (entry.port) detectedPorts.set(id, entry.port);
    pushLog(id, `--- réattaché au process ${entry.pid} après redémarrage du launcher ---\n`);
    pushLog(id, "--- les logs de la session précédente sont perdus ---\n");
    logger.info(`Process réattaché : ${id} (pid ${entry.pid})`);
  }
  persistRunning();
}

/* -------------------------------------------------- cycle de vie projet --- */

// Attente active courte après un lancement, pour basculer « starting » ->
// « running » dès que le port répond plutôt qu'au prochain tour de boucle.
// Un jeton par projet : trois start/stop rapides laissaient trois boucles de
// 30 s sonder le même port en même temps, sans moyen de les arrêter.
const readyWatch = new Map<string, number>();
let readyToken = 0;

async function watchUntilReady(project: Project): Promise<void> {
  const token = ++readyToken;
  readyWatch.set(project.id, token);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (readyWatch.get(project.id) === token && running.has(project.id) && Date.now() < deadline) {
    const port = detectedPorts.get(project.id) || project.port;
    if (port && (await checkPort(port))) break;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  if (readyWatch.get(project.id) !== token) return; // une veille plus récente a pris la main
  readyWatch.delete(project.id);
  await pushState();
}

// Identification best-effort de ce qui occupe un port, pour un message utile.
function portHolder(port: number): { pid: number; command: string } | null {
  try {
    const out = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pid = out.trim().split("\n")[0];
    if (!pid) return null;
    const command = execFileSync("ps", ["-p", pid, "-o", "comm="], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return { pid: Number(pid), command: command.split("/").pop() || command };
  } catch {
    return null; // lsof absent (Windows) ou port libéré entre-temps
  }
}

async function spawnProject(project: Project, script?: string): Promise<ChildProcess> {
  let command: string;
  let args: string[];
  let chosen: string | null = null;

  // Une override peut fournir une commande custom (ex. non-npm).
  if (project.command) {
    command = project.command;
    args = project.args ?? [];
  } else {
    chosen = script || project.defaultScript;
    if (!chosen) {
      logger.warn("Aucun script npm exploitable", { id: project.id });
      throw Object.assign(
        new Error("No npm script detected (dev/start/serve). Add an override in config.json."),
        { status: 400 }
      );
    }
    // `chosen` vient du corps de la requête. Sans cette liste blanche il partait
    // tel quel dans la ligne de commande : « dev; rm -rf ~ » était exécuté.
    if (!project.scripts.includes(chosen)) {
      logger.warn("Script inconnu demandé", { id: project.id, script: chosen });
      throw Object.assign(
        new Error(
          `Unknown script "${chosen}". Available: ${project.scripts.join(", ") || "none"}.`
        ),
        { status: 400 }
      );
    }
    command = WINDOWS ? "npm.cmd" : "npm";
    args = ["run", chosen];
  }

  if (!fs.existsSync(project.cwd)) {
    logger.error("Dossier du projet introuvable", { id: project.id, cwd: project.cwd });
    throw Object.assign(new Error(`Directory not found: ${project.cwd}`), { status: 400 });
  }

  // Le port est-il déjà pris ? Autant le dire tout de suite plutôt que de
  // laisser le projet mourir sur EADDRINUSE deux secondes plus tard.
  const expectedPort = project.port || detectedPorts.get(project.id);
  if (expectedPort && (await checkPort(expectedPort))) {
    const holder = portHolder(expectedPort);
    logger.warn(`Port ${expectedPort} déjà occupé`, {
      id: project.id,
      ...(holder ? { par: holder.command, pid: holder.pid } : {}),
    });
    const by = holder ? ` by ${holder.command} (PID ${holder.pid})` : "";
    throw Object.assign(
      new Error(`Port ${expectedPort} is already in use${by}. Free it before starting.`),
      { status: 409 }
    );
  }

  // Pas de shell : commande et arguments restent deux choses distinctes, donc
  // rien de ce qu'ils contiennent ne peut être relu comme de la syntaxe shell.
  // Windows fait exception : depuis la CVE-2024-27980, Node refuse de lancer un
  // .cmd sans shell — la liste blanche ci-dessus reste alors la vraie barrière.
  const child = spawn(command, args, {
    cwd: project.cwd,
    shell: WINDOWS,
    env: childEnv(),
    detached: !WINDOWS,
  });

  // Attaché avant toute autre chose : un spawn raté émet « error » sur l'enfant,
  // et un « error » sans auditeur devient une exception non rattrapée — qui tue
  // le launcher, donc la supervision de tous les autres projets.
  child.on("error", (err) => {
    pushLog(project.id, `Erreur : ${err.message}\n`);
    logger.error(`Lancement impossible pour ${project.id}`, err);
    running.delete(project.id);
    persistRunning();
    pushState();
  });

  if (child.pid === undefined) {
    throw Object.assign(new Error(`Could not spawn ${command}`), { status: 500 });
  }

  running.set(project.id, {
    pid: child.pid,
    startedAt: Date.now(),
    script: chosen,
    proc: child,
    adopted: false,
    port: project.port || null,
  });
  logsById.set(project.id, []);   // on repart d'une sortie vierge à chaque lancement
  detectedPorts.delete(project.id); // et d'une détection de port vierge
  persistRunning();
  pushLog(project.id, `$ ${command} ${args.join(" ")}\n`);

  const onOutput = (d: Buffer) => {
    const text = d.toString();
    detectPortFromOutput(project.id, text);
    pushLog(project.id, text);
  };
  child.stdout?.on("data", onOutput);
  child.stderr?.on("data", onOutput);

  // code vaut null quand le process est tué par un signal (cas d'un stop).
  child.on("exit", (code, signal) => {
    const cause = code === null ? `signal ${signal}` : `code ${code}`;
    pushLog(project.id, `--- processus terminé (${cause}) ---\n`);
    if (code) {
      const tail = (logsById.get(project.id) || []).slice(-15).join("").trim();
      const excerpt = tail ? `\n${tail}` : "";
      logger.error(
        `Projet « ${project.id} » terminé en erreur (code ${code})${excerpt}`,
        { command: `${command} ${args.join(" ")}`, cwd: project.cwd }
      );
    }
    running.delete(project.id);
    persistRunning();
    pushState();
  });

  watchUntilReady(project);
  return child;
}

// La socket n'appartient pas toujours au process qu'on attend : `npm run dev`
// sort avant son propre enfant, qui tient encore le port quelques millisecondes.
// Sans cette attente, un redémarrage se voit refuser son propre port.
async function waitPortRelease(port: number): Promise<boolean> {
  const deadline = Date.now() + PORT_RELEASE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await checkPort(port))) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

// Résout quand le process a réellement rendu la main, pour pouvoir enchaîner
// sur un redémarrage sans relancer par-dessus l'ancien.
function killAndWaitExit(id: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const entry = running.get(id);
    if (!entry) return resolve(false);

    let settled = false;
    let poll: NodeJS.Timeout | null = null;
    let escalate: NodeJS.Timeout | null = null;
    let giveUp: NodeJS.Timeout | null = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (poll) clearInterval(poll);
      if (escalate) clearTimeout(escalate);
      if (giveUp) clearTimeout(giveUp);
      running.delete(id);
      persistRunning();
      resolve(true);
    };

    // Le process est déjà sorti : `once("exit")` posé maintenant n'entendrait
    // plus rien et on attendrait STOP_TIMEOUT_MS pour un arrêt déjà acquis.
    if (entry.proc && (entry.proc.exitCode !== null || entry.proc.signalCode !== null)) {
      return finish();
    }

    const signal = (sig: NodeJS.Signals): void => {
      try {
        process.kill(-entry.pid, sig); // le groupe : npm et ce qu'il a lancé
      } catch {
        try {
          process.kill(entry.pid, sig);
        } catch {
          finish(); // plus personne à qui parler
        }
      }
    };

    if (entry.proc) entry.proc.once("exit", finish);
    // Le sondage du PID couvre les process réadoptés (pas de pipes, donc pas
    // d'évènement « exit ») et sert de confirmation après un SIGKILL.
    poll = setInterval(() => {
      if (!isAlive(entry.pid)) finish();
    }, 200);

    signal("SIGTERM");

    // Déclarer l'arrêt acquis sans vérifier laisserait un process vivant hors de
    // `running` et hors du registre : plus rien ne le suit, plus rien ne peut
    // l'arrêter, et le port qu'il tient fera échouer le prochain démarrage.
    escalate = setTimeout(() => {
      logger.warn("Toujours vivant après SIGTERM, escalade en SIGKILL", { id, pid: entry.pid });
      signal("SIGKILL");
      giveUp = setTimeout(() => {
        logger.error("Process survivant à SIGKILL", { id, pid: entry.pid });
        finish();
      }, KILL_GRACE_MS);
    }, STOP_TIMEOUT_MS);
  });
}

// Quand cette fonction rend la main, le port du projet est réellement libre.
async function stopProject(id: string): Promise<boolean> {
  const entry = running.get(id);
  if (!entry) return false;
  const port = detectedPorts.get(id) || entry.port || null;
  const pid = entry.pid; // relevé avant : killAndWaitExit vide l'entrée

  await killAndWaitExit(id);
  if (!port || (await waitPortRelease(port))) return true;

  // `npm` sort volontiers en laissant vivre ce qu'il a lancé : c'est ce
  // petit-fils qui tient la socket. Rendre la main ici sur un port occupé ferait
  // refuser le démarrage suivant en 409, à cause de notre propre reliquat.
  logger.warn(`Port ${port} toujours occupé après SIGTERM, escalade en SIGKILL`, { id, pid });
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // le groupe a disparu entre-temps : quelqu'un d'autre tient ce port
  }
  if (!(await waitPortRelease(port))) {
    logger.error(`Port ${port} toujours occupé après SIGKILL`, { id, pid });
  }
  return true;
}

/* -------------------------------------------------------------- routes --- */

app.get("/api/projects", asyncRoute(async (_req: Request, res: Response) => {
  try {
    res.json(await computeState());
  } catch (e) {
    const error = asError(e);
    logger.error("Calcul de l'état impossible", error);
    res.status(500).json({ error: error.message });
  }
}));

app.get("/api/projects/:id/logs", (req: Request, res: Response) => {
  res.json({
    logs: logsById.get(paramId(req)) || [],
    seq: logSeq.get(paramId(req)) || 0,
  });
});

// Le bouton « Refresh » : force un envoi même si l'état n'a pas bougé.
app.post("/api/refresh", asyncRoute(async (_req: Request, res: Response) => {
  invalidateScan();
  lastSentByClient.clear(); // « Refresh » renvoie l'état même s'il n'a pas bougé
  await pushState();
  res.json({ ok: true });
}));

app.post("/api/projects/:id/start", asyncRoute(async (req: Request, res: Response) => {
  try {
    if (running.has(paramId(req))) return res.status(409).json({ error: "Already running" });
    const project = resolveProject(paramId(req));
    if (!project) {
      logger.warn("Démarrage demandé pour un projet inconnu", { id: paramId(req) });
      return res.status(404).json({ error: "Project not found (please rescan)" });
    }
    const child = await spawnProject(project, req.body.script);
    await pushState();
    res.json({ ok: true, pid: child.pid });
  } catch (e) {
    const error = asError(e);
    if (!error.status) logger.error("Démarrage impossible", error);
    res.status(error.status || 500).json({ error: error.message });
  }
}));

app.post("/api/projects/:id/restart", asyncRoute(async (req: Request, res: Response) => {
  try {
    const project = resolveProject(paramId(req));
    if (!project) {
      logger.warn("Redémarrage demandé pour un projet inconnu", { id: paramId(req) });
      return res.status(404).json({ error: "Project not found (please rescan)" });
    }
    // On relit le script en cours avant d'arrêter, pour repartir à l'identique.
    const entry = running.get(project.id);
    const script = req.body.script || entry?.script || undefined;

    await stopProject(project.id);
    const child = await spawnProject(project, script);
    await pushState();
    res.json({ ok: true, pid: child.pid });
  } catch (e) {
    const error = asError(e);
    if (!error.status) logger.error("Redémarrage impossible", error);
    res.status(error.status || 500).json({ error: error.message });
  }
}));

app.post("/api/projects/:id/stop", asyncRoute(async (req: Request, res: Response) => {
  const stopped = await stopProject(paramId(req));
  if (stopped) {
    await pushState();
    return res.json({ ok: true });
  }

  // Le projet n'est pas dans `running` : soit il ne tourne pas, soit il tourne
  // sans qu'on l'ait lancé (« external »). Ce second cas arrive dès qu'un
  // process a été démarré depuis un terminal, ou par un launcher antérieur au
  // registre. Sur demande explicite, on tue ce qui occupe le port.
  if (req.body.force) {
    let project: Project | null;
    try {
      project = resolveProject(paramId(req));
    } catch (e) {
      return res.status(500).json({ error: asError(e).message });
    }
    const port = project && (detectedPorts.get(project.id) || project.port);
    if (!port) return res.status(400).json({ error: "No known port for this project" });

    const holder = portHolder(port);
    if (!holder) return res.status(404).json({ error: `Nothing is listening on port ${port}` });

    // Le launcher est lui-même un projet scanné : sans ce garde-fou, un Stop
    // forcé sur sa propre ligne tuerait le dashboard.
    if (holder.pid === process.pid) {
      return res.status(400).json({ error: "That process is the dashboard itself" });
    }

    // On ne vise que le process qui écoute, pas son groupe : on n'a pas
    // démarré cet arbre, autant ne pas emporter ce qu'on ne connaît pas.
    try {
      process.kill(holder.pid, "SIGTERM");
    } catch (e) {
      const error = asError(e);
      logger.error(`Arrêt forcé impossible sur le port ${port}`, error);
      return res.status(500).json({ error: `Could not stop PID ${holder.pid}: ${error.message}` });
    }

    logger.warn(`Arrêt forcé du process occupant le port ${port}`, {
      id: paramId(req),
      pid: holder.pid,
      command: holder.command,
    });
    await pushState();
    return res.json({ ok: true, killed: holder });
  }

  logger.warn("Arrêt demandé pour un projet non lancé", { id: paramId(req) });
  res.status(404).json({ error: "Not running" });
}));

// Filet de sécurité : toute erreur qui remonte d'une route atterrit ici.
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  logger.error(`Erreur non gérée sur ${req.method} ${req.originalUrl}`, err);
  if (res.headersSent) return;
  res.status(500).json({ error: "Internal server error" });
});

recoverOrphans();

// Ouvrir hors boucle locale sans mot de passe offrirait l'exécution de commandes
// à qui atteint le port. On refuse de démarrer plutôt que de le laisser passer.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
if (!LOOPBACK_HOSTS.has(BIND_HOST) && !AUTH_ENABLED) {
  logger.error(
    `BIND_HOST=${BIND_HOST} expose un outil qui exécute des commandes : ` +
      "renseigne DASHBOARD_PASSWORD, ou reviens sur 127.0.0.1."
  );
  process.exit(1);
}

// `public/app.js` est produit par `npm run build` et n'est pas versionné. Sans
// lui la page se charge, ne fait rien, et ne laisse aucune trace côté serveur.
if (!fs.existsSync(path.join(__dirname, "public", "app.js"))) {
  logger.warn("public/app.js est absent : lance `npm run build`, sinon le tableau de bord restera vide.");
}

app.listen(PORT, BIND_HOST, () => {
  logger.info(`Dashboard available at http://localhost:${PORT}`);
  if (AUTH_ENABLED) {
    logger.info("Access is password protected (DASHBOARD_PASSWORD).");
  } else {
    logger.warn("DASHBOARD_PASSWORD is empty, the dashboard is open to anyone who can reach this port.");
  }
  logger.info(`Errors are written to ${logger.logPath}`);
});
