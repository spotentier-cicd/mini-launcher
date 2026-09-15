import type { FailureEvent, LogEvent, LogsResponse, ProjectState, Status } from "./types.js";

/**
 * Les classes ci-dessous forment le contrat entre index.html et ce fichier.
 * En renommer une dans le markup cassait le rendu en silence ; désormais ça
 * lève immédiatement, avec le sélecteur fautif.
 */
function pick<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`Sélecteur ${selector} absent du template de ligne`);
  return el;
}

/** Récupère un élément obligatoire : son absence est un bug de markup, pas un cas à gérer. */
function need<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Élément #${id} absent du document`);
  return el as T;
}

const board = need("board");
const subtitle = need("subtitle");
const rowTemplate = need<HTMLTemplateElement>("row-template");

const openLogRows = new Set<string>();
const logSeqById = new Map<string, number>(); // id -> dernier numéro de chunk appliqué
const logsLoading = new Set<string>(); // resynchronisations en cours

const STATUS_LABEL: Record<Status, string> = {
  running: "running",
  starting: "starting",
  external: "external",
  stopped: "stopped",
};

const STATUS_HINT: Partial<Record<Status, string>> = {
  starting: "Started, but nothing is answering on its port yet",
  external: "Already answering on this port, but not started by the dashboard",
};

/** `String(objet)` donnerait « [object Object] » dans le toast. */
function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "object" && e !== null ? JSON.stringify(e) : String(e);
}

function toLogin(): void {
  location.href = "/login";
}

/* ------------------------------------------------------------- modal --- */

const confirmModal = need<HTMLDialogElement>("confirm");
const confirmTitle = need("confirm-title");
const confirmText = need("confirm-text");
const confirmOk = need("confirm-ok");

interface ConfirmOptions {
  title: string;
  html: string;
  confirmLabel: string;
}

// <dialog> natif : Échap, piégeage du focus et ::backdrop sont gratuits.
// Le formulaire en method="dialog" renseigne returnValue avec le bouton cliqué.
function askConfirm({ title, html, confirmLabel }: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    confirmTitle.textContent = title;
    confirmText.innerHTML = html;
    confirmOk.textContent = confirmLabel;
    confirmModal.returnValue = "cancel"; // Échap ne déclenche aucun bouton
    confirmModal.addEventListener(
      "close",
      () => resolve(confirmModal.returnValue === "confirm"),
      { once: true }
    );
    confirmModal.showModal();
  });
}

function escapeHtml(value: string | number | null | undefined): string {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  );
}

/* ---------------------------------------------------------------- rendu --- */

// Start et Restart partagent le même emplacement : quand un projet tourne,
// Start n'a plus de sens et la place sert à le relancer.
function setAction(btn: HTMLElement, mode: "start" | "restart"): void {
  const restart = mode === "restart";
  // toggleAttribute et pas .hidden : cette propriété est définie sur HTMLElement,
  // un élément SVG ne la reflète pas dans l'attribut.
  btn.querySelector(".icon-start")?.toggleAttribute("hidden", restart);
  btn.querySelector(".icon-restart")?.toggleAttribute("hidden", !restart);
  const label = btn.querySelector(".start-label");
  if (label) label.textContent = restart ? "Restart" : "Start";
}

