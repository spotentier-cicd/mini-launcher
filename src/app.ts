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

/**
 * Le board n'est plus reconstruit à chaque évènement : chaque projet garde sa
 * ligne, qu'on met à jour sur place. Repartir d'un DOM neuf faisait perdre le
 * défilement des logs, le script choisi et le focus — à chaque changement d'état,
 * c'est-à-dire pendant qu'on lisait une erreur.
 */
const rowsById = new Map<string, HTMLElement>();
/** Dernier état connu par projet : les écouteurs le relisent ici plutôt que de le capturer. */
const stateById = new Map<string, ProjectState>();

function isLive(project: ProjectState): boolean {
  return project.status === "running" || project.status === "starting";
}

// Start et Restart partagent le même emplacement : quand un projet tourne,
// Start n'a plus de sens et la place sert à le relancer.
function setAction(btn: HTMLElement, mode: "start" | "restart"): void {
  const restart = mode === "restart";
  // toggleAttribute et pas .hidden : cette propriété est définie sur HTMLElement,
  // un élément SVG ne la reflète pas dans l'attribut.
  pick(btn, ".icon-start").toggleAttribute("hidden", restart);
  pick(btn, ".icon-restart").toggleAttribute("hidden", !restart);
  pick(btn, ".start-label").textContent = restart ? "Restart" : "Start";
}

// Ne touche au <select> que si la liste des scripts a bougé : le reconstruire
// à chaque évènement ramenait le choix de l'utilisateur sur le script par défaut.
function syncScripts(select: HTMLSelectElement, project: ProjectState): void {
  const scripts = project.scripts || [];
  const unchanged =
    select.options.length === scripts.length &&
    scripts.every((name, i) => select.options[i]?.value === name);

  if (!unchanged) {
    const previous = select.value;
    select.textContent = "";
    for (const name of scripts) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    }
    select.value = scripts.includes(previous) ? previous : project.defaultScript ?? scripts[0] ?? "";
  }
  // Commande fixe (override) ou un seul script possible : rien à choisir.
  select.classList.toggle("hidden", Boolean(project.command) || scripts.length <= 1);
}

/** Crée la ligne d'un projet et pose ses écouteurs, une fois pour toutes. */
function createRow(id: string): HTMLElement {
  const template = rowTemplate.content.firstElementChild;
  if (!template) throw new Error("#row-template est vide");
  const row = template.cloneNode(true) as HTMLElement;
  row.dataset.id = id;

  const actionBtn = pick<HTMLButtonElement>(row, ".start");
  const stopBtn = pick<HTMLButtonElement>(row, ".stop");
  const logsBtn = pick<HTMLButtonElement>(row, ".logs-toggle");
  const logsEl = pick(row, ".logs");
  const scriptSelect = pick<HTMLSelectElement>(row, ".script-select");

  actionBtn.addEventListener("click", () => {
    const project = stateById.get(id);
    if (!project) return;
    actionBtn.disabled = true; // anti double-clic ; act() le rétablit quoi qu'il arrive
    void act(id, isLive(project) ? "restart" : "start", { script: scriptSelect.value }, actionBtn);
  });

  stopBtn.addEventListener("click", async () => {
    const project = stateById.get(id);
    if (!project) return;
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
    void act(id, "stop", force ? { force: true } : {}, stopBtn);
  });

  logsBtn.addEventListener("click", () => {
    const open = logsEl.classList.toggle("hidden") === false;
    logsBtn.setAttribute("aria-expanded", String(open));
    if (open) {
      openLogRows.add(id);
      void loadLogs(id, logsEl);
    } else {
      openLogRows.delete(id);
    }
  });

  // Une ligne qui réapparaît (projet retiré puis revenu) retrouve son panneau ouvert.
  if (openLogRows.has(id)) {
    logsEl.classList.remove("hidden");
    logsBtn.setAttribute("aria-expanded", "true");
    void loadLogs(id, logsEl);
  }

  return row;
}

