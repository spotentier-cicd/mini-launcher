import { afterEach, describe, expect, it } from "vitest";
import { addProject, cleanupAll, freePort, makeRoot, startLauncher, waitFor } from "./helpers.js";
import type { LogsResponse, ProjectState } from "../src/types.js";

afterEach(cleanupAll);

/**
 * Régression : le launcher passait `{ ...process.env }` à ses enfants. Comme dotenv
 * n'écrase jamais une variable déjà définie, le PORT du dashboard écrasait celui du
 * projet, qui tentait alors d'écouter sur le port du dashboard — et le mot de passe
 * se promenait dans chaque process enfant.
 */
describe("isolation de l'environnement des projets", () => {
  async function runProbe(extraEnv = {}) {
    const root = makeRoot();
    addProject(root, "sonde", {
      source: `
        console.log("PORT=" + JSON.stringify(process.env.PORT));
        console.log("DASHBOARD_PASSWORD=" + JSON.stringify(process.env.DASHBOARD_PASSWORD));
        console.log("ROOT_DIR=" + JSON.stringify(process.env.ROOT_DIR));
        console.log("SCAN_DEPTH=" + JSON.stringify(process.env.SCAN_DEPTH));
        console.log("PROPRE=" + JSON.stringify(process.env.PROPRE));
      `,
    });

    const launcher = await startLauncher({ root, password: "secret", env: extraEnv });
    await launcher.login("secret");
    await launcher.post("/api/projects/sonde/start", { script: "dev" });

    const output = await waitFor(
      async () => {
        const { logs } = await launcher.json<LogsResponse>("/api/projects/sonde/logs");
        const text = logs.join("");
        return text.includes("PROPRE=") ? text : null;
      },
      { label: "sortie de la sonde" }
    );
    return { output, launcher };
  }

  it("ne transmet ni le port ni le mot de passe du dashboard", async () => {
    const { output } = await runProbe();

    expect(output).toContain("PORT=undefined");
    expect(output).toContain("DASHBOARD_PASSWORD=undefined");
    expect(output).toContain("ROOT_DIR=undefined");
    expect(output).toContain("SCAN_DEPTH=undefined");
    expect(output).not.toContain("secret");
  });

  it("laisse passer les variables qui ne sont pas celles du launcher", async () => {
    const { output } = await runProbe({ PROPRE: "valeur-utile" });
    expect(output).toContain('PROPRE="valeur-utile"');
  });

  it("laisse le projet utiliser le port de son propre .env", async () => {
    const port = await freePort();
    const root = makeRoot();
    addProject(root, "sien", {
      source: `
        require("dotenv").config();
        require("node:net").createServer().listen(Number(process.env.PORT), () =>
          console.log("écoute sur " + process.env.PORT));
      `,
      env: `PORT=${port}\n`,
    });
    // dotenv est résolu depuis node_modules du launcher, à portée du dossier temporaire.
    const launcher = await startLauncher({ root, env: { NODE_PATH: `${process.cwd()}/node_modules` } });

    await launcher.post("/api/projects/sien/start", { script: "dev" });
    const output = await waitFor(
      async () => {
        const { logs } = await launcher.json<LogsResponse>("/api/projects/sien/logs");
        const text = logs.join("");
        return text.includes("écoute sur") || text.includes("Error") ? text : null;
      },
      { label: "écoute du projet" }
    );

    expect(output).toContain(`écoute sur ${port}`);
    expect(output).not.toContain(String(launcher.port));
  });
});
