const express = require("express");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const launcherEnv = require('dotenv').config();
const logger = require("./logger");

const PORT = process.env.PORT || 7777;
const ROOT_DIR = process.env.ROOT_DIR || "../";
const SCAN_DEPTH = process.env.SCAN_DEPTH || 2;
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
  "LOG_DIR",
  "CONFIG_PATH",
]);

function childEnv() {
  const env = { ...process.env };
  for (const key of LAUNCHER_ENV_KEYS) delete env[key];
  return env;
}

const PASSWORD = process.env.DASHBOARD_PASSWORD || "";
const AUTH_ENABLED = PASSWORD.length > 0;
const SESSION_COOKIE = "launcher_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;   // 12 h
const MAX_ATTEMPTS = 8;                        // avant blocage temporaire
const LOCKOUT_MS = 5 * 60 * 1000;

/** @type {Map<string, number>} token de session -> date d'expiration */
const sessions = new Map();
/** @type {Map<string, { count: number, lockedUntil: number }>} ip -> tentatives ratées */
const attempts = new Map();

// Chemins accessibles sans être authentifié (page de login et son habillage).
const OPEN_PATHS = new Set(["/login", "/style.css", "/favicon.ico"]);

const app = express();
app.disable('x-powered-by');
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

/* --------------------------------------------------------------- auth --- */

// Comparaison à temps constant : on hashe d'abord pour travailler sur deux
// buffers de même longueur, timingSafeEqual refusant des tailles différentes.
function passwordMatches(candidate) {
  const a = crypto.createHash("sha256").update(String(candidate)).digest();
  const b = crypto.createHash("sha256").update(PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function currentToken(req) {
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

function openSession(res) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_TTL_MS,
  });
}

app.get("/login", (req, res) => {
  if (!AUTH_ENABLED || currentToken(req)) return res.redirect("/");
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.post("/login", (req, res) => {
  if (!AUTH_ENABLED) return res.redirect("/");

  const ip = req.ip || "unknown";
  const record = attempts.get(ip);
  if (record && record.lockedUntil > Date.now()) {
    logger.warn("Tentative de connexion pendant le blocage", { ip });
    return res.redirect("/login?error=locked");
  }

  if (!passwordMatches(req.body.password || "")) {
    const count = (record ? record.count : 0) + 1;
    const locked = count >= MAX_ATTEMPTS;
    attempts.set(ip, { count, lockedUntil: locked ? Date.now() + LOCKOUT_MS : 0 });
    logger.warn(locked ? "Trop de tentatives, IP bloquée" : "Mot de passe invalide", { ip, count });
    return res.redirect("/login?error=invalid");
  }

  attempts.delete(ip);
  openSession(res);
  res.redirect("/");
});

app.post("/logout", (req, res) => {
  const token = currentToken(req);
  if (token) sessions.delete(token);
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.redirect("/login");
});

app.get("/api/session", (req, res) => {
  res.json({ authEnabled: AUTH_ENABLED });
});

// Barrière : tout le reste (pages, assets, API) exige une session valide.
app.use((req, res, next) => {
  if (!AUTH_ENABLED || OPEN_PATHS.has(req.path) || currentToken(req)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Not authenticated" });
  res.redirect("/login");
});

app.use(express.static(path.join(__dirname, "public")));

/** @type {Map<string, { proc: import('child_process').ChildProcess, startedAt: number }>} */
const running = new Map();
/** @type {Map<string, string[]>} sortie conservée après l'arrêt, pour pouvoir lire un crash */
const logsById = new Map();
/** @type {Map<string, number>} compteur monotone par projet, pour que le client détecte un trou */
const logSeq = new Map();
/** @type {Map<string, number>} port lu dans la sortie du projet, plus fiable que son .env */
const detectedPorts = new Map();

const STATE_PATH = path.join(logger.logDir, "running.json");

// Vite, Next, Hono… annoncent tous leur adresse au démarrage. La lire évite de
// dépendre d'un PORT dans le .env du projet, que la plupart n'ont pas.
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})/;
const ANSI_RE = /\u001B\[[0-9;]*[a-zA-Z]/g;
const MAX_LOG_LINES = 200;

const STATE_INTERVAL_MS = 2000;   // rythme du scan tant qu'un client est connecté
const READY_TIMEOUT_MS = 30000;   // au-delà, on cesse de sonder le port au démarrage
const STOP_TIMEOUT_MS = 5000;     // au-delà, on considère l'arrêt acquis
const PORT_RELEASE_TIMEOUT_MS = 3000; // attente max de libération du port après un arrêt

const PREFERRED_SCRIPTS = ["dev", "start", "serve"];
const IGNORED_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", ".turbo", ".cache"]);

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  const config = JSON.parse(raw);
  if (!ROOT_DIR) throw new Error("Add \"rootDir\" to config.json (parent directory containing your projects)");
  return {
    rootDir: ROOT_DIR,
    scanDepth: SCAN_DEPTH,
    overrides: config.overrides || {},
  };
}

function makeId(rootDir, projectDir) {
  const rel = path.relative(rootDir, projectDir);
  return (rel === "" ? path.basename(projectDir) : rel).split(path.sep).join("__");
}

function detectDefaultScript(scripts) {
  return PREFERRED_SCRIPTS.find((name) => scripts[name]) || null;
}

function detectPort(dir) {
  const envPath = path.join(dir, ".env");
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, "utf-8");
      const m = content.match(/^(?:[ \t]*)PORT[ \t]*=[ \t]*(\d+)/m);
      if (m) return Number.parseInt(m[1], 10);
    } catch {
      // fichier illisible, on ignore
    }
  }
  return null;
}

