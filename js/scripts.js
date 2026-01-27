// =====================
// CONFIG API (Apps Script Web App)
// =====================
// ⚠️ Pegá acá el /exec de tu Web App (Deploy)
const API_BASE = "https://script.google.com/macros/s/AKfycbzHOg58y2GFbPZijSmMX567cOYvpbZ3PTLbd7qAKwcmu9EyzbuKseIymW9eaG_6Tjfo9w/exec"; // ej: https://script.google.com/macros/s/XXXXX/exec

// =====================
// CONFIG OAUTH (Google Identity Services)
// =====================
// ⚠️ Usá tu OAuth Client ID (tipo "Web application") del Google Cloud Console
const OAUTH_CLIENT_ID = "917192108969-6d693ji2l5ku1vsje8s6brvio2j01hio.apps.googleusercontent.com";


// scope mínimo para identificar al usuario (email)
const OAUTH_SCOPES = "openid email profile";

async function forceSwitchAccount() {
  // obliga a Google a mostrar el selector de cuenta
  oauthAccessToken = "";
  oauthExpiresAt = 0;
  await ensureOAuthToken(true, "select_account");
}


let oauthTokenClient = null;
let oauthAccessToken = "";
let oauthExpiresAt = 0;

// Inicializa GIS Token Client
function initOAuth() {
  oauthTokenClient = google.accounts.oauth2.initTokenClient({
    client_id: OAUTH_CLIENT_ID,
    scope: OAUTH_SCOPES,
    callback: () => { }
  });
}

function requestAccessToken({ prompt } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error("popup_timeout_or_closed"));
    }, 45_000);

    oauthTokenClient.callback = (resp) => {
      console.log("GIS resp:", resp);

      if (done) return;
      done = true;
      clearTimeout(timer);

      if (resp?.error) {
        // GIS suele devolver interaction_required cuando pedís silent
        const err = String(resp.error || "");
        const sub = String(resp.error_subtype || "");
        const msg = (err + (sub ? `:${sub}` : "")).toLowerCase();

        if (msg.includes("interaction_required") || msg.includes("access_denied")) {
          reject(new Error("TOKEN_NEEDS_INTERACTIVE"));
          return;
        }

        reject(new Error(err));
        return;
      }
      resolve(resp);

    };

    // Si prompt viene undefined, NO lo mandamos (GIS a veces se pone pesado si mandás "")
    const opts = {};
    if (prompt !== undefined) opts.prompt = prompt;
    oauthTokenClient.requestAccessToken(opts);

  });
}

function isTokenValid() {
  return oauthAccessToken && Date.now() < (oauthExpiresAt - 30_000);
}

// Esto intenta silent. Si falla y allowInteractive=true, abre popup.
async function ensureOAuthToken(allowInteractive = false, interactivePrompt = "consent") {
  // 0) si ya está en memoria, OK
  if (isTokenValid()) return oauthAccessToken;

  // 0.5) si hay token guardado, cargarlo
  if (loadStoredOAuth() && isTokenValid()) return oauthAccessToken;

  // 1) silent (siempre intentamos, pero puede fallar según navegador)
  try {
    const r = await requestAccessToken({ prompt: "none" }); // 👈 importante
    oauthAccessToken = r.access_token;
    oauthExpiresAt = Date.now() + (r.expires_in * 1000);
    saveStoredOAuth(oauthAccessToken, oauthExpiresAt);
    return oauthAccessToken;
  } catch { }

  // 2) interactivo (solo si el usuario tocó "Conectar")
  if (!allowInteractive) throw new Error("TOKEN_NEEDS_INTERACTIVE");

  const r = await requestAccessToken({ prompt: interactivePrompt || "consent" });
  oauthAccessToken = r.access_token;
  oauthExpiresAt = Date.now() + (r.expires_in * 1000);
  saveStoredOAuth(oauthAccessToken, oauthExpiresAt);
  return oauthAccessToken;
}


