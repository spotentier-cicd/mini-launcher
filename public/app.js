const board = document.getElementById("board");
const subtitle = document.getElementById("subtitle");
const rowTemplate = document.getElementById("row-template");
const openLogRows = new Set();

async function fetchProjects() {
  const res = await fetch("/api/projects");
  if (res.status === 401) {
    location.href = "/login";
    throw new Error("Session expired");
  }
  if (!res.ok) throw new Error("Server error");
  return res.json();
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

const STATUS_LABEL = {
  running: "running",
  external: "external",
  stopped: "stopped",
};

const STATUS_HINT = {
  external: "Already answering on this port, but not started by the dashboard",
};

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

  const openBtn = node.querySelector(".open");
  if (project.url) {
    openBtn.href = project.url;
  } else {
    openBtn.style.display = "none";
  }

  const startBtn = node.querySelector(".start");
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

  if (project.status === "running") {
    startBtn.disabled = true;
    stopBtn.disabled = false;
    scriptSelect.disabled = true;
  } else if (project.status === "external") {
    startBtn.disabled = true;
    stopBtn.disabled = true;
    stopBtn.title = "Launched outside the dashboard, stop it from its own terminal";
  } else if (!project.command && scripts.length === 0) {
    startBtn.disabled = true;
    startBtn.title = "No npm script detected in package.json";
    stopBtn.disabled = true;
  } else {
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }

  startBtn.addEventListener("click", () => act(project.id, "start", { script: scriptSelect.value }));
  stopBtn.addEventListener("click", () => act(project.id, "stop", {}));
  logsBtn.addEventListener("click", () => {
    const open = logsEl.classList.toggle("hidden") === false;
    logsBtn.setAttribute("aria-expanded", String(open));
    if (!open) {
      openLogRows.delete(project.id);
    } else {
      openLogRows.add(project.id);
      refreshLogs(project.id, logsEl);
    }
  });

  if (openLogRows.has(project.id)) {
    logsEl.classList.remove("hidden");
    logsBtn.setAttribute("aria-expanded", "true");
    refreshLogs(project.id, logsEl);
  }

  return node;
}

async function refreshLogs(id, logsEl) {
  try {
    const res = await fetch(`/api/projects/${id}/logs`);
    const data = await res.json();
    logsEl.textContent = data.logs.join("") || "(no output yet)";
    logsEl.scrollTop = logsEl.scrollHeight;
  } catch {
    // silencieux : on retentera au prochain cycle
  }
}

async function act(id, action, body) {
  try {
    const res = await fetch(`/api/projects/${id}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json();
    if (!res.ok) toast(data.error || "An error occurred");
  } catch (e) {
    toast(e.message + " : Error contacting server");
  }
  await load();
}

function toast(message) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

let lastSnapshot = "";

async function load() {
  try {
    const projects = await fetchProjects();
    const snapshot = JSON.stringify(projects);
    if (snapshot === lastSnapshot) return; // rien n'a changé : on garde le DOM en place
    lastSnapshot = snapshot;

    subtitle.textContent = `${projects.length} project${projects.length > 1 ? "s" : ""} configured`;
    board.innerHTML = "";
    if (projects.length === 0) {
      board.innerHTML = `<p class="empty">No projects found in projects.json. Add one to get started.</p>`;
      return;
    }
    projects.forEach((p) => board.appendChild(renderRow(p)));
  } catch (e) {
    lastSnapshot = "";
    board.textContent = "";
    const msg = document.createElement("p");
    msg.className = "empty";
    msg.textContent = `Error loading projects: ${e.message}`;
    board.appendChild(msg);
  }
}

document.getElementById("refresh").addEventListener("click", load);

revealLogout();
load();
setInterval(load, 2500);
