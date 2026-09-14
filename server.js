const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const net = require("net");

const PORT = process.env.LAUNCHER_PORT || 7777;
const CONFIG_PATH = path.join(__dirname, "config.json");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/** @type {Map<string, { proc: import('child_process').ChildProcess, logs: string[], startedAt: number }>} */
const running = new Map();
const MAX_LOG_LINES = 200;

const PREFERRED_SCRIPTS = ["dev", "start", "serve"];
const IGNORED_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", ".turbo", ".cache"]);

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  const config = JSON.parse(raw);
  if (!config.rootDir) throw new Error("Ajoute \"rootDir\" dans config.json (dossier parent contenant tes projets)");
  return {
    rootDir: config.rootDir,
    scanDepth: config.scanDepth ?? 2,
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
      const m = content.match(/^\s*PORT\s*=\s*(\d+)/m);
      if (m) return parseInt(m[1], 10);
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

  if (!fs.existsSync(config.rootDir)) {
    return res.status(400).json({ error: `Dossier introuvable : ${config.rootDir}. Corrige "rootDir" dans config.json.` });
  }

  const discovered = discoverProjects(config.rootDir, config.scanDepth).map((p) =>
    applyOverrides(p, config.overrides)
  );

  const results = await Promise.all(
    discovered.map(async (p) => {
      const entry = running.get(p.id);
      const managedByUs = !!entry;
      const portOpen = p.port ? await checkPort(p.port) : null;
      return {
        ...p,
        status: managedByUs ? "running" : portOpen ? "external" : "stopped",
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

  const discovered = discoverProjects(config.rootDir, config.scanDepth).map((p) =>
    applyOverrides(p, config.overrides)
  );
  const project = discovered.find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "Projet inconnu (relance un scan)" });
  if (running.has(project.id)) return res.status(409).json({ error: "Déjà lancé" });

  // Une override peut fournir une commande custom (ex. non-npm). Sinon on lance le script choisi via npm.
  let command = project.command;
  let args = project.args;
  if (!command) {
    const script = req.body.script || project.defaultScript;
    if (!script) {
      return res.status(400).json({ error: "Aucun script npm détecté (dev/start/serve). Ajoute une override dans config.json." });
    }
    command = "npm";
    args = ["run", script];
  }

  if (!fs.existsSync(project.cwd)) {
    return res.status(400).json({ error: `Dossier introuvable : ${project.cwd}` });
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
  if (!entry) return res.status(404).json({ error: "Pas en cours d'exécution" });
  try {
    process.kill(-entry.proc.pid, "SIGTERM");
  } catch {
    entry.proc.kill("SIGTERM");
  }
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`\nTableau de bord disponible sur http://localhost:${PORT}\n`);
});
