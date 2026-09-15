import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SERVER = path.join(PROJECT_ROOT, "server.js");

/** Dossiers temporaires créés pendant un test, nettoyés par cleanupAll(). */
const tempDirs = new Set();
/** Launchers démarrés, pour être sûr de ne rien laisser tourner. */
const launchers = new Set();

export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

export function portOpen(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(400);
    socket
      .once("connect", () => (socket.destroy(), resolve(true)))
      .once("timeout", () => (socket.destroy(), resolve(false)))
      .once("error", () => resolve(false))
      .connect(port, "127.0.0.1");
  });
}

/** Attend qu'une condition devienne vraie, sans dormir bêtement. */
export async function waitFor(predicate, { timeout = 8000, interval = 50, label = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timeout en attendant : ${label}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

export function makeRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mini-launcher-test-"));
  tempDirs.add(dir);
  return dir;
}

/**
 * Crée un faux projet Node dans `root`.
 * `source` est le contenu de son script principal ; il tourne sous `npm run <script>`.
 */
export function addProject(root, name, { scripts = { dev: "node main.js" }, source = "", env = null } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, scripts }, null, 2));
  if (source) fs.writeFileSync(path.join(dir, "main.js"), source);
  if (env) fs.writeFileSync(path.join(dir, ".env"), env);
  return dir;
}

/** Un projet qui écoute sur `port` jusqu'à ce qu'on le tue. */
export function listenerSource(port, { banner = "" } = {}) {
  return `
${banner ? `console.log(${JSON.stringify(banner)});` : ""}
require("node:net").createServer().listen(${port}, () => console.log("up on ${port}"));
`;
}

export async function startLauncher({ root, password = "", config = null, env = {}, logDir = null } = {}) {
  const port = await freePort();
  // Réutilisable d'un launcher à l'autre : c'est là que vit running.json,
  // donc c'est ce qui permet de tester la reprise après redémarrage.
  logDir = logDir || makeRoot();

  let configPath = path.join(logDir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config || { overrides: {} }));

  const child = spawn(process.execPath, [SERVER], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      ROOT_DIR: root,
      SCAN_DEPTH: "2",
      DASHBOARD_PASSWORD: password,
      LOG_DIR: logDir,
      CONFIG_PATH: configPath,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));

  const base = `http://127.0.0.1:${port}`;
  const launcher = {
    base,
    port,
    logDir,
    child,
    cookie: "",
    get output() {
      return output;
    },
    errorLog() {
      const file = path.join(logDir, "error.log");
      return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
    },
    registry() {
      const file = path.join(logDir, "running.json");
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")) : null;
    },
    async fetch(pathname, options = {}) {
      const headers = { ...(options.headers || {}) };
      if (launcher.cookie) headers.cookie = launcher.cookie;
      if (options.body && !headers["content-type"]) headers["content-type"] = "application/json";
      return fetch(base + pathname, { ...options, headers, redirect: "manual" });
    },
    async post(pathname, body) {
      return launcher.fetch(pathname, { method: "POST", body: JSON.stringify(body || {}) });
    },
    async json(pathname) {
      const res = await launcher.fetch(pathname);
      return res.json();
    },
    async login(secret = password) {
      const res = await fetch(`${base}/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ password: secret }),
        redirect: "manual",
      });
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) launcher.cookie = setCookie.split(";")[0];
      return res;
    },
    async project(id) {
      const list = await launcher.json("/api/projects");
      return Array.isArray(list) ? list.find((p) => p.id === id) : undefined;
    },
    /**
     * Les projets sont lancés en detached : tuer le launcher les laisserait
     * tourner. On les arrête donc explicitement avant de le couper.
     */
    async stopProjects() {
      try {
        const list = await launcher.json("/api/projects");
        if (Array.isArray(list)) {
          for (const project of list) {
            if (project.pid) await launcher.post(`/api/projects/${project.id}/stop`);
          }
        }
      } catch {
        // launcher déjà mort : on se rabat sur le registre
      }
      for (const entry of Object.values(launcher.registry() || {})) {
        for (const target of [-entry.pid, entry.pid]) {
          try {
            process.kill(target, "SIGKILL");
          } catch {
            // déjà parti
          }
        }
      }
    },
    /** signal SIGKILL = arrêt brutal, sans laisser au launcher le temps de ranger. */
    async stop(signal = "SIGTERM") {
      if (child.exitCode === null && !child.killed) {
        child.kill(signal);
        await new Promise((r) => child.once("exit", r));
      }
      launchers.delete(launcher);
    },
  };

  launchers.add(launcher);
  await waitFor(() => portOpen(port), { label: `démarrage du launcher sur ${port}` });
  return launcher;
}

/** Tue tout ce qui écoute encore sur un port connu d'un test. */
export async function killPort(port) {
  const { execFileSync } = await import("node:child_process");
  try {
    const pids = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const pid of pids) process.kill(Number(pid), "SIGKILL");
  } catch {
    // rien n'écoute, ou lsof indisponible
  }
}

export async function cleanupAll() {
  for (const launcher of [...launchers]) {
    await launcher.stopProjects();
    await launcher.stop();
  }
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
}