// =====================
// Local cache/offline keys (tareas)
// =====================
const LS_CACHE = "tareas_drive_cache_v1";
const LS_PENDING = "tareas_drive_pending_v1";

// =====================
// OAuth token persistente (evita pedir permisos en cada refresh)
// =====================
const LS_OAUTH = "tareas_oauth_token_v1";

function loadStoredOAuth() {
  try {
    const raw = localStorage.getItem(LS_OAUTH);
    if (!raw) return false;
    const t = JSON.parse(raw);
    if (!t?.access_token || !t?.expires_at) return false;
    if (Date.now() >= (Number(t.expires_at) - 30_000)) return false;

    oauthAccessToken = t.access_token;
    oauthExpiresAt = Number(t.expires_at);
    return true;
  } catch {
    return false;
  }
}

function saveStoredOAuth(accessToken, expiresAt) {
  try {
    localStorage.setItem(LS_OAUTH, JSON.stringify({
      access_token: accessToken,
      expires_at: expiresAt
    }));
  } catch { }
}

function clearStoredOAuth() {
  try { localStorage.removeItem(LS_OAUTH); } catch { }
  oauthAccessToken = "";
  oauthExpiresAt = 0;
}


// =====================
// UI construir estructura
// =====================
const header = document.querySelector("header");

const titulo = document.createElement("section");
titulo.classList = "titulo";
header.appendChild(titulo);

const h1 = document.createElement("h1");
h1.innerText = "Lista de Tareas";
titulo.appendChild(h1);

const syncPill = document.createElement("div");
syncPill.className = "sync-pill";
syncPill.innerHTML = `<span class="sync-dot"></span><span class="sync-text">Cargando…</span>`;
titulo.appendChild(syncPill);

const btnConnect = document.createElement("button");
btnConnect.className = "btn-connect";
btnConnect.textContent = "Conectar";
btnConnect.style.marginLeft = "10px";
titulo.appendChild(btnConnect);

btnConnect.addEventListener("click", async () => {
  try {
    setSync("saving", "Autorizando…");
    await ensureOAuthToken(true, "select_account");
    await refreshFromRemote(true);
    setSync("ok", "Conectado ✅");
    toast("Conectado ✅", "ok", "Ya podés sincronizar con Drive.");
  } catch (e) {
    setSync("offline", "No autorizado");
    toast("No se pudo autorizar", "err", e?.message || "");
  }
});

const main = document.querySelector("main");

const seccionLista = document.createElement("section");
seccionLista.classList = "agregarItem";
main.appendChild(seccionLista);

const label1 = document.createElement("label");
label1.innerText = "Agregar tarea: ";
seccionLista.appendChild(label1);

const input1 = document.createElement("input");
input1.type = "text";
seccionLista.appendChild(input1);

const button1 = document.createElement("button");
button1.innerText = "Agregar";
seccionLista.appendChild(button1);

// ===== BUSCADOR (input + X agrupados) =====
const buscadorWrap = document.createElement("div");
buscadorWrap.style.display = "flex";
buscadorWrap.style.alignItems = "center";
buscadorWrap.style.gap = "10px";
buscadorWrap.style.marginLeft = "10px";
buscadorWrap.style.flex = "1";
seccionLista.appendChild(buscadorWrap);

const buscador = document.createElement("input");
buscador.type = "text";
buscador.placeholder = "Buscar tarea...";
buscador.style.flex = "1";
buscadorWrap.appendChild(buscador);

let filtroBusqueda = "";

const limpiarBusquedaBtn = document.createElement("button");
limpiarBusquedaBtn.innerText = "✕";
limpiarBusquedaBtn.title = "Limpiar búsqueda";
limpiarBusquedaBtn.style.padding = "4px 10px";
limpiarBusquedaBtn.style.cursor = "pointer";
limpiarBusquedaBtn.style.display = "none";
buscadorWrap.appendChild(limpiarBusquedaBtn);

