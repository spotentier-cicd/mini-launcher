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
import type { FailureEvent, LogEvent, LogsResponse, ProjectState } from "../src/types.js";
import type { Launcher } from "./helpers.js";

afterEach(cleanupAll);

interface SseEvent {
  type: string;
  data: unknown;
}

interface SseStream {
  events: SseEvent[];
  status: number;
  contentType: string | null;
  close: () => void;
  ofType: (type: string) => SseEvent[];
}

/** Ouvre /api/events et accumule les évènements reçus. */
async function openEvents(launcher: Launcher): Promise<SseStream> {
  const controller = new AbortController();
  const res = await fetch(`${launcher.base}/api/events`, {
    headers: launcher.cookie ? { cookie: launcher.cookie } : {},
    signal: controller.signal,
  });
  const events: SseEvent[] = [];

  (async () => {
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let split: number;
        // Découpage de trames : tester la présence du séparateur et retenir sa
        // position sont la même opération.
        // biome-ignore lint/suspicious/noAssignInExpressions: affectation voulue
        while ((split = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const type = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (type && data) events.push({ type, data: JSON.parse(data) });
        }
      }
    } catch {
      // flux interrompu volontairement en fin de test
    }
  })();

  return {
    events,
    status: res.status,
    contentType: res.headers.get("content-type"),
    close: () => controller.abort(),
    ofType: (type: string) => events.filter((e) => e.type === type),
  };
}

describe("flux d'évènements", () => {
  it("exige une session", async () => {
    const root = makeRoot();
    const launcher = await startLauncher({ root, password: "secret" });
    const res = await launcher.fetch("/api/events");
    expect(res.status).toBe(401);
  });

  it("envoie l'état courant dès la connexion", async () => {
    const root = makeRoot();
    addProject(root, "alpha");
    const launcher = await startLauncher({ root });

    const stream = await openEvents(launcher);
    expect(stream.contentType).toMatch(/text\/event-stream/);

    const first = await waitFor(() => stream.ofType("projects")[0], { label: "premier état" });
    expect((first.data as ProjectState[]).map((p) => p.id)).toEqual(["alpha"]);
    stream.close();
  });

  it("ne renvoie pas l'état tant que rien ne change", async () => {
    const root = makeRoot();
    addProject(root, "alpha");
    const launcher = await startLauncher({ root });

    const stream = await openEvents(launcher);
    await waitFor(() => stream.ofType("projects").length > 0);
    // La boucle tourne toutes les 2 s : on laisse passer plusieurs tours.
    await new Promise((r) => setTimeout(r, 5000));

    expect(stream.ofType("projects")).toHaveLength(1);
    stream.close();
  });

  it("ne prive pas un client d'une mise à jour quand un autre se connecte", async () => {
    const root = makeRoot();
    addProject(root, "alpha");
    const launcher = await startLauncher({ root });

    const first = await openEvents(launcher);
    await waitFor(() => first.ofType("projects").length > 0, { label: "état initial" });

    // L'état change, puis un second client se connecte. Avec une comparaison
    // globale, cette connexion faisait passer le nouvel état pour déjà diffusé
    // et le premier client ne le recevait jamais.
    addProject(root, "beta");
    const second = await openEvents(launcher);
    await waitFor(() => second.ofType("projects").length > 0, { label: "état du second client" });

    await waitFor(
      () => {
        const last = first.ofType("projects").at(-1);
        return (last?.data as ProjectState[] | undefined)?.some((p) => p.id === "beta");
      },
      { label: "beta vu par le premier client" }
    );

    first.close();
    second.close();
  });

  it("pousse les lignes de log avec un numéro croissant", async () => {
    const root = makeRoot();
    addProject(root, "bavard", {
      source: `for (let i = 1; i <= 3; i++) console.log("ligne " + i);`,
    });
    const launcher = await startLauncher({ root });
    const stream = await openEvents(launcher);

    await launcher.post("/api/projects/bavard/start", { script: "dev" });
    await waitFor(() => stream.ofType("log").some((e) => (e.data as LogEvent).chunk.includes("ligne 3")), {
      label: "arrivée des logs",
    });

    const logs = stream.ofType("log");
    const seqs = logs.map((e) => (e.data as LogEvent).seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(logs.every((e) => (e.data as LogEvent).id === "bavard")).toBe(true);
    stream.close();
  });

  it("diffuse une erreur de configuration plutôt que de couper le flux", async () => {
    const launcher = await startLauncher({ root: "/chemin/absent" });
    const stream = await openEvents(launcher);

    const failure = await waitFor(() => stream.ofType("failure")[0], { label: "évènement failure" });
    expect((failure.data as FailureEvent).error).toMatch(/Directory not found/);
    stream.close();
  });
});

describe("détection du port dans la sortie", () => {
  it("retient l'adresse annoncée même entourée de codes ANSI", async () => {
    const port = await freePort();
    const root = makeRoot();
    // Sortie colorée, comme celle d'un Vite.
    addProject(root, "vite-like", {
      source: `
        const net = require("node:net");
        net.createServer().listen(${port}, () => {
          console.log("  \\x1b[32m➜\\x1b[0m  \\x1b[1mLocal\\x1b[0m:   \\x1b[36mhttp://localhost:${port}/\\x1b[0m");
        });
      `,
    });
    const launcher = await startLauncher({ root });

    expect((await launcher.project("vite-like"))!.port).toBeNull();

    await launcher.post("/api/projects/vite-like/start", { script: "dev" });
    const detected = await waitFor(
      async () => {
        const p = await launcher.project("vite-like");
        return p?.port ? p : null;
      },
      { label: "détection du port" }
    );

    expect(detected.port).toBe(port);
    expect(detected.url).toBe(`http://localhost:${port}`);
    expect(detected.status).toBe("running");
    expect(launcher.registry()["vite-like"].port).toBe(port);
  });
});

describe("reprise après un arrêt brutal du launcher", () => {
  it("réadopte le process orphelin et permet de l'arrêter", async () => {
    const port = await freePort();
    const root = makeRoot();
    addProject(root, "survivant", { source: listenerSource(port), env: `PORT=${port}\n` });

    const first = await startLauncher({ root });
    await first.post("/api/projects/survivant/start", { script: "dev" });
    const before = await waitFor(
      async () => {
        const p = await first.project("survivant");
        return p?.status === "running" ? p : null;
      },
      { label: "premier démarrage" }
    );

    // SIGKILL : aucune chance de ranger. Le projet reste orphelin.
    await first.stop("SIGKILL");
    expect(await portOpen(port)).toBe(true);

    const second = await startLauncher({ root, logDir: first.logDir });
    const adopted = await waitFor(
      async () => {
        const p = await second.project("survivant");
        return p?.adopted ? p : null;
      },
      { label: "réadoption" }
    );

    expect(adopted.pid).toBe(before.pid);
    expect(adopted.status).toBe("running");

    const { logs } = await second.json<LogsResponse>("/api/projects/survivant/logs");
    expect(logs.join("")).toMatch(/réattaché au process/);

    // Le point de tout l'exercice : on peut l'arrêter depuis l'interface.
    expect((await second.post("/api/projects/survivant/stop")).status).toBe(200);
    await waitFor(async () => !(await portOpen(port)), { label: "port libéré" });

    await killPort(port);
  });
});
