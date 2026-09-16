import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { SERVER, addProject, cleanupAll, makeRoot, startLauncher } from "./helpers.js";

afterEach(cleanupAll);

/** Laisse le temps à un effet de bord indésirable de se produire avant de nier son existence. */
const settle = () => new Promise((r) => setTimeout(r, 300));

describe("choix du script", () => {
  /**
   * Régression : `script` arrivait du corps de la requête jusque dans une ligne
   * de commande passée au shell. « dev; <commande> » exécutait la seconde.
   */
  it("n'exécute pas ce qui est greffé derrière le nom du script", async () => {
    const root = makeRoot();
    const marker = path.join(root, "preuve-injection");
    addProject(root, "cible", { source: `setInterval(() => {}, 1000);` });
    const launcher = await startLauncher({ root });

    const res = await launcher.post("/api/projects/cible/start", {
      script: `dev; touch ${marker}`,
    });

    expect(res.status).toBe(400);
    await settle();
    expect(fs.existsSync(marker)).toBe(false);
    expect((await launcher.project("cible"))!.pid).toBeNull();
  });

  it("refuse un script absent du package.json", async () => {
    const root = makeRoot();
    addProject(root, "cible", { scripts: { dev: "node main.js" }, source: "" });
    const launcher = await startLauncher({ root });

    const res = await launcher.post("/api/projects/cible/start", { script: "inexistant" });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/Unknown script "inexistant"/);
    await settle();
    expect((await launcher.project("cible"))!.pid).toBeNull();
  });

  it("laisse passer un script légitime autre que celui par défaut", async () => {
    const root = makeRoot();
    addProject(root, "cible", {
      scripts: { dev: "node main.js", autre: "node main.js" },
      source: `setInterval(() => {}, 1000);`,
    });
    const launcher = await startLauncher({ root });

    const res = await launcher.post("/api/projects/cible/start", { script: "autre" });

    expect(res.status).toBe(200);
    expect(launcher.registry().cible.script).toBe("autre");
  });
});

/** Une adresse IPv4 de la machine qui n'est pas la boucle locale, s'il en existe une. */
const external = Object.values(os.networkInterfaces())
  .flat()
  .find((i) => i && i.family === "IPv4" && !i.internal);

describe("interface d'écoute", () => {
  it.skipIf(!external)("ne répond pas en dehors de la boucle locale", async () => {
    const root = makeRoot();
    const launcher = await startLauncher({ root });

    // Contrôle positif : la boucle locale, elle, répond bien.
    expect((await launcher.fetch("/api/session")).status).toBe(200);

    const reached = await fetch(`http://${external!.address}:${launcher.port}/api/session`, {
      signal: AbortSignal.timeout(2000),
    }).catch((e: unknown) => e);

    expect(reached).toBeInstanceOf(Error);
  });

  it("refuse de démarrer hors boucle locale sans mot de passe", async () => {
    const root = makeRoot();
    const child = spawn(process.execPath, [SERVER], {
      cwd: path.dirname(SERVER),
      env: {
        ...process.env,
        PORT: "0",
        ROOT_DIR: root,
        BIND_HOST: "0.0.0.0",
        DASHBOARD_PASSWORD: "",
        LOG_DIR: root,
        CONFIG_PATH: path.join(root, "config.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ overrides: {} }));

    let output = "";
    child.stdout?.on("data", (d: Buffer) => (output += d));
    child.stderr?.on("data", (d: Buffer) => (output += d));
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));

    expect(code).toBe(1);
    expect(output).toMatch(/DASHBOARD_PASSWORD/);
  });
});