buscador.addEventListener("input", () => {
  filtroBusqueda = (buscador.value || "").toLowerCase().trim();
  limpiarBusquedaBtn.style.display = buscador.value ? "inline-block" : "none";
  render();
});

limpiarBusquedaBtn.addEventListener("click", () => {
  buscador.value = "";
  filtroBusqueda = "";
  limpiarBusquedaBtn.style.display = "none";
  buscador.focus();
  render();
});

const seccionItems = document.createElement("section");
seccionItems.classList = "items";
main.appendChild(seccionItems);

// ===================== UTILIDADES (copiar / importar) =====================
const seccionUtilidades = document.createElement("section");
seccionUtilidades.classList = "utilidades";
main.appendChild(seccionUtilidades);

// --- copiar lista ---
const copiarContainer = document.createElement("div");
copiarContainer.classList = "copiar-lista";
seccionUtilidades.appendChild(copiarContainer);

const labelCopiar = document.createElement("label");
labelCopiar.innerText = "Copiar tareas de esta lista";
copiarContainer.appendChild(labelCopiar);

const buttonCopiar = document.createElement("button");
buttonCopiar.innerText = "Copiar tareas";
copiarContainer.appendChild(buttonCopiar);

// --- importar lista ---
const importarContainer = document.createElement("div");
importarContainer.classList = "importar-lista";
seccionUtilidades.appendChild(importarContainer);

const labelImportar = document.createElement("label");
labelImportar.innerText = "Pegar una lista de tareas que te pasaron:";
importarContainer.appendChild(labelImportar);

const textareaImportar = document.createElement("textarea");
textareaImportar.rows = 4;
textareaImportar.placeholder = "Una tarea por línea o separadas por comas...";
importarContainer.appendChild(textareaImportar);

const buttonImportar = document.createElement("button");
buttonImportar.innerText = "Agregar a mis tareas";
importarContainer.appendChild(buttonImportar);

const toastRoot = document.getElementById("toast-root");

// =====================
// Estado
// =====================
let listaItems = [];
let remoteMeta = { updatedAt: 0 };

// Control de cambios locales (evita pisadas por GET de verificación)
let localVersion = 0;

// =====================
// UI helpers
// =====================
function setSync(state, text) {
  syncPill.classList.remove("ok", "saving", "offline");
  if (state) syncPill.classList.add(state);
  syncPill.querySelector(".sync-text").textContent = text;
}

function escapeHtml(s) {
  return (s ?? "").toString()
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toast(msg, type = "ok", small = "") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `${escapeHtml(msg)}${small ? `<div class="small">${escapeHtml(small)}</div>` : ""}`;
  toastRoot.appendChild(el);

  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateY(6px)";
    el.style.transition = "all .2s ease";
  }, 2400);

  setTimeout(() => el.remove(), 2700);
}

// =====================
// Data helpers
// =====================
function ordenarLista(arr) {
  // completados arriba + alfabético
  return arr.sort((a, b) => {
    if (a.completado === b.completado) {
      return a.texto.toLowerCase().localeCompare(b.texto.toLowerCase());
    }
    return (b.completado === true) - (a.completado === true);
  });
}

function normalizarTexto(t) {
  return (t ?? "").toString().trim();
}

function dedupNormalize(items) {
  const seen = new Set();
  const out = [];

  for (const it of items || []) {
    const texto = normalizarTexto(it?.texto);
    if (!texto) continue;

    const key = texto.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    out.push({ texto, completado: !!it?.completado });
  }

  return ordenarLista(out);
}

