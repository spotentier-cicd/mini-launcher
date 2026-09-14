const board = document.getElementById("board");
const subtitle = document.getElementById("subtitle");
const rowTemplate = document.getElementById("row-template");
const openLogRows = new Set();

async function fetchProjects() {
  const res = await fetch("/api/projects");
  if (!res.ok) throw new Error("Erreur serveur");
  return res.json();
}

function statusLabel(status) {
  switch (status) {
    case "running": return "en cours";
    case "external": return "déjà ouvert (hors dashboard)";
    default: return "arrêté";
  }
}

function renderRow(project) {
  const node = rowTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.id = project.id;
  node.dataset.status = project.status;

  node.querySelector(".row-name").textContent = project.name;
  node.querySelector(".row-path").textContent = project.cwd;

  const portEl = node.querySelector(".row-port");
  portEl.innerHTML = project.port
    ? `<b>:${project.port}</b> · ${statusLabel(project.status)}`
    : statusLabel(project.status);

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
    stopBtn.title = "Lancé en dehors du dashboard, arrête-le depuis son propre terminal";
  } else if (!project.command && scripts.length === 0) {
    startBtn.disabled = true;
    startBtn.title = "Aucun script npm détecté dans package.json";
    stopBtn.disabled = true;
  } else {
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }

  startBtn.addEventListener("click", () => act(project.id, "start", { script: scriptSelect.value }));
  stopBtn.addEventListener("click", () => act(project.id, "stop", {}));
  logsBtn.addEventListener("click", () => {
    logsEl.classList.toggle("hidden");
    if (logsEl.classList.contains("hidden")) {
      openLogRows.delete(project.id);
    } else {
      openLogRows.add(project.id);
      refreshLogs(project.id, logsEl);
    }
  });

  if (openLogRows.has(project.id)) {
    logsEl.classList.remove("hidden");
    refreshLogs(project.id, logsEl);
  }

  return node;
}

async function refreshLogs(id, logsEl) {
  try {
    const res = await fetch(`/api/projects/${id}/logs`);
    const data = await res.json();
    logsEl.textContent = data.logs.join("") || "(pas encore de sortie)";
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
    if (!res.ok) toast(data.error || "Une erreur est survenue");
  } catch (e) {
    toast("Impossible de contacter le dashboard");
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

async function load() {
  try {
    const projects = await fetchProjects();
    subtitle.textContent = `${projects.length} projet${projects.length > 1 ? "s" : ""} configuré${projects.length > 1 ? "s" : ""}`;
    board.innerHTML = "";
    if (projects.length === 0) {
      board.innerHTML = `<p class="empty">Aucun projet dans projects.json. Ajoute-en un pour commencer.</p>`;
      return;
    }
    projects.forEach((p) => board.appendChild(renderRow(p)));
  } catch (e) {
    board.innerHTML = `<p class="empty">Impossible de charger les projets : ${e.message}</p>`;
  }
}

document.getElementById("refresh").addEventListener("click", load);

load();
setInterval(load, 2500);
