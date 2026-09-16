import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addProject, cleanupAll, makeRoot, startLauncher } from "./helpers.js";
import type { ProjectState } from "../src/types.js";

afterEach(cleanupAll);

describe("détection des projets", () => {
  it("retient tout dossier contenant un package.json", async () => {
    const root = makeRoot();
    addProject(root, "alpha");
    addProject(root, "beta");
    fs.mkdirSync(path.join(root, "sans-package"));

    const launcher = await startLauncher({ root });
    const projects = await launcher.json<ProjectState[]>("/api/projects");

    expect(projects.map((p) => p.id).sort()).toEqual(["alpha", "beta"]);
  });

  it("ignore node_modules, .git et les dossiers de build", async () => {
    const root = makeRoot();
    addProject(root, "app");
    for (const ignored of ["node_modules", ".git", "dist", "build"]) {
      addProject(root, path.join("app-parent", ignored));
    }

    const launcher = await startLauncher({ root });
    const projects = await launcher.json<ProjectState[]>("/api/projects");

    expect(projects.map((p) => p.id)).toEqual(["app"]);
  });

  it("préfère dev, puis start, puis serve", async () => {
    const root = makeRoot();
    addProject(root, "tous", { scripts: { serve: "x", start: "x", dev: "x" } });
    addProject(root, "sans-dev", { scripts: { serve: "x", start: "x" } });
    addProject(root, "serve-seul", { scripts: { serve: "x" } });
    addProject(root, "rien", { scripts: { lint: "x" } });

    const launcher = await startLauncher({ root });
    const byId = Object.fromEntries((await launcher.json<ProjectState[]>("/api/projects")).map((p) => [p.id, p]));

    expect(byId.tous.defaultScript).toBe("dev");
    expect(byId["sans-dev"].defaultScript).toBe("start");
    expect(byId["serve-seul"].defaultScript).toBe("serve");
    expect(byId.rien.defaultScript).toBeNull();
  });

  it("lit le port dans le .env du projet", async () => {
    const root = makeRoot();
    addProject(root, "avec-port", { env: "PORT=4501\n" });
    addProject(root, "sans-port");

    const launcher = await startLauncher({ root });
    const byId = Object.fromEntries((await launcher.json<ProjectState[]>("/api/projects")).map((p) => [p.id, p]));

    expect(byId["avec-port"].port).toBe(4501);
    expect(byId["avec-port"].url).toBe("http://localhost:4501");
    expect(byId["sans-port"].port).toBeNull();
    expect(byId["sans-port"].url).toBeNull();
  });

  it("descend dans les sous-dossiers jusqu'à SCAN_DEPTH", async () => {
    const root = makeRoot();
    addProject(root, path.join("groupe", "imbrique"));
    addProject(root, path.join("a", "b", "trop-profond"));

    const launcher = await startLauncher({ root, env: { SCAN_DEPTH: "2" } });
    const projects = await launcher.json<ProjectState[]>("/api/projects");

    expect(projects.map((p) => p.id)).toEqual(["groupe__imbrique"]);
  });

  it("applique les overrides de config.json par-dessus la détection", async () => {
    const root = makeRoot();
    addProject(root, "brut", { env: "PORT=1111\n" });

    const launcher = await startLauncher({
      root,
      config: { overrides: { brut: { name: "Nom personnalisé", port: 4500 } } },
    });
    const [project] = await launcher.json<ProjectState[]>("/api/projects");

    expect(project.name).toBe("Nom personnalisé");
    expect(project.port).toBe(4500);
    expect(project.url).toBe("http://localhost:4500");
  });

  /** Le contrat de src/types.d.ts n'est pas tenu par le compilateur sur un spread. */
  it("n'expose au client que les champs déclarés dans ProjectState", async () => {
    const root = makeRoot();
    addProject(root, "brut", { env: "PORT=1111\n" });

    const launcher = await startLauncher({
      root,
      config: { overrides: { brut: { port: 4500 } } },
    });
    const [project] = await launcher.json<ProjectState[]>("/api/projects");

    const declared = [
      "id", "name", "cwd", "scripts", "defaultScript", "port", "url",
      "status", "pid", "startedAt", "adopted", "command", "args",
    ];
    expect(Object.keys(project!).filter((k) => !declared.includes(k))).toEqual([]);
    expect(project).not.toHaveProperty("pinnedPort");
  });

  it("signale une erreur exploitable quand ROOT_DIR n'existe pas", async () => {
    const launcher = await startLauncher({ root: "/chemin/qui/nexiste/pas" });
    const res = await launcher.fetch("/api/projects");

    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/Directory not found/);
    expect(launcher.errorLog()).toMatch(/Calcul de l'état impossible/);
  });
});