// =====================
// Cache
// =====================
function loadCache() {
  try {
    const raw = localStorage.getItem(LS_CACHE);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.items)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveCache(items, meta = {}) {
  try {
    localStorage.setItem(LS_CACHE, JSON.stringify({
      items,
      meta: { updatedAt: meta.updatedAt || 0, ts: Date.now() }
    }));
  } catch { }
}

function loadPending() {
  try {
    const raw = localStorage.getItem(LS_PENDING);
    const p = raw ? JSON.parse(raw) : null;
    return Array.isArray(p?.items) ? p : null;
  } catch {
    return null;
  }
}

function setPending(items) {
  try { localStorage.setItem(LS_PENDING, JSON.stringify({ items, ts: Date.now() })); } catch { }
}

function clearPending() {
  try { localStorage.removeItem(LS_PENDING); } catch { }
}

function isOnline() {
  return navigator.onLine !== false;
}

// =====================
// API: JSONP GET (evita CORS sin token)
// =====================
async function apiGetJSONP(action) {
  // 1) Conseguimos token fuera del Promise (acá sí podemos usar await)
  let token = "";
  try {
    token = await ensureOAuthToken(false); // intenta silent si ya hubo consentimiento
  } catch (e) {
    // si todavía no hay token, devolvemos un error controlado
    throw new Error("TOKEN_NEEDS_INTERACTIVE");
  }


  // 2) Luego hacemos el JSONP tradicional
  return new Promise((resolve, reject) => {
    const cbName = "jsonp_cb_" + Date.now() + "_" + Math.floor(Math.random() * 1e6);

    let script = null;
    let timer = null;

    window[cbName] = (data) => {
      cleanup();
      resolve(data);
    };

    const cleanup = () => {
      try { delete window[cbName]; } catch { }
      if (script && script.parentNode) script.parentNode.removeChild(script);
      if (timer) clearTimeout(timer);
    };

    const url =
      `${API_BASE}?action=${encodeURIComponent(action)}` +
      `&access_token=${encodeURIComponent(token)}` +
      `&callback=${encodeURIComponent(cbName)}` +
      `&_=${Date.now()}`;

    script = document.createElement("script");
    script.src = url;
    script.onerror = () => {
      cleanup();
      reject(new Error("JSONP error (URL/deploy)."));
    };

    timer = setTimeout(() => {
      cleanup();
      reject(new Error("JSONP timeout."));
    }, 12000);

    document.body.appendChild(script);
  });
}

// POST no-cors (sin token)
async function apiSet(items) {
  const token = await ensureOAuthToken(true);
  const url = `${API_BASE}?action=set`;
  await fetch(url, {
    method: "POST",
    mode: "no-cors",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ access_token: token, items })
  });
}

// =====================
// Render
// =====================
function render() {
  seccionItems.innerHTML = "";

  const listaFiltrada = !filtroBusqueda
    ? listaItems
    : listaItems.filter(it => it.texto.toLowerCase().includes(filtroBusqueda));

  listaFiltrada.forEach((item) => {
    const index = listaItems.indexOf(item);

    const itemContainer = document.createElement("div");
    itemContainer.classList.add("item-container");

    const tick = document.createElement("input");
    tick.type = "checkbox";
    tick.checked = !!item.completado;

    tick.addEventListener("change", () => {
      item.completado = tick.checked;
      listaItems = dedupNormalize(listaItems);
      localVersion++;
      render();
      scheduleSave("Cambio de estado");
    });

    const listItem = document.createElement("p");
    listItem.innerText = item.texto;

    const botonEliminarItem = document.createElement("button");
    botonEliminarItem.innerText = "Eliminar";
    botonEliminarItem.classList.add("eliminar-item");
    botonEliminarItem.setAttribute("data-index", index);

    itemContainer.appendChild(tick);
    itemContainer.appendChild(listItem);
    itemContainer.appendChild(botonEliminarItem);

    seccionItems.appendChild(itemContainer);
  });
}