/** Reporte l'état sur une ligne existante. Ne touche jamais au panneau de logs. */
function applyState(row: HTMLElement, project: ProjectState): void {
  row.dataset.status = project.status;
  pick(row, ".row-name").textContent = project.name;
  pick(row, ".row-path").textContent = project.cwd;

  const portEl = pick(row, ".row-port");
  portEl.textContent = "";
  if (project.port) {
    const chip = document.createElement("span");
    chip.className = "port-chip";
    chip.textContent = `:${project.port}`;
    portEl.appendChild(chip);
  }
  const badge = document.createElement("span");
  badge.className = "status-badge";
  badge.textContent = STATUS_LABEL[project.status] || project.status;
  const hint = project.adopted
    ? "Reattached after a launcher restart — logs from the previous session are lost"
    : STATUS_HINT[project.status];
  if (hint) badge.title = hint;
  portEl.appendChild(badge);

  const live = isLive(project);
  const reachable = project.status === "running" || project.status === "external";

  // Le lien n'est actif qu'une fois le port confirmé : plus de clic dans le vide
  // pendant les secondes que met un dev server à écouter.
  const openBtn = pick<HTMLAnchorElement>(row, ".open");
  openBtn.hidden = !project.url;
  openBtn.classList.toggle("disabled", Boolean(project.url) && !reachable);
  if (project.url) openBtn.href = project.url;
  if (project.url && !reachable) {
    openBtn.setAttribute("aria-disabled", "true");
    openBtn.title = "Waiting for the port to answer";
  } else {
    openBtn.removeAttribute("aria-disabled");
    openBtn.removeAttribute("title");
  }

  const actionBtn = pick<HTMLButtonElement>(row, ".start");
  const stopBtn = pick<HTMLButtonElement>(row, ".stop");
  const scriptSelect = pick<HTMLSelectElement>(row, ".script-select");

  syncScripts(scriptSelect, project);
  setAction(actionBtn, live ? "restart" : "start");
  scriptSelect.disabled = live;

  actionBtn.disabled = false;
  actionBtn.removeAttribute("title");
  stopBtn.disabled = !live;
  stopBtn.removeAttribute("title");
  stopBtn.classList.remove("force");

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
  } else if (!live && !project.command && (project.scripts || []).length === 0) {
    actionBtn.disabled = true;
    actionBtn.title = "No npm script detected in package.json";
  }
}

function dropRow(id: string): void {
  rowsById.get(id)?.remove();
  rowsById.delete(id);
  stateById.delete(id);
}

function render(projects: ProjectState[]): void {
  subtitle.textContent = `${projects.length} project${projects.length === 1 ? "" : "s"} configured`;

  if (projects.length === 0) {
    showMessage("No project found under ROOT_DIR. Add one to get started.");
    return;
  }

  const incoming = new Set(projects.map((p) => p.id));
  for (const id of Array.from(rowsById.keys())) if (!incoming.has(id)) dropRow(id);

  // Purge ce qui n'est pas une ligne gérée : le « Loading… » initial, le
  // <noscript>, ou un message d'erreur laissé par un évènement `failure`.
  for (const node of Array.from(board.children)) {
    if (!(node instanceof HTMLElement) || node.dataset.id === undefined) node.remove();
  }

  projects.forEach((project, index) => {
    let row = rowsById.get(project.id);
    if (!row) {
      row = createRow(project.id);
      rowsById.set(project.id, row);
    }
    stateById.set(project.id, project);
    applyState(row, project);
    // Ne déplacer que si la position a changé : réinsérer coûte le focus.
    if (board.children[index] !== row) board.insertBefore(row, board.children[index] ?? null);
  });
}

function showMessage(text: string): void {
  for (const id of Array.from(rowsById.keys())) dropRow(id);
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

  // Tout écart resynchronise : un trou dans le flux, mais aussi un compteur
  // reparti de zéro parce que le serveur a redémarré sous l'onglet ouvert.
  const expected = (logSeqById.get(id) || 0) + 1;
  if (seq !== expected) {
    void loadLogs(id, logsEl);
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

async function act(
  id: string,
  action: string,
  body?: Record<string, unknown>,
  button?: HTMLButtonElement
): Promise<void> {
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
  } finally {
    // Un refus (409, 404) ne change pas l'état, donc aucun évènement `projects`
    // n'arrive : sans ce rétablissement le bouton restait grisé indéfiniment.
    // Le prochain état, lui, reposera la valeur qui convient.
    if (button) button.disabled = false;
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