function discoverProjects(rootDir, maxDepth) {
  const results = [];

  function scanDir(dir, depth) {
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
    let entries;
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

function applyOverrides(project, overrides) {
  const o = overrides[project.id];
  if (!o) return project;
  const merged = { ...project, ...o };
  if (o.port && !o.url) merged.url = `http://localhost:${o.port}`;
  // Un port posé à la main dans config.json l'emporte sur ce qu'on détecterait.
  if (o.port || o.url) merged.pinnedPort = true;
  return merged;
}

function detectPortFromOutput(id, text) {
  if (detectedPorts.has(id)) return; // on garde la première adresse annoncée
  const match = text.replace(ANSI_RE, "").match(URL_RE);
  if (!match) return;
  detectedPorts.set(id, Number(match[1]));
  persistRunning(); // le registre doit connaître le port : il sert de garde-fou à la reprise
  pushState();
}

function pushLog(id, line) {
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

function checkPort(port) {
  return new Promise((resolve) => {
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
      .connect(port, "127.0.0.1");
  });
}

/* -------------------------------------------------------- état partagé --- */

// Un seul calcul d'état pour tous les clients, poussé via SSE : les navigateurs
// n'interrogent plus le serveur en boucle.
function listProjects() {
  const config = loadConfig();
  if (!fs.existsSync(ROOT_DIR)) {
    throw new Error(`Directory not found: ${ROOT_DIR}. Fix "ROOT_DIR" in .env.`);
  }
  return discoverProjects(ROOT_DIR, SCAN_DEPTH).map((p) => applyOverrides(p, config.overrides));
}

function resolveProject(id) {
  return listProjects().find((p) => p.id === id) || null;
}

// « starting » = lancé par le dashboard, mais rien ne répond encore sur son port.
// C'est ce qui permet de n'activer « Open » qu'une fois le service joignable.
async function computeState() {
  const discovered = listProjects();
  return Promise.all(
    discovered.map(async (p) => {
      const entry = running.get(p.id);
      const detected = p.pinnedPort ? null : detectedPorts.get(p.id);
      const port = detected || p.port || null;
      const url = detected ? `http://localhost:${detected}` : p.url || null;

      const portOpen = port ? await checkPort(port) : null;
      let status;
      if (entry) {
        status = !port || portOpen ? "running" : "starting";
      } else {
        status = portOpen ? "external" : "stopped";
      }
      return {
        ...p,
        port,
        url,
        status,
        pid: entry ? entry.pid : null,
        startedAt: entry ? entry.startedAt : null,
        adopted: entry ? Boolean(entry.adopted) : false,
      };
    })
  );
}

/* ----------------------------------------------------------------- SSE --- */

/** @type {Set<import('express').Response>} */
const sseClients = new Set();
let stateTimer = null;
let lastStateJson = "";
let lastFailure = "";

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  for (const res of sseClients) send(res, event, data);
}

async function pushState() {
  if (sseClients.size === 0) return;
  let state;
  try {
    state = await computeState();
  } catch (e) {
    // La boucle tourne toutes les 2 s : on ne journalise qu'au changement
    // d'erreur, sinon une mauvaise config remplirait error.log.
    if (e.message !== lastFailure) {
      lastFailure = e.message;
      logger.error("Calcul de l'état impossible", e);
    }
    broadcast("failure", { error: e.message });
    return;
  }
  lastFailure = "";
  const json = JSON.stringify(state);
  if (json === lastStateJson) return; // rien de neuf : aucun octet envoyé
  lastStateJson = json;
  broadcast("projects", state);
}

function startStateLoop() {
  if (!stateTimer) stateTimer = setInterval(pushState, STATE_INTERVAL_MS);
}

// Personne ne regarde : on arrête de scanner le disque.
function stopStateLoop() {
  clearInterval(stateTimer);
  stateTimer = null;
  lastStateJson = "";
}

app.get("/api/events", async (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("retry: 2000\n\n");
  sseClients.add(res);
  startStateLoop();

  try {
    const state = await computeState();
    lastStateJson = JSON.stringify(state);
    send(res, "projects", state);
  } catch (e) {
    send(res, "failure", { error: e.message });
  }

  // Une connexion sans trafic peut être coupée en chemin.
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
    if (sseClients.size === 0) stopStateLoop();
  });
});