// =====================
// CRUD
// =====================
function agregarElemento(texto, completado = false) {
  const t = normalizarTexto(texto);
  if (!t) return;

  const existe = listaItems.some(obj => obj.texto.toLowerCase() === t.toLowerCase());
  if (existe) {
    toast("Esa tarea ya existe", "warn", "No se agregan duplicados.");
    return;
  }

  listaItems.push({ texto: t, completado: !!completado });
  listaItems = dedupNormalize(listaItems);
  localVersion++;
  render();
  scheduleSave("Tarea agregada");
}

function eliminarElemento(index) {
  const item = listaItems[index];
  if (!item) return;

  const ok = confirm(`¿Eliminar "${item.texto}"?`);
  if (!ok) return;

  listaItems.splice(index, 1);
  localVersion++;
  render();
  scheduleSave("Tarea eliminada");
}

// =====================
// Save engine (debounce + offline queue + verify)
// =====================
let saveTimer = null;
let saving = false;

function scheduleSave(reason = "") {
  saveCache(listaItems, remoteMeta);

  if (!isOnline()) {
    setSync("offline", "Sin conexión — Guardado local");
    setPending(listaItems);
    if (reason) toast("Guardado local (offline)", "warn", "Se sincroniza cuando vuelva internet.");
    return;
  }

  setSync("saving", "Guardando…");
  clearTimeout(saveTimer);

  saveTimer = setTimeout(async () => {
    if (saving) return;
    saving = true;

    try {
      const startedVersion = localVersion;

      // Verificación rápida de cuenta/autorización antes de intentar guardar
      try {
        const check = await apiGetJSONP("get");
        if (check?.ok === false && (check?.error === "forbidden" || check?.error === "auth_required")) {
          setSync("offline", "Cuenta no autorizada");
          toast("Cuenta no autorizada", "err", "Tocá Conectar y elegí otra cuenta.");
          return;
        }
      } catch (e) {
        if ((e?.message || "") === "TOKEN_NEEDS_INTERACTIVE") {
          setSync("offline", "Necesita Conectar");
          toast("Necesitás autorizar", "warn", "Tocá el botón Conectar.");
          return;
        }
      }

      await apiSet(listaItems);
      setPending(listaItems);

      const resp = await apiGetJSONP("get");
      const remoteItems = Array.isArray(resp?.items) ? resp.items : [];
      const meta = resp?.meta || { updatedAt: 0 };

      // Si hubo cambios mientras guardábamos, no pisar estado local
      if (localVersion !== startedVersion) {
        remoteMeta = { updatedAt: Number(meta.updatedAt || 0) };
        saveCache(listaItems, remoteMeta);
        setPending(listaItems);
        setSync("saving", "Guardando…");

        saving = false;
        scheduleSave("");
        return;
      }

      listaItems = dedupNormalize(remoteItems);
      remoteMeta = { updatedAt: Number(meta.updatedAt || 0) };
      saveCache(listaItems, remoteMeta);
      clearPending();

      render();
      setSync("ok", "Guardado ✅");
      if (reason) toast("Guardado ✅", "ok", reason);
    } catch (e) {
      setPending(listaItems);

      if ((e?.message || "") === "TOKEN_NEEDS_INTERACTIVE") {
        setSync("offline", "Necesita Conectar");
        toast("Necesitás autorizar", "warn", "Tocá el botón Conectar.");
      } else {
        setSync("offline", "No se pudo guardar — Queda en cola");
        toast("No se pudo guardar", "err", e?.message || "Quedó pendiente, se reintenta solo.");
      }
    } finally {
      saving = false;
    }
  }, 650);
}

