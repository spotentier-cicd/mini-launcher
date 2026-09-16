import { afterEach, describe, expect, it } from "vitest";
import { addProject, cleanupAll, makeRoot, startLauncher, waitFor } from "./helpers.js";

afterEach(cleanupAll);

const PASSWORD = "mot-de-passe-de-test";

async function protectedLauncher() {
  const root = makeRoot();
  addProject(root, "demo", { scripts: { dev: "node main.js" }, source: "" });
  return startLauncher({ root, password: PASSWORD });
}

describe("barrière d'authentification", () => {
  it("redirige une page vers /login sans session", async () => {
    const launcher = await protectedLauncher();
    const res = await launcher.fetch("/");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("protège aussi les fichiers statiques", async () => {
    const launcher = await protectedLauncher();
    for (const asset of ["/index.html", "/app.js"]) {
      expect((await launcher.fetch(asset)).status, asset).toBe(302);
    }
  });

  it("répond 401 en JSON sur l'API plutôt qu'une redirection", async () => {
    const launcher = await protectedLauncher();
    const res = await launcher.fetch("/api/projects");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Not authenticated" });
  });

  it("laisse passer la page de connexion et son habillage", async () => {
    const launcher = await protectedLauncher();
    expect((await launcher.fetch("/login")).status).toBe(200);
    expect((await launcher.fetch("/style.css")).status).toBe(200);
  });

  it("refuse un mauvais mot de passe sans poser de cookie", async () => {
    const launcher = await protectedLauncher();
    const res = await launcher.login("mauvais");
    expect(res.headers.get("location")).toBe("/login?error=invalid");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("ouvre une session avec un cookie HttpOnly et SameSite=Strict", async () => {
    const launcher = await protectedLauncher();
    const res = await launcher.login();
    expect(res.headers.get("location")).toBe("/");

    const cookie = res.headers.get("set-cookie");
    expect(cookie).toMatch(/^launcher_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);

    expect((await launcher.fetch("/api/projects")).status).toBe(200);
  });

  it("révoque la session au logout", async () => {
    const launcher = await protectedLauncher();
    await launcher.login();
    expect((await launcher.fetch("/api/projects")).status).toBe(200);

    await launcher.post("/logout");
    expect((await launcher.fetch("/api/projects")).status).toBe(401);
  });

  it("bloque l'IP après huit tentatives, même avec le bon mot de passe", async () => {
    const launcher = await protectedLauncher();
    for (let i = 0; i < 8; i++) await launcher.login("mauvais");

    const res = await launcher.login(PASSWORD);
    expect(res.headers.get("location")).toBe("/login?error=locked");
    expect(launcher.errorLog()).toMatch(/Trop de tentatives/);
  });

  it("rend un budget complet de tentatives une fois le blocage expiré", async () => {
    const root = makeRoot();
    addProject(root, "demo");
    const launcher = await startLauncher({ root, password: PASSWORD, env: { LOCKOUT_MS: "1000" } });

    for (let i = 0; i < 8; i++) await launcher.login("mauvais");
    expect((await launcher.login(PASSWORD)).headers.get("location")).toBe("/login?error=locked");

    // Une tentative pendant le blocage ne compte pas : dès que « invalid »
    // revient, c'est que le blocage est levé et que le compteur est reparti à 1.
    await waitFor(
      async () => (await launcher.login("mauvais")).headers.get("location") === "/login?error=invalid",
      { label: "expiration du blocage" }
    );

    // Le compteur était resté à 8 : cette seule erreur re-bloquait cinq minutes.
    expect((await launcher.login(PASSWORD)).headers.get("location")).toBe("/");
  });

  it("désactive l'authentification quand le mot de passe est vide, avec un avertissement", async () => {
    const root = makeRoot();
    const launcher = await startLauncher({ root, password: "" });

    expect((await launcher.fetch("/api/projects")).status).toBe(200);
    expect(await launcher.json<{ authEnabled: boolean }>("/api/session")).toEqual({ authEnabled: false });
    expect(launcher.errorLog()).toMatch(/DASHBOARD_PASSWORD is empty/);
  });
});
