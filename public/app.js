const board = document.getElementById("board");
const subtitle = document.getElementById("subtitle");
const rowTemplate = document.getElementById("row-template");

const openLogRows = new Set();
const logSeqById = new Map(); // id -> dernier numéro de chunk appliqué
const logsLoading = new Set(); // resynchronisations en cours

const STATUS_LABEL = {
  running: "running",
  starting: "starting",
  external: "external",
  stopped: "stopped",
};

const STATUS_HINT = {
  starting: "Started, but nothing is answering on its port yet",
  external: "Already answering on this port, but not started by the dashboard",
};

function toLogin() {
  location.href = "/login";
}

/* ---------------------------------------------------------------- rendu --- */

// Start et Restart partagent le même emplacement : quand un projet tourne,
// Start n'a plus de sens et la place sert à le relancer.
function setAction(btn, mode) {
  const restart = mode === "restart";
  // toggleAttribute et pas .hidden : cette propriété est définie sur HTMLElement,
  // un élément SVG ne la reflète pas dans l'attribut.
  btn.querySelector(".icon-start").toggleAttribute("hidden", restart);
  btn.querySelector(".icon-restart").toggleAttribute("hidden", !restart);
  btn.querySelector(".start-label").textContent = restart ? "Restart" : "Start";
}

function renderRow(project) {
  const node = rowTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.id = project.id;
  node.dataset.status = project.status;

  node.querySelector(".row-name").textContent = project.name;
  node.querySelector(".row-path").textContent = project.cwd;

  const portEl = node.querySelector(".row-port");
  if (project.port) {
    const chip = document.createElement("span");
    chip.className = "port-chip";
    chip.textContent = `:${project.port}`;
    portEl.appendChild(chip);
  }
  const badge = document.createElement("span");
  badge.className = "status-badge";
  badge.textContent = STATUS_LABEL[project.status] || project.status;
  if (STATUS_HINT[project.status]) badge.title = STATUS_HINT[project.status];
  portEl.appendChild(badge);

  const live = project.status === "running" || project.status === "starting";
  const reachable = project.status === "running" || project.status === "external";

  // Le lien n'est actif qu'une fois le port confirmé : plus de clic dans le vide
  // pendant les secondes que met un dev server à écouter.
  const openBtn = node.querySelector(".open");
  if (!project.url) {
    openBtn.hidden = true;
  } else if (reachable) {
    openBtn.href = project.url;
  } else {
    openBtn.classList.add("disabled");
    openBtn.setAttribute("aria-disabled", "true");
    openBtn.title = "Waiting for the port to answer";
  }

  const actionBtn = node.querySelector(".start");
  const stopBtn = node.querySelector(".stop");
  const logsBtn = node.querySelector(".logs-toggle");
  const logsEl = node.querySelector(".logs");
  const scriptSelect = node.querySelector(".script-select");

  const scripts = project.scripts || [];
  if (project.command || scripts.length <= 1) {
    // commande fixe (override) ou un seul script possible : pas besoin de choisir
    scriptSelect.classList.add("hidden");
  } else {
    scripts.forEach((s) => {
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
    stopBtn.title = "Launched outside the dashboard, stop it from its own terminal";
  } else if (!live && !project.command && scripts.length === 0) {
    actionBtn.disabled = true;
    actionBtn.title = "No npm script detected in package.json";
  }

  actionBtn.addEventListener("click", () => {
    actionBtn.disabled = true; // anti double-clic ; le prochain état rétablit le bouton
    act(project.id, live ? "restart" : "start", { script: scriptSelect.value });
  });
  stopBtn.addEventListener("click", () => {
    stopBtn.disabled = true;
    act(project.id, "stop", {});
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

function render(projects) {
  subtitle.textContent = `${projects.length} project${projects.length > 1 ? "s" : ""} configured`;
  board.textContent = "";
  if (projects.length === 0) {
    showMessage("No project found under ROOT_DIR. Add one to get started.");
    return;
  }
  projects.forEach((p) => board.appendChild(renderRow(p)));
}

function showMessage(text) {
  board.textContent = "";
  const msg = document.createElement("p");
  msg.className = "empty";
  msg.textContent = text;
  board.appendChild(msg);
}

/* ----------------------------------------------------------------- logs --- */

function logsElFor(id) {
  const row = board.querySelector(`.row[data-id="${CSS.escape(id)}"]`);
  return row ? row.querySelector(".logs") : null;
}

// Remplit le panneau avec le tampon complet du serveur et note où on en est.
async function loadLogs(id, logsEl) {
  logsLoading.add(id);
  try {
    const res = await fetch(`/api/projects/${id}/logs`);
    if (res.status === 401) return toLogin();
    const data = await res.json();
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
function appendLog({ id, seq, chunk }) {
  if (!openLogRows.has(id) || logsLoading.has(id)) return;
  const logsEl = logsElFor(id);
  if (!logsEl) return;

  const expected = (logSeqById.get(id) || 0) + 1;
  if (seq < expected) return; // déjà appliqué
  if (seq > expected) return loadLogs(id, logsEl); // trou dans le flux : on resynchronise

  // On ne recolle en bas que si on y était déjà, pour ne pas arracher la vue
  // à quelqu'un qui est remonté lire une erreur.
  const atBottom = logsEl.scrollHeight - logsEl.scrollTop - logsEl.clientHeight < 24;
  if (logSeqById.get(id) === 0) logsEl.textContent = ""; // efface le « (no output yet) »
  logsEl.append(chunk);
  logSeqById.set(id, seq);
  if (atBottom) logsEl.scrollTop = logsEl.scrollHeight;
}

/* --------------------------------------------------------------- actions --- */

async function act(id, action, body) {
  try {
    const res = await fetch(`/api/projects/${id}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    if (res.status === 401) return toLogin();
    const data = await res.json();
    if (!res.ok) toast(data.error || "An error occurred");
  } catch (e) {
    toast(`${e.message} : Error contacting server`);
  }
  // Le nouvel état arrive par le flux : rien à recharger ici.
}

function toast(message) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// Le bouton de déconnexion n'a de sens que si un mot de passe est configuré.
async function revealLogout() {
  try {
    const res = await fetch("/api/session");
    const { authEnabled } = await res.json();
    if (authEnabled) document.getElementById("logout").hidden = false;
  } catch {
    // sans réponse on laisse le bouton masqué
  }
}

/* ------------------------------------------------------------------ flux --- */

// Le serveur pousse l'état et les logs : plus aucune boucle de polling côté
// navigateur. EventSource se reconnecte seul si le serveur redémarre.
function connect() {
  const events = new EventSource("/api/events");

  events.addEventListener("projects", (e) => render(JSON.parse(e.data)));
  events.addEventListener("log", (e) => appendLog(JSON.parse(e.data)));
  events.addEventListener("failure", (e) => showMessage(JSON.parse(e.data).error));

  events.onerror = () => {
    // Une coupure réseau laisse readyState à CONNECTING et le navigateur
    // réessaie. CLOSED signifie que le serveur a refusé : session expirée.
    if (events.readyState === EventSource.CLOSED) toLogin();
  };
}

document.getElementById("refresh").addEventListener("click", () => {
  fetch("/api/refresh", { method: "POST" }).catch(() => {});
});

revealLogout();
connect();
