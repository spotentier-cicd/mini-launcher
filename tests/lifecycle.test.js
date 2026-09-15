import { afterEach, describe, expect, it } from "vitest";
import {
  addProject,
  cleanupAll,
  freePort,
  killPort,
  listenerSource,
  makeRoot,
  portOpen,
  startLauncher,
  waitFor,
} from "./helpers.js";

afterEach(cleanupAll);

describe("démarrage et arrêt", () => {
  it("passe de starting à running quand le port répond, puis s'arrête", async () => {
    const port = await freePort();
    const root = makeRoot();
    addProject(root, "svc", { source: listenerSource(port), env: `PORT=${port}\n` });
    const launcher = await startLauncher({ root });

    const start = await launcher.post("/api/projects/svc/start", { script: "dev" });
    expect(start.status).toBe(200);
    expect((await start.json()).pid).toBeGreaterThan(0);

    const running = await waitFor(
      async () => {
        const p = await launcher.project("svc");
        return p.status === "running" ? p : null;
      },
      { label: "passage en running" }
    );
    expect(running.url).toBe(`http://localhost:${port}`);

    expect((await launcher.post("/api/projects/svc/stop")).status).toBe(200);
    // Contrat de /stop : au retour, le port est réellement libéré.
    expect(await portOpen(port)).toBe(false);
    expect((await launcher.project("svc")).status).toBe("stopped");
  });

  it("refuse de démarrer deux fois le même projet", async () => {
    const port = await freePort();
    const root = makeRoot();
    addProject(root, "svc", { source: listenerSource(port), env: `PORT=${port}\n` });
    const launcher = await startLauncher({ root });

    await launcher.post("/api/projects/svc/start", { script: "dev" });
    const second = await launcher.post("/api/projects/svc/start", { script: "dev" });

    expect(second.status).toBe(409);
    expect((await second.json()).error).toMatch(/Already running/);
  });

  it("garde les logs consultables après la mort du process", async () => {
    const root = makeRoot();
    addProject(root, "boom", {
      source: `console.error("raison du plantage"); process.exit(1);`,
    });
    const launcher = await startLauncher({ root });

    await launcher.post("/api/projects/boom/start", { script: "dev" });
    await waitFor(async () => (await launcher.project("boom")).status === "stopped", {
      label: "sortie du process",
    });

    const { logs } = await launcher.json("/api/projects/boom/logs");
    expect(logs.join("")).toMatch(/raison du plantage/);
    expect(logs.join("")).toMatch(/processus terminé \(code 1\)/);
  });

  it("journalise un code de sortie non nul avec la fin de la sortie", async () => {
    const root = makeRoot();
    addProject(root, "boom", {
      source: `console.error("ECONNREFUSED 5432"); process.exit(1);`,
    });
    const launcher = await startLauncher({ root });

    await launcher.post("/api/projects/boom/start", { script: "dev" });
    await waitFor(() => launcher.errorLog().includes("terminé en erreur"), {
      label: "journalisation du crash",
    });

    const log = launcher.errorLog();
    expect(log).toMatch(/Projet « boom » terminé en erreur \(code 1\)/);
    expect(log).toMatch(/ECONNREFUSED 5432/);
  });

  it("refuse de lancer si le port est déjà pris, sans démarrer de process", async () => {
    const port = await freePort();
    const root = makeRoot();
    addProject(root, "svc", { source: listenerSource(port), env: `PORT=${port}\n` });
    const launcher = await startLauncher({ root });

    // Un intrus occupe le port avant nous.
    addProject(root, "intrus", { source: listenerSource(port) });
    const intruder = await launcher.post("/api/projects/intrus/start", { script: "dev" });
    expect(intruder.status).toBe(200);
    await waitFor(() => portOpen(port), { label: "intrus en écoute" });

    const res = await launcher.post("/api/projects/svc/start", { script: "dev" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Port \d+ is already in use/);
    expect((await launcher.project("svc")).pid).toBeNull();

    await killPort(port);
  });
});

describe("redémarrage", () => {
  it("attend la libération du port quand l'enfant traîne à sortir", async () => {
    const port = await freePort();
    const root = makeRoot();
    // L'enfant garde la socket 600 ms après SIGTERM. Vérifie le contrat de
    // stopProject() : rendre la main seulement une fois le port libéré.
    // (Sur macOS npm attend déjà son enfant ; sur Linux non, d'où la nécessité.)
    addProject(root, "lent", {
      source: `
        const server = require("node:net").createServer().listen(${port}, () => console.log("up"));
        process.on("SIGTERM", () => setTimeout(() => { server.close(); process.exit(0); }, 600));
      `,
      env: `PORT=${port}\n`,
    });
    const launcher = await startLauncher({ root });

    await launcher.post("/api/projects/lent/start", { script: "dev" });
    await waitFor(async () => (await launcher.project("lent")).status === "running", {
      label: "démarrage",
    });

    const res = await launcher.post("/api/projects/lent/restart", {});
    expect(res.status).toBe(200);
    await waitFor(async () => (await launcher.project("lent")).status === "running", {
      label: "retour en running",
    });
  });

  it("enchaîne trois redémarrages d'affilée", async () => {
    const port = await freePort();
    const root = makeRoot();
    addProject(root, "svc", { source: listenerSource(port), env: `PORT=${port}\n` });
    const launcher = await startLauncher({ root });

    await launcher.post("/api/projects/svc/start", { script: "dev" });
    await waitFor(async () => (await launcher.project("svc")).status === "running");

    for (let i = 0; i < 3; i++) {
      const res = await launcher.post("/api/projects/svc/restart", {});
      expect(res.status, `redémarrage ${i + 1}`).toBe(200);
    }
  });

  it("relance avec un nouveau pid en réutilisant le script en cours", async () => {
    const port = await freePort();
    const root = makeRoot();
    addProject(root, "svc", {
      scripts: { dev: "node main.js", autre: "node main.js" },
      source: listenerSource(port),
      env: `PORT=${port}\n`,
    });
    const launcher = await startLauncher({ root });

    await launcher.post("/api/projects/svc/start", { script: "dev" });
    const before = await waitFor(async () => {
      const p = await launcher.project("svc");
      return p.status === "running" ? p : null;
    });

    const res = await launcher.post("/api/projects/svc/restart", {});
    expect(res.status).toBe(200);
    const after = await res.json();

    expect(after.pid).not.toBe(before.pid);
    expect(launcher.registry().svc.script).toBe("dev");
    await waitFor(async () => (await launcher.project("svc")).status === "running", {
      label: "retour en running après restart",
    });
  });
});

describe("arrêt forcé d'un process non géré", () => {
  it("tue ce qui occupe le port quand force est demandé", async () => {
    const port = await freePort();
    const root = makeRoot();
    addProject(root, "ext", { source: listenerSource(port), env: `PORT=${port}\n` });
    const launcher = await startLauncher({ root });

    // Lancé hors du dashboard : il le verra en « external ».
    const { spawn } = await import("node:child_process");
    const outsider = spawn(process.execPath, ["main.js"], {
      cwd: `${root}/ext`,
      stdio: "ignore",
      detached: true,
    });
    await waitFor(() => portOpen(port), { label: "process externe en écoute" });
    await waitFor(async () => (await launcher.project("ext")).status === "external", {
      label: "statut external",
    });

    const plain = await launcher.post("/api/projects/ext/stop");
    expect(plain.status).toBe(404);
    expect(await portOpen(port)).toBe(true);

    const forced = await launcher.post("/api/projects/ext/stop", { force: true });
    expect(forced.status).toBe(200);
    expect((await forced.json()).killed.pid).toBe(outsider.pid);

    await waitFor(async () => !(await portOpen(port)), { label: "port libéré" });
    expect(launcher.errorLog()).toMatch(/Arrêt forcé du process occupant le port/);
  });

  it("refuse de tuer le dashboard lui-même", async () => {
    const root = makeRoot();
    const launcher = await startLauncher({ root });
    // Le launcher est son propre projet scanné, sur son propre port.
    addProject(root, "moi-meme", { env: `PORT=${launcher.port}\n` });

    await waitFor(async () => (await launcher.project("moi-meme"))?.status === "external", {
      label: "le launcher se voit en external",
    });

    const res = await launcher.post("/api/projects/moi-meme/stop", { force: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/dashboard itself/);

    // Toujours vivant.
    expect((await launcher.fetch("/api/projects")).status).toBe(200);
  });
});