async function trySyncPending() {
  if (!isOnline()) {
    setSync("offline", "Sin conexión — Guardado local");
    return;
  }

  const pending = loadPending();
  if (!pending?.items) {
    await refreshFromRemote(false);
    return;
  }

  setSync("saving", "Sincronizando…");
  try {
    listaItems = dedupNormalize(pending.items);
    render();

    await apiSet(listaItems);

    const resp = await apiGetJSONP("get");
    const remoteItems = Array.isArray(resp?.items) ? resp.items : [];
    const meta = resp?.meta || { updatedAt: 0 };

    listaItems = dedupNormalize(remoteItems);
    remoteMeta = { updatedAt: Number(meta.updatedAt || 0) };
    saveCache(listaItems, remoteMeta);
    clearPending();

    render();
    setSync("ok", "Sincronizado ✅");
    toast("Sincronizado ✅", "ok", "Se aplicaron cambios pendientes.");
  } catch (e) {
    if ((e?.message || "") === "TOKEN_NEEDS_INTERACTIVE") {
      setSync("offline", "Necesita Conectar");
      toast("Necesitás autorizar", "warn", "Tocá el botón Conectar.");
      return;
    }
    setSync("offline", "Sincronización pendiente");
  }

}

async function refreshFromRemote(showToast = true) {

  // ✅ Guard: si el usuario cambia algo mientras esperamos el remoto,
  // NO vamos a pisar la lista local cuando llegue el GET.
  const startedVersion = localVersion;


  if (!isOnline()) {
    setSync("offline", "Sin conexión — usando cache");
    return;
  }
  try {
    const resp = await apiGetJSONP("get");

    // Backend auth handling
    if (resp?.ok === false && (resp?.error === "forbidden" || resp?.error === "auth_required")) {
      setSync("offline", "Cuenta no autorizada");
      toast("Cuenta no autorizada", "err", "Elegí otra cuenta para Conectar.");
      // Fuerza selector de cuenta
      try {
        await ensureOAuthToken(true, "select_account");
        // reintenta una vez ya con otra cuenta
        const resp2 = await apiGetJSONP("get");
        if (resp2?.ok === true) {
          listaItems = dedupNormalize(Array.isArray(resp2.items) ? resp2.items : []);
          remoteMeta = { updatedAt: Number(resp2?.meta?.updatedAt || 0) };
          saveCache(listaItems, remoteMeta);
          render();
          setSync("ok", "Listo ✅");
          toast("Conectado ✅", "ok", "Cuenta autorizada.");
        }
      } catch {
        // si cancela, queda en modo offline
      }
      return;
    }

    const remoteItems = Array.isArray(resp?.items) ? resp.items : [];
    const meta = resp?.meta || { updatedAt: 0 };

    // ✅ Si hubo cambios locales mientras cargaba el remoto, NO pisar la lista.
    if (localVersion !== startedVersion) {
      // Igual actualizamos meta para que el cache tenga el updatedAt más nuevo
      remoteMeta = { updatedAt: Number(meta.updatedAt || 0) };
      saveCache(listaItems, remoteMeta);

      setSync("ok", "Cambios locales ✅");
      if (showToast) toast("Cambios locales detectados", "warn", "No se reemplazó tu lista por la versión remota.");
      return;
    }

    listaItems = dedupNormalize(remoteItems);
    remoteMeta = { updatedAt: Number(meta.updatedAt || 0) };
    saveCache(listaItems, remoteMeta);
    render();

    setSync("ok", "Listo ✅");

    if (showToast) toast("Lista actualizada", "ok", "Se cargó desde Drive.");
  } catch (e) {
    if ((e?.message || "") === "TOKEN_NEEDS_INTERACTIVE") {
      setSync("offline", "Necesita Conectar");
      if (showToast) toast("Necesitás autorizar", "warn", "Tocá el botón Conectar.");
      return;
    }

    setSync("offline", "No se pudo cargar — usando cache");
    if (showToast) toast("No se pudo cargar", "warn", "Mostrando la última versión guardada.");
  }
}

// =====================
// Eventos
// =====================
seccionItems.addEventListener("click", (event) => {
  if (event.target.classList.contains("eliminar-item")) {
    const index = parseInt(event.target.getAttribute("data-index"), 10);
    eliminarElemento(index);
  }
});

