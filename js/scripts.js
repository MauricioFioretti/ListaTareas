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
const OAUTH_SCOPES =
  "openid email profile " +
  "https://www.googleapis.com/auth/userinfo.email " +
  "https://www.googleapis.com/auth/userinfo.profile " +   // 👈 espacio al final
  "https://www.googleapis.com/auth/drive.metadata.readonly";


async function forceSwitchAccount() {
  // obliga a Google a mostrar el selector de cuenta
  clearStoredOAuth();              // 👈 borra localStorage + memoria
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

    // ✅ evita pedir permisos de nuevo si ya fueron otorgados
    include_granted_scopes: true,

    // ✅ clave en browsers con bloqueo de cookies (Brave, etc.)
    use_fedcm_for_prompt: true,

    callback: () => { }
  });


}

function requestAccessToken({ prompt, hint } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error("popup_timeout_or_closed"));
    }, 45_000);

    oauthTokenClient.callback = (resp) => {
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
    if (hint && hint.includes("@")) opts.hint = hint;
    oauthTokenClient.requestAccessToken(opts);
  });
}

function isTokenValid() {
  return oauthAccessToken && Date.now() < (oauthExpiresAt - 30_000);
}

// Esto intenta silent. Si falla y allowInteractive=true, abre popup.
// Esto intenta silent SIEMPRE primero. Si falla y allowInteractive=true, abre popup.
async function ensureOAuthToken(allowInteractive = false, interactivePrompt = "consent") {
  // 1) si ya está en memoria, OK
  if (isTokenValid()) return oauthAccessToken;

  // 2) si hay token guardado, cargarlo
  loadStoredOAuth();
  if (isTokenValid()) return oauthAccessToken;

  // 3) Refresh "permisivo" tipo Drive XL:
  // - si Google puede autorizar sin preguntar: se cierra solo
  // - si NO puede: puede mostrar chooser (limitación del navegador/cookies)
  try {
    const hintEmail = loadStoredOAuthEmail();
    console.log("[ensureOAuthToken] refresh permissive, hint =", hintEmail);

    const r = await requestAccessToken({
      // ✅ NO mandamos prompt (permite auto-approve si hay sesión)
      prompt: undefined,

      // ✅ clave para evitar chooser cuando se puede
      hint: hintEmail
    });

    if (r?.access_token) {
      oauthAccessToken = r.access_token;
      oauthExpiresAt = Date.now() + (r.expires_in * 1000);
      saveStoredOAuth(oauthAccessToken, oauthExpiresAt);
      return oauthAccessToken;
    }
  } catch (e) {
    console.warn("[ensureOAuthToken] permissive refresh failed:", e?.message || e);
  }

  // 4) Si el llamado fue interactivo (click del usuario), recién ahí popup
  if (allowInteractive) {
    const r = await requestAccessToken({ prompt: interactivePrompt ?? "consent" });
    oauthAccessToken = r.access_token;
    oauthExpiresAt = Date.now() + (r.expires_in * 1000);
    saveStoredOAuth(oauthAccessToken, oauthExpiresAt);
    return oauthAccessToken;
  }

  // 5) No interactivo y silent falló -> pedir conectar
  throw new Error("TOKEN_NEEDS_INTERACTIVE");
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

const LS_OAUTH_EMAIL = "tareas_oauth_email_v1";

function loadStoredOAuthEmail() {
  try { return String(localStorage.getItem(LS_OAUTH_EMAIL) || "").trim().toLowerCase(); }
  catch { return ""; }
}
function saveStoredOAuthEmail(email) {
  try { localStorage.setItem(LS_OAUTH_EMAIL, String(email || "").trim().toLowerCase()); } catch { }
}
function clearStoredOAuthEmail() {
  try { localStorage.removeItem(LS_OAUTH_EMAIL); } catch { }
}

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
  clearStoredOAuthEmail();
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

// --- UI cuenta (estilo Drive XL) ---
const accountPill = document.createElement("div");
accountPill.className = "account-pill";
accountPill.style.marginLeft = "10px";
accountPill.style.opacity = "0.9";
accountPill.style.fontSize = "13px";
accountPill.textContent = ""; // acá va el email
titulo.appendChild(accountPill);

function setAccountUI(email) {
  const e = (email || "").trim();
  if (e) {
    accountPill.textContent = e;
    btnConnect.textContent = "Cambiar cuenta";
    btnConnect.dataset.mode = "switch";
  } else {
    accountPill.textContent = "";
    btnConnect.textContent = "Conectar";
    btnConnect.dataset.mode = "connect";
  }
}


btnConnect.addEventListener("click", async () => {
  try {
    setSync("saving", "Autorizando…");

    // Drive XL behavior:
    // - Si ya estás conectado y tocás el botón -> forzá selector de cuenta
    // - Si no -> conectá normal
    const isSwitch = (btnConnect.dataset.mode === "switch");
    if (isSwitch) {
      await forceSwitchAccount(); // limpia y abre selector (select_account)
    } else {
      // SIEMPRE mostrar selector para evitar quedar pegado a la última cuenta (no autorizada)
      await ensureOAuthToken(true, "consent");
    }


    // 2) VALIDAMOS contra backend (allowlist real)
    const r = await verifyBackendAccessOrThrow();

    // 3) whoami (para mostrar email y guardar hint)
    try {
      const who = await apiGet("whoami");
      if (who?.ok === true && who.email) {
        saveStoredOAuthEmail(who.email);
        setAccountUI(who.email);
        console.log("Email guardado para hint:", who.email);
      } else {
        setAccountUI(loadStoredOAuthEmail());
      }
    } catch {
      setAccountUI(loadStoredOAuthEmail());
    }

    // 4) Si ok:true, cargamos items
    const items = Array.isArray(r.items) ? r.items : [];
    const ua = Number(r?.meta?.updatedAt || 0);

    listaItems = dedupNormalize(items);
    remoteMeta = { updatedAt: ua };
    saveCache(listaItems, remoteMeta);
    render();

    setSync("ok", "Conectado ✅");
    toast("Conectado ✅", "ok", "Cuenta autorizada.");
  } catch (e) {
    const msg = String(e?.message || "");

    if (msg === "TOKEN_NEEDS_INTERACTIVE") {
      setSync("offline", "Necesita Conectar");
      setAccountUI(""); // vuelve a modo Conectar
      toast("Necesitás autorizar", "warn", "Tocá Conectar.");
      return;
    }

    setSync("offline", "No autorizado");
    setAccountUI("");
    toast("No se pudo conectar", "err", msg);
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

async function waitRemoteUpdate(prevUpdatedAt, timeoutMs = 2500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await apiGet("get");
      const ua = Number(r?.meta?.updatedAt || 0);
      if (r?.ok === true && ua > Number(prevUpdatedAt || 0)) return r;
    } catch { }
    await new Promise(res => setTimeout(res, 250));
  }
  return null;
}


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
// API: GET con CORS (sin JSONP)
// =====================
// =====================
// API: GET por JSONP (evita CORS de Apps Script)
// =====================
// =====================
// API (sin token en URL)
// - Usamos POST text/plain para evitar preflight
// - El backend devuelve JSON normal
// =====================

async function apiCall(mode, items) {
  const token = await ensureOAuthToken(false);

  const payload = { mode, access_token: token };
  if (items) payload.items = items;

  const r = await fetch(API_BASE, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" }, // evita preflight
    body: JSON.stringify(payload)
  });

  // Si esto falla, vas a ver el error real (en vez de "opaque")
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("API_NON_JSON_RESPONSE: " + text.slice(0, 200));
  }

}

