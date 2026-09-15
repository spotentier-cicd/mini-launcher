const express = require("express");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
require('dotenv').config();

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
  if (record && record.lockedUntil > Date.now()) return res.redirect("/login?error=locked");

  if (!passwordMatches(req.body.password || "")) {
    const count = (record ? record.count : 0) + 1;
    attempts.set(ip, {
      count,
      lockedUntil: count >= MAX_ATTEMPTS ? Date.now() + LOCKOUT_MS : 0,
    });
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

/** @type {Map<string, { proc: import('child_process').ChildProcess, logs: string[], startedAt: number }>} */
const running = new Map();
const MAX_LOG_LINES = 200;

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
  const entry = running.get(id);
  if (!entry) return;
  entry.logs.push(line);
  if (entry.logs.length > MAX_LOG_LINES) entry.logs.shift();
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

app.get("/api/projects", async (req, res) => {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  if (!fs.existsSync(ROOT_DIR)) {
    return res.status(400).json({ error: `Directory not found: ${ROOT_DIR}. Fix "ROOT_DIR" in .env.` });
  }

  const discovered = discoverProjects(ROOT_DIR, SCAN_DEPTH).map((p) =>
    applyOverrides(p, config.overrides)
  );

  const results = await Promise.all(
    discovered.map(async (p) => {
      const entry = running.get(p.id);
      const managedByUs = !!entry;
      const portOpen = p.port ? await checkPort(p.port) : null;
      const other = portOpen ? "external" : "stopped";
      return {
        ...p,
        status: managedByUs ? "running" : other,
        pid: entry ? entry.proc.pid : null,
        startedAt: entry ? entry.startedAt : null,
      };
    })
  );

  res.json(results);
});

app.get("/api/projects/:id/logs", (req, res) => {
  const entry = running.get(req.params.id);
  res.json({ logs: entry ? entry.logs : [] });
});

app.post("/api/projects/:id/start", (req, res) => {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  const discovered = discoverProjects(ROOT_DIR, SCAN_DEPTH).map((p) =>
    applyOverrides(p, config.overrides)
  );
  const project = discovered.find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found (please rescan)" });
  if (running.has(project.id)) return res.status(409).json({ error: "Already running" });

  // Une override peut fournir une commande custom (ex. non-npm). Sinon on lance le script choisi via npm.
  let command = project.command;
  let args = project.args;
  if (!command) {
    const script = req.body.script || project.defaultScript;
    if (!script) {
      return res.status(400).json({ error: "No npm script detected (dev/start/serve). Add an override in config.json." });
    }
    command = "npm";
    args = ["run", script];
  }

  if (!fs.existsSync(project.cwd)) {
    return res.status(400).json({ error: `Directory not found: ${project.cwd}` });
  }

  const child = spawn(command, args, {
    cwd: project.cwd,
    shell: true,
    env: { ...process.env },
    detached: process.platform !== "win32",
  });

  running.set(project.id, { proc: child, logs: [], startedAt: Date.now() });
  pushLog(project.id, `$ ${command} ${args.join(" ")}`);

  child.stdout.on("data", (d) => pushLog(project.id, d.toString()));
  child.stderr.on("data", (d) => pushLog(project.id, d.toString()));
  child.on("exit", (code) => {
    pushLog(project.id, `--- processus terminé (code ${code}) ---`);
    running.delete(project.id);
  });
  child.on("error", (err) => {
    pushLog(project.id, `Erreur : ${err.message}`);
    running.delete(project.id);
  });

  res.json({ ok: true, pid: child.pid });
});

app.post("/api/projects/:id/stop", (req, res) => {
  const entry = running.get(req.params.id);
  if (!entry) return res.status(404).json({ error: "Not running" });
  try {
    process.kill(-entry.proc.pid, "SIGTERM");
  } catch {
    entry.proc.kill("SIGTERM");
  }
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`\nDashboard available at http://localhost:${PORT}`);
  console.log(
    AUTH_ENABLED
      ? "Access is password protected (DASHBOARD_PASSWORD).\n"
      : "WARNING: DASHBOARD_PASSWORD is empty, the dashboard is open to anyone who can reach this port.\n"
  );
});