button1.addEventListener("click", () => {
  const textoItem = input1.value;
  if (normalizarTexto(textoItem) !== "") {
    agregarElemento(textoItem, false);
    input1.value = "";

    buscador.value = "";
    filtroBusqueda = "";
    limpiarBusquedaBtn.style.display = "none";

    input1.focus();
  }
});

input1.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    button1.click();
  }
});

// Copiar
buttonCopiar.addEventListener("click", () => {
  if (listaItems.length === 0) {
    toast("No hay tareas para copiar", "warn");
    return;
  }
  const texto = listaItems.map(item => item.texto).join("\n");
  navigator.clipboard.writeText(texto)
    .then(() => toast("Copiado ✅", "ok", "Lista al portapapeles"))
    .catch(() => toast("No se pudo copiar", "err"));
});

// Importar
buttonImportar.addEventListener("click", () => {
  const textoPegado = textareaImportar.value;

  if (textoPegado.trim() === "") {
    toast("Pegá primero una lista 😉", "warn");
    return;
  }

  let candidatos = textoPegado.includes("\n")
    ? textoPegado.split("\n")
    : textoPegado.split(",");

  candidatos = candidatos.map(t => t.trim()).filter(t => t !== "");

  let agregados = 0;
  for (const t of candidatos) {
    const before = listaItems.length;
    agregarElemento(t, false);
    if (listaItems.length > before) agregados++;
  }

  textareaImportar.value = "";
  toast("Importado ✅", "ok", `${agregados} tareas agregadas`);
});

window.addEventListener("online", () => {
  toast("Volvió la conexión", "ok", "Sincronizando…");
  trySyncPending();
});

window.addEventListener("offline", () => {
  setSync("offline", "Sin conexión — Guardado local");
  toast("Sin conexión", "warn", "Podés seguir usando la lista.");
});

// =====================
// INIT
// =====================
window.addEventListener("load", async () => {
  input1.focus();

  // Esperar GIS y preparar token client
  const waitGIS = () => new Promise((res) => {
    const t = setInterval(() => {
      if (window.google?.accounts?.oauth2) { clearInterval(t); res(); }
    }, 80);
  });

  await waitGIS();
  initOAuth();

  // Si no hay token (ni guardado ni válido), NO intentes sincronizar en background
  // (evita "Sincronizando..." infinito por interaction_required)
  loadStoredOAuth?.(); // si existe la función de token persistente

  if (!isTokenValid()) {
    setSync("offline", "Necesita Conectar");
    // Importante: NO salimos del load, dejamos que renderice cache/pending si hay,
    // pero evitamos el refresh remoto automático.
  }


  // Intentar recuperar token guardado (para no pedir permisos en cada refresh)
  loadStoredOAuth();

  // 1) cache instantáneo
  const cached = loadCache();
  if (cached?.items) {
    listaItems = dedupNormalize(cached.items);
    remoteMeta = cached.meta?.updatedAt ? { updatedAt: cached.meta.updatedAt } : { updatedAt: 0 };
    render();
    setSync(isOnline() ? "saving" : "offline", isOnline() ? "Cargando… (cache)" : "Sin conexión — usando cache");
  } else {
    setSync(isOnline() ? "saving" : "offline", isOnline() ? "Cargando…" : "Sin conexión");
  }

  // 2) pending
  const pending = loadPending();
  if (pending?.items) {
    listaItems = dedupNormalize(pending.items);
    render();
    if (!isOnline()) {
      setSync("offline", "Sin conexión — Cambios pendientes");
    } else {
      await trySyncPending();
    }
    return;
  }

  // 3) remoto (solo si hay token válido)
  if (isTokenValid()) {
    await refreshFromRemote(false);
    if (!cached?.items) toast("Lista lista ✅", "ok", "Cargada desde Drive");
  } else {
    // sin token: quedamos en modo offline hasta que toque "Conectar"
    setSync("offline", "Necesita Conectar");
  }

});