function renderRow(project: ProjectState): HTMLElement {
  const template = rowTemplate.content.firstElementChild;
  if (!template) throw new Error("#row-template est vide");
  const node = template.cloneNode(true) as HTMLElement;
  node.dataset.id = project.id;
  node.dataset.status = project.status;

  pick(node, ".row-name").textContent = project.name;
  pick(node, ".row-path").textContent = project.cwd;

  const portEl = pick(node, ".row-port");
  if (project.port) {
    const chip = document.createElement("span");
    chip.className = "port-chip";
    chip.textContent = `:${project.port}`;
    portEl.appendChild(chip);
  }
  const badge = document.createElement("span");
  badge.className = "status-badge";
  badge.textContent = STATUS_LABEL[project.status] || project.status;
  const hint = STATUS_HINT[project.status];
  if (hint) badge.title = hint;
  if (project.adopted) {
    badge.title = "Reattached after a launcher restart — logs from the previous session are lost";
  }
  portEl.appendChild(badge);

  const live = project.status === "running" || project.status === "starting";
  const reachable = project.status === "running" || project.status === "external";

  // Le lien n'est actif qu'une fois le port confirmé : plus de clic dans le vide
  // pendant les secondes que met un dev server à écouter.
  const openBtn = pick<HTMLAnchorElement>(node, ".open");
  if (!project.url) {
    openBtn.hidden = true;
  } else if (reachable) {
    openBtn.href = project.url;
  } else {
    openBtn.classList.add("disabled");
    openBtn.setAttribute("aria-disabled", "true");
    openBtn.title = "Waiting for the port to answer";
  }

  const actionBtn = pick<HTMLButtonElement>(node, ".start");
  const stopBtn = pick<HTMLButtonElement>(node, ".stop");
  const logsBtn = pick<HTMLButtonElement>(node, ".logs-toggle");
  const logsEl = pick(node, ".logs");
  const scriptSelect = pick<HTMLSelectElement>(node, ".script-select");

  const scripts = project.scripts || [];
  if (project.command || scripts.length <= 1) {
    // commande fixe (override) ou un seul script possible : pas besoin de choisir
    scriptSelect.classList.add("hidden");
  } else {
    scripts.forEach((s: string) => {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = s;
      if (s === project.defaultScript) opt.selected = true;
      scriptSelect.appendChild(opt);
    });
  }

  setAction(actionBtn, live ? "restart" : "start");
  scriptSelect.disabled = live;
  stopBtn.disabled = !live;
  actionBtn.disabled = false;

  if (project.status === "external") {
    actionBtn.disabled = true;
    actionBtn.title = "Launched outside the dashboard";
    // Non géré par nous, mais on sait quel port est occupé : on peut proposer
    // de tuer le process qui le tient, après confirmation explicite.
    stopBtn.disabled = !project.port;
    stopBtn.classList.toggle("force", Boolean(project.port));
    stopBtn.title = project.port
      ? `Not started by the dashboard — force stop whatever listens on port ${project.port}`
      : "Not started by the dashboard, and no known port to identify it";
  } else if (!live && !project.command && scripts.length === 0) {
    actionBtn.disabled = true;
    actionBtn.title = "No npm script detected in package.json";
  }

  actionBtn.addEventListener("click", () => {
    actionBtn.disabled = true; // anti double-clic ; le prochain état rétablit le bouton
    act(project.id, live ? "restart" : "start", { script: scriptSelect.value });
  });
  stopBtn.addEventListener("click", async () => {
    const force = project.status === "external";
    if (force) {
      const ok = await askConfirm({
        title: "Force stop this process?",
        html:
          `Port <code>${escapeHtml(project.port)}</code> is held by a process ` +
          `<strong>${escapeHtml(project.name)}</strong> that this dashboard did not start. ` +
          `It will be terminated.`,
        confirmLabel: "Force stop",
      });
      if (!ok) return;
    }
    stopBtn.disabled = true;
    act(project.id, "stop", force ? { force: true } : {});
  });

  logsBtn.addEventListener("click", () => {
    const open = logsEl.classList.toggle("hidden") === false;
    logsBtn.setAttribute("aria-expanded", String(open));
    if (open) {
      openLogRows.add(project.id);
      loadLogs(project.id, logsEl);
    } else {
      openLogRows.delete(project.id);
    }
  });

  if (openLogRows.has(project.id)) {
    logsEl.classList.remove("hidden");
    logsBtn.setAttribute("aria-expanded", "true");
    loadLogs(project.id, logsEl);
  }

  return node;
}

function render(projects: ProjectState[]): void {
  subtitle.textContent = `${projects.length} project${projects.length > 1 ? "s" : ""} configured`;
  board.textContent = "";
  if (projects.length === 0) {
    showMessage("No project found under ROOT_DIR. Add one to get started.");
    return;
  }
  projects.forEach((p) => board.appendChild(renderRow(p)));
}

