import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectState } from "../src/types.js";

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SERVER = path.join(PROJECT_ROOT, "server.ts");

/** Dossiers temporaires créés pendant un test, nettoyés par cleanupAll(). */
const tempDirs = new Set<string>();
/** Launchers démarrés, pour être sûr de ne rien laisser tourner. */
const launchers = new Set<Launcher>();

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("Port libre introuvable")));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

export function portOpen(port: number): Promise<boolean> {
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

// Un runner CI est nettement plus lent qu'une machine locale.
const DEFAULT_WAIT = process.env.CI ? 20000 : 8000;

interface WaitOptions {
  timeout?: number;
  interval?: number;
  label?: string;
}

/** Attend qu'une condition devienne vraie, sans dormir bêtement. */
export async function waitFor<T>(
  predicate: () => T | Promise<T>,
  { timeout = DEFAULT_WAIT, interval = 50, label = "condition" }: WaitOptions = {}
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Timeout en attendant : ${label}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

export function makeRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mini-launcher-test-"));
  tempDirs.add(dir);
  return dir;
}

interface ProjectOptions {
  scripts?: Record<string, string>;
  source?: string;
  env?: string | null;
}

/**
 * Crée un faux projet Node dans `root`.
 * `source` est le contenu de son script principal ; il tourne sous `npm run <script>`.
 */
export function addProject(
  root: string,
  name: string,
  { scripts = { dev: "node main.js" }, source = "", env = null }: ProjectOptions = {}
): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, scripts }, null, 2));
  if (source) fs.writeFileSync(path.join(dir, "main.js"), source);
  if (env) fs.writeFileSync(path.join(dir, ".env"), env);
  return dir;
}

/** Un projet qui écoute sur `port` jusqu'à ce qu'on le tue. */
export function listenerSource(port: number, { banner = "" }: { banner?: string } = {}): string {
  return `
${banner ? `console.log(${JSON.stringify(banner)});` : ""}
require("node:net").createServer().listen(${port}, () => console.log("up on ${port}"));
`;
}

/** Ce que `logs/running.json` conserve pour un projet. */
interface RegistryEntry {
  pid: number;
  startedAt: number;
  script: string | null;
  port: number | null;
}

export interface Launcher {
  base: string;
  port: number;
  logDir: string;
  child: ChildProcess;
  cookie: string;
  readonly output: string;
  errorLog(): string;
  registry(): Record<string, RegistryEntry>;
  fetch(pathname: string, options?: RequestInit): Promise<Response>;
  post(pathname: string, body?: unknown): Promise<Response>;
  json<T = unknown>(pathname: string): Promise<T>;
  login(secret?: string): Promise<Response>;
  project(id: string): Promise<ProjectState | undefined>;
  stopProjects(): Promise<void>;
  stop(signal?: NodeJS.Signals): Promise<void>;
}

interface LauncherOptions {
  root: string;
  password?: string;
  config?: unknown;
  env?: Record<string, string>;
  logDir?: string | null;
}

export async function startLauncher({
  root,
  password = "",
  config = null,
  env = {},
  logDir = null,
}: LauncherOptions): Promise<Launcher> {
  const port = await freePort();
  // Réutilisable d'un launcher à l'autre : c'est là que vit running.json,
  // donc c'est ce qui permet de tester la reprise après redémarrage.
  const dir = logDir || makeRoot();

  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config || { overrides: {} }));

  const child = spawn(process.execPath, [SERVER], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      ROOT_DIR: root,
      SCAN_DEPTH: "2",
      DASHBOARD_PASSWORD: password,
      LOG_DIR: dir,
      CONFIG_PATH: configPath,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout?.on("data", (d: Buffer) => (output += d));
  child.stderr?.on("data", (d: Buffer) => (output += d));

  const base = `http://127.0.0.1:${port}`;
  const launcher: Launcher = {
    base,
    port,
    logDir: dir,
    child,
    cookie: "",
    get output() {
      return output;
    },
    errorLog() {
      const file = path.join(dir, "error.log");
      return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
    },
    registry() {
      const file = path.join(dir, "running.json");
      return file && fs.existsSync(file)
        ? (JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, RegistryEntry>)
        : {};
    },
    async fetch(pathname, options = {}) {
      const headers: Record<string, string> = { ...(options.headers as Record<string, string> | undefined) };
      if (launcher.cookie) headers.cookie = launcher.cookie;
      if (options.body && !headers["content-type"]) headers["content-type"] = "application/json";
      return fetch(base + pathname, { ...options, headers, redirect: "manual" });
    },
    async post(pathname, body) {
      return launcher.fetch(pathname, { method: "POST", body: JSON.stringify(body || {}) });
    },
    async json<T = unknown>(pathname: string) {
      const res = await launcher.fetch(pathname);
      return (await res.json()) as T;
    },
    async login(secret = password) {
      const res = await fetch(`${base}/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ password: secret }),
        redirect: "manual",
      });
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) launcher.cookie = setCookie.split(";")[0] ?? "";
      return res;
    },
    async project(id) {
      const list = await launcher.json<ProjectState[] | { error: string }>("/api/projects");
      return Array.isArray(list) ? list.find((p) => p.id === id) : undefined;
    },
    /**
     * Les projets sont lancés en detached : tuer le launcher les laisserait
     * tourner. On les arrête donc explicitement avant de le couper.
     */
    async stopProjects() {
      try {
        const list = await launcher.json<ProjectState[] | { error: string }>("/api/projects");
        if (Array.isArray(list)) {
          for (const project of list) {
            if (project.pid) await launcher.post(`/api/projects/${project.id}/stop`);
          }
        }
      } catch {
        // launcher déjà mort : on se rabat sur le registre
      }
      for (const entry of Object.values(launcher.registry())) {
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
    async stop(signal: NodeJS.Signals = "SIGTERM") {
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
export async function killPort(port: number): Promise<void> {
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

export async function cleanupAll(): Promise<void> {
  // Copie délibérée : stop() retire l'élément du Set pendant l'itération.
  for (const launcher of Array.from(launchers)) {
    await launcher.stopProjects();
    await launcher.stop();
  }
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
}