/* ------------------------------------------------ persistance / reprise --- */

// Les enfants sont lancés en detached : ils survivent à l'arrêt du launcher.
// Sans registre on les retrouve en « external », donc impossibles à arrêter
// depuis l'interface. On note donc qui tourne, pour se réattacher au démarrage.
function persistRunning() {
  const snapshot = {};
  for (const [id, entry] of running) {
    snapshot[id] = {
      pid: entry.pid,
      startedAt: entry.startedAt,
      script: entry.script,
      port: detectedPorts.get(id) || null,
    };
  }
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(snapshot, null, 2));
  } catch (e) {
    logger.warn(`Registre des process non écrit : ${e.message}`);
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0); // ne tue rien, teste juste l'existence
    return true;
  } catch {
    return false;
  }
}

async function recoverOrphans() {
  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
  } catch {
    return; // pas de registre, ou illisible : rien à reprendre
  }

  for (const [id, entry] of Object.entries(snapshot)) {
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
async function watchUntilReady(project) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (running.has(project.id) && Date.now() < deadline) {
    const port = detectedPorts.get(project.id) || project.port;
    if (port && (await checkPort(port))) return pushState();
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

// Identification best-effort de ce qui occupe un port, pour un message utile.
function portHolder(port) {
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
    return { pid: Number(pid), command: command.split("/").pop() };
  } catch {
    return null; // lsof absent (Windows) ou port libéré entre-temps
  }
}

async function spawnProject(project, script) {
  let command = project.command;
  let args = project.args;
  let chosen = null;

  // Une override peut fournir une commande custom (ex. non-npm).
  if (!command) {
    chosen = script || project.defaultScript;
    if (!chosen) {
      logger.warn("Aucun script npm exploitable", { id: project.id });
      throw Object.assign(
        new Error("No npm script detected (dev/start/serve). Add an override in config.json."),
        { status: 400 }
      );
    }
    command = "npm";
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

  const child = spawn(command, args, {
    cwd: project.cwd,
    shell: true,
    env: childEnv(),
    detached: process.platform !== "win32",
  });

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

  const onOutput = (d) => {
    const text = d.toString();
    detectPortFromOutput(project.id, text);
    pushLog(project.id, text);
  };
  child.stdout.on("data", onOutput);
  child.stderr.on("data", onOutput);

  // code vaut null quand le process est tué par un signal (cas d'un stop).
  child.on("exit", (code, signal) => {
    const cause = code === null ? `signal ${signal}` : `code ${code}`;
    pushLog(project.id, `--- processus terminé (${cause}) ---\n`);
    if (code) {
      const tail = (logsById.get(project.id) || []).slice(-15).join("").trim();
      logger.error(
        `Projet « ${project.id} » terminé en erreur (code ${code})${tail ? `\n${tail}` : ""}`,
        { command: `${command} ${args.join(" ")}`, cwd: project.cwd }
      );
    }
    running.delete(project.id);
    persistRunning();
    pushState();
  });

  child.on("error", (err) => {
    pushLog(project.id, `Erreur : ${err.message}\n`);
    logger.error(`Lancement impossible pour ${project.id}`, err);
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
async function waitPortRelease(port) {
  const deadline = Date.now() + PORT_RELEASE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await checkPort(port))) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

// Résout quand le process a réellement rendu la main, pour pouvoir enchaîner
// sur un redémarrage sans relancer par-dessus l'ancien.
function killAndWaitExit(id) {
  return new Promise((resolve) => {
    const entry = running.get(id);
    if (!entry) return resolve(false);

    const finish = () => {
      clearTimeout(timer);
      clearInterval(poll);
      running.delete(id);
      persistRunning();
      resolve(true);
    };

    let poll = null;
    const timer = setTimeout(() => {
      logger.warn("Le process n'a pas rendu la main dans le délai imparti", { id });
      finish();
    }, STOP_TIMEOUT_MS);

    if (entry.proc) {
      entry.proc.once("exit", finish);
    } else {
      // Process réattaché : pas d'évènement exit à écouter, on surveille le PID.
      poll = setInterval(() => {
        if (!isAlive(entry.pid)) finish();
      }, 200);
    }

    try {
      process.kill(-entry.pid, "SIGTERM");
    } catch (e) {
      logger.warn(`Arrêt du groupe de process impossible, repli sur le process seul : ${e.message}`, { id });
      try {
        process.kill(entry.pid, "SIGTERM");
      } catch {
        finish(); // déjà mort
      }
    }
  });
}

// Quand cette fonction rend la main, le port du projet est réellement libre.
async function stopProject(id) {
  const entry = running.get(id);
  if (!entry) return false;
  const port = detectedPorts.get(id) || entry.port || null;

  await killAndWaitExit(id);

  if (port && !(await waitPortRelease(port))) {
    logger.warn(`Port ${port} toujours occupé après l'arrêt`, { id });
  }
  return true;
}

/* -------------------------------------------------------------- routes --- */

app.get("/api/projects", async (req, res) => {
  try {
    res.json(await computeState());
  } catch (e) {
    logger.error("Calcul de l'état impossible", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/projects/:id/logs", (req, res) => {
  res.json({
    logs: logsById.get(req.params.id) || [],
    seq: logSeq.get(req.params.id) || 0,
  });
});

// Le bouton « Refresh » : force un envoi même si l'état n'a pas bougé.
app.post("/api/refresh", async (req, res) => {
  lastStateJson = "";
  await pushState();
  res.json({ ok: true });
});

app.post("/api/projects/:id/start", async (req, res) => {
  try {
    if (running.has(req.params.id)) return res.status(409).json({ error: "Already running" });
    const project = resolveProject(req.params.id);
    if (!project) {
      logger.warn("Démarrage demandé pour un projet inconnu", { id: req.params.id });
      return res.status(404).json({ error: "Project not found (please rescan)" });
    }
    const child = await spawnProject(project, req.body.script);
    await pushState();
    res.json({ ok: true, pid: child.pid });
  } catch (e) {
    if (!e.status) logger.error("Démarrage impossible", e);
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post("/api/projects/:id/restart", async (req, res) => {
  try {
    const project = resolveProject(req.params.id);
    if (!project) {
      logger.warn("Redémarrage demandé pour un projet inconnu", { id: req.params.id });
      return res.status(404).json({ error: "Project not found (please rescan)" });
    }
    // On relit le script en cours avant d'arrêter, pour repartir à l'identique.
    const entry = running.get(project.id);
    const script = req.body.script || (entry && entry.script) || undefined;

    await stopProject(project.id);
    const child = await spawnProject(project, script);
    await pushState();
    res.json({ ok: true, pid: child.pid });
  } catch (e) {
    if (!e.status) logger.error("Redémarrage impossible", e);
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post("/api/projects/:id/stop", async (req, res) => {
  const stopped = await stopProject(req.params.id);
  if (stopped) {
    await pushState();
    return res.json({ ok: true });
  }

  // Le projet n'est pas dans `running` : soit il ne tourne pas, soit il tourne
  // sans qu'on l'ait lancé (« external »). Ce second cas arrive dès qu'un
  // process a été démarré depuis un terminal, ou par un launcher antérieur au
  // registre. Sur demande explicite, on tue ce qui occupe le port.
  if (req.body.force) {
    let project;
    try {
      project = resolveProject(req.params.id);
    } catch (e) {
      return res.status(500).json({ error: e.message });
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
      logger.error(`Arrêt forcé impossible sur le port ${port}`, e);
      return res.status(500).json({ error: `Could not stop PID ${holder.pid}: ${e.message}` });
    }

    logger.warn(`Arrêt forcé du process occupant le port ${port}`, {
      id: req.params.id,
      pid: holder.pid,
      command: holder.command,
    });
    await pushState();
    return res.json({ ok: true, killed: holder });
  }

  logger.warn("Arrêt demandé pour un projet non lancé", { id: req.params.id });
  res.status(404).json({ error: "Not running" });
});

// Filet de sécurité : toute erreur qui remonte d'une route atterrit ici.
app.use((err, req, res, _next) => {
  logger.error(`Erreur non gérée sur ${req.method} ${req.originalUrl}`, err);
  if (res.headersSent) return;
  res.status(500).json({ error: "Internal server error" });
});

recoverOrphans();

app.listen(PORT, () => {
  logger.info(`Dashboard available at http://localhost:${PORT}`);
  if (AUTH_ENABLED) {
    logger.info("Access is password protected (DASHBOARD_PASSWORD).");
  } else {
    logger.warn("DASHBOARD_PASSWORD is empty, the dashboard is open to anyone who can reach this port.");
  }
  logger.info(`Errors are written to ${logger.logPath}`);
});