function showMessage(text: string): void {
  board.textContent = "";
  const msg = document.createElement("p");
  msg.className = "empty";
  msg.textContent = text;
  board.appendChild(msg);
}

/* ----------------------------------------------------------------- logs --- */

function logsElFor(id: string): HTMLElement | null {
  const row = board.querySelector(`.row[data-id="${CSS.escape(id)}"]`);
  return row ? row.querySelector<HTMLElement>(".logs") : null;
}

// Remplit le panneau avec le tampon complet du serveur et note où on en est.
async function loadLogs(id: string, logsEl: HTMLElement): Promise<void> {
  logsLoading.add(id);
  try {
    const res = await fetch(`/api/projects/${id}/logs`);
    if (res.status === 401) return toLogin();
    const data = (await res.json()) as LogsResponse;
    logsEl.textContent = data.logs.join("") || "(no output yet)";
    logSeqById.set(id, data.seq);
    logsEl.scrollTop = logsEl.scrollHeight;
  } catch {
    // silencieux : la prochaine ouverture retentera
  } finally {
    logsLoading.delete(id);
  }
}

// Chunk poussé par le serveur : on l'ajoute au lieu de tout réécrire.
function appendLog({ id, seq, chunk }: LogEvent): void {
  if (!openLogRows.has(id) || logsLoading.has(id)) return;
  const logsEl = logsElFor(id);
  if (!logsEl) return;

  const expected = (logSeqById.get(id) || 0) + 1;
  if (seq < expected) return; // déjà appliqué
  if (seq > expected) {
    void loadLogs(id, logsEl); // trou dans le flux : on resynchronise
    return;
  }

  // On ne recolle en bas que si on y était déjà, pour ne pas arracher la vue
  // à quelqu'un qui est remonté lire une erreur.
  const atBottom = logsEl.scrollHeight - logsEl.scrollTop - logsEl.clientHeight < 24;
  if (logSeqById.get(id) === 0) logsEl.textContent = ""; // efface le « (no output yet) »
  logsEl.append(chunk);
  logSeqById.set(id, seq);
  if (atBottom) logsEl.scrollTop = logsEl.scrollHeight;
}

/* --------------------------------------------------------------- actions --- */

async function act(id: string, action: string, body?: Record<string, unknown>): Promise<void> {
  try {
    const res = await fetch(`/api/projects/${id}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    if (res.status === 401) return toLogin();
    const data = (await res.json()) as {
      error?: string;
      killed?: { pid: number; command: string };
    };
    if (!res.ok) return toast(data.error || "An error occurred");
    if (data.killed) toast(`Stopped ${data.killed.command} (PID ${data.killed.pid})`);
  } catch (e) {
    toast(`${describeError(e)} : Error contacting server`);
  }
  // Le nouvel état arrive par le flux : rien à recharger ici.
}

function toast(message: string): void {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// Le bouton de déconnexion n'a de sens que si un mot de passe est configuré.
async function revealLogout(): Promise<void> {
  try {
    const res = await fetch("/api/session");
    const { authEnabled } = (await res.json()) as { authEnabled: boolean };
    if (authEnabled) need("logout").hidden = false;
  } catch {
    // sans réponse on laisse le bouton masqué
  }
}

/* ------------------------------------------------------------------ flux --- */

// Le serveur pousse l'état et les logs : plus aucune boucle de polling côté
// navigateur. EventSource se reconnecte seul si le serveur redémarre.
function connect(): void {
  const events = new EventSource("/api/events");

  events.addEventListener("projects", (e) => render(JSON.parse(e.data) as ProjectState[]));
  events.addEventListener("log", (e) => appendLog(JSON.parse(e.data) as LogEvent));
  events.addEventListener("failure", (e) => showMessage((JSON.parse(e.data) as FailureEvent).error));

  events.onerror = () => {
    // Une coupure réseau laisse readyState à CONNECTING et le navigateur
    // réessaie. CLOSED signifie que le serveur a refusé : session expirée.
    if (events.readyState === EventSource.CLOSED) toLogin();
  };
}

need("refresh").addEventListener("click", () => {
  fetch("/api/refresh", { method: "POST" }).catch(() => {});
});

revealLogout();
connect();