async function apiGet(mode) {
  return await apiCall(mode);
}

async function apiSet(items) {
  return await apiCall("set", items);
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
        const check = await apiGet("get");
        if (check?.ok === false) {
          if (check?.error === "auth_required") {
            setSync("offline", "Necesita Conectar");
            toast("Necesitás autorizar", "warn", "Tocá el botón Conectar.");
            return;
          }
        }

      } catch (e) {
        if ((e?.message || "") === "TOKEN_NEEDS_INTERACTIVE") {
          setSync("offline", "Necesita Conectar");
          toast("Necesitás autorizar", "warn", "Tocá el botón Conectar.");
          return;
        }
      }

      const prevUA = Number(remoteMeta?.updatedAt || 0);

      await apiSet(listaItems);
      setPending(listaItems);

      // ✅ NO confiar en el GET inmediato: esperar a que updatedAt cambie
      const confirmed = await waitRemoteUpdate(prevUA, 2500);

      if (!confirmed) {
        // No confirmamos a tiempo: NO pisamos tu lista local con vacío
        setSync("ok", "Guardado ✅ (verificando)");
        if (reason) toast("Guardado ✅", "ok", "Pendiente de confirmación del servidor.");
        saveCache(listaItems, remoteMeta);
        // NO borro pending acá para reintentar después automáticamente
        return;
      }

      const remoteItems = Array.isArray(confirmed?.items) ? confirmed.items : [];
      const ua = Number(confirmed?.meta?.updatedAt || 0);
      const meta = { updatedAt: ua };


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

    const prevUA = Number(remoteMeta?.updatedAt || 0);

    await apiSet(listaItems);

    // ✅ Esperar confirmación del server (updatedAt cambia)
    const confirmed = await waitRemoteUpdate(prevUA, 2500);

    if (!confirmed) {
      setSync("ok", "Sincronizado ✅ (verificando)");
      toast("Sincronizado ✅", "ok", "Pendiente confirmación del servidor.");
      return;
    }

    const remoteItems = Array.isArray(confirmed?.items) ? confirmed.items : [];
    const meta = { updatedAt: Number(confirmed?.meta?.updatedAt || 0) };

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
  const startedVersion = localVersion;

  if (!isOnline()) {
    setSync("offline", "Sin conexión — usando cache");
    return;
  }

  try {
    const resp = await apiGet("get");
    console.log("RESP BACKEND:", resp);

    if (resp?.ok !== true) {
      const err = String(resp?.error || "");

      if (err === "auth_required") {
        setSync("offline", "Necesita Conectar");
        toast("Necesitás autorizar", "warn", "Tocá el botón Conectar.");
        // NO borrar token acá
        return;
      }

      setSync("offline", "Error backend");
      toast("Error backend", "err", err || "unknown");
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
  const waitGIS = (timeoutMs = 15000) => new Promise((res, rej) => {
    const start = Date.now();
    const t = setInterval(() => {
      if (window.google?.accounts?.oauth2) { clearInterval(t); res(); }
      if (Date.now() - start > timeoutMs) { clearInterval(t); rej(new Error("GIS_LOAD_TIMEOUT")); }
    }, 80);
  });

  try {
    await waitGIS();
    initOAuth();
  } catch (e) {
    setSync("offline", "No cargó Google Auth");
    toast("No cargó Google Auth", "err", "Revisá que esté incluido el script de GIS.");
    return;
  }


  // Si no hay token (ni guardado ni válido), NO intentes sincronizar en background
  // (evita "Sincronizando..." infinito por interaction_required)
  loadStoredOAuth?.(); // si existe la función de token persistente

  // UI: si tenías email guardado, mostrálalo como en Drive XL
  setAccountUI(loadStoredOAuthEmail());


  if (!isTokenValid()) {
    setSync("offline", "Necesita Conectar");
    // Importante: NO salimos del load, dejamos que renderice cache/pending si hay,
    // pero evitamos el refresh remoto automático.
  }

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
    // UI conectado (si tenés email guardado)
    const em = loadStoredOAuthEmail();
    if (em) {
      setAccountUI(em);
      setSync("ok", "Conectado ✅");
    }
    await refreshFromRemote(false);
    if (!cached?.items) toast("Lista lista ✅", "ok", "Cargada desde Drive");
  } else {
    // sin token: quedamos en modo offline hasta que toque "Conectar"
    setSync("offline", "Necesita Conectar");
  }

  // =====================
  // Auto-refresh proactivo del token (estilo "sesión infinita")
  // =====================
  let tokenRefreshTimer = null;

  function startTokenAutoRefresh() {
    if (tokenRefreshTimer) clearInterval(tokenRefreshTimer);

    tokenRefreshTimer = setInterval(async () => {
      try {
        // Solo intentar si hay algo que refrescar
        if (!oauthAccessToken) return;

        // Solo si la pestaña está visible (reduce chance de bloqueos)
        if (document.visibilityState !== "visible") return;

        // Si falta menos de 2 minutos, refrescar
        const msLeft = oauthExpiresAt - Date.now();
        if (msLeft > 120_000) return;

        console.log("[token] proactive refresh, msLeft:", msLeft);

        // Refresh permisivo (puede abrir popup "espera un momento..." y cerrarse solo)
        await ensureOAuthToken(false);

      } catch (e) {
        // Si no pudo, NO forzamos nada acá. Se verá como "Necesita Conectar" cuando toque API.
        console.warn("[token] proactive refresh failed:", e?.message || e);
      }
    }, 20_000); // chequea cada 20s
  }

  // arrancar auto refresh
  startTokenAutoRefresh();

  // DEBUG: forzar expiración para probar refresh silencioso
  window.__expireTokenNow = () => {
    oauthExpiresAt = Date.now() - 1000;
    saveStoredOAuth(oauthAccessToken, oauthExpiresAt);
    console.log("Token forzado a expirar.");
  };


});
