const express = require("express");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
require('dotenv').config();
const logger = require("./logger");

const PORT = process.env.PORT || 7777;
const ROOT_DIR = process.env.ROOT_DIR || "../";
const SCAN_DEPTH = process.env.SCAN_DEPTH || 2;
const CONFIG_PATH = path.join(__dirname, "config.json");

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
const MAX_LOG_LINES = 200;

const STATE_INTERVAL_MS = 2000;   // rythme du scan tant qu'un client est connecté
const READY_TIMEOUT_MS = 30000;   // au-delà, on cesse de sonder le port au démarrage
const STOP_TIMEOUT_MS = 5000;     // au-delà, on considère l'arrêt acquis

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
  return merged;
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
      const portOpen = p.port ? await checkPort(p.port) : null;
      let status;
      if (entry) {
        status = !p.port || portOpen ? "running" : "starting";
      } else {
        status = portOpen ? "external" : "stopped";
      }
      return {
        ...p,
        status,
        pid: entry ? entry.proc.pid : null,
        startedAt: entry ? entry.startedAt : null,
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

/* -------------------------------------------------- cycle de vie projet --- */

// Attente active courte après un lancement, pour basculer « starting » ->
// « running » dès que le port répond plutôt qu'au prochain tour de boucle.
async function watchUntilReady(project) {
  if (!project.port) return;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (running.has(project.id) && Date.now() < deadline) {
    if (await checkPort(project.port)) return pushState();
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

function spawnProject(project, script) {
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

  const child = spawn(command, args, {
    cwd: project.cwd,
    shell: true,
    env: { ...process.env },
    detached: process.platform !== "win32",
  });

  running.set(project.id, { proc: child, startedAt: Date.now(), script: chosen });
  logsById.set(project.id, []); // on repart d'une sortie vierge à chaque lancement
  pushLog(project.id, `$ ${command} ${args.join(" ")}\n`);

  child.stdout.on("data", (d) => pushLog(project.id, d.toString()));
  child.stderr.on("data", (d) => pushLog(project.id, d.toString()));

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
    pushState();
  });

  child.on("error", (err) => {
    pushLog(project.id, `Erreur : ${err.message}\n`);
    logger.error(`Lancement impossible pour ${project.id}`, err);
    running.delete(project.id);
    pushState();
  });

  watchUntilReady(project);
  return child;
}

// Résout quand le process a réellement rendu la main, pour pouvoir enchaîner
// sur un redémarrage sans relancer par-dessus l'ancien.
function stopProject(id) {
  return new Promise((resolve) => {
    const entry = running.get(id);
    if (!entry) return resolve(false);

    let timer;
    entry.proc.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
    timer = setTimeout(() => {
      logger.warn("Le process n'a pas rendu la main dans le délai imparti", { id });
      resolve(true);
    }, STOP_TIMEOUT_MS);

    try {
      process.kill(-entry.proc.pid, "SIGTERM");
    } catch (e) {
      logger.warn(`Arrêt du groupe de process impossible, repli sur le process seul : ${e.message}`, { id });
      entry.proc.kill("SIGTERM");
    }
  });
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
    const child = spawnProject(project, req.body.script);
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
    const child = spawnProject(project, script);
    await pushState();
    res.json({ ok: true, pid: child.pid });
  } catch (e) {
    if (!e.status) logger.error("Redémarrage impossible", e);
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post("/api/projects/:id/stop", async (req, res) => {
  const stopped = await stopProject(req.params.id);
  if (!stopped) {
    logger.warn("Arrêt demandé pour un projet non lancé", { id: req.params.id });
    return res.status(404).json({ error: "Not running" });
  }
  await pushState();
  res.json({ ok: true });
});

// Filet de sécurité : toute erreur qui remonte d'une route atterrit ici.
app.use((err, req, res, _next) => {
  logger.error(`Erreur non gérée sur ${req.method} ${req.originalUrl}`, err);
  if (res.headersSent) return;
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  logger.info(`Dashboard available at http://localhost:${PORT}`);
  if (AUTH_ENABLED) {
    logger.info("Access is password protected (DASHBOARD_PASSWORD).");
  } else {
    logger.warn("DASHBOARD_PASSWORD is empty, the dashboard is open to anyone who can reach this port.");
  }
  logger.info(`Errors are written to ${logger.logPath}`);
});
