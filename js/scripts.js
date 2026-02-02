// ================== CONFIG (Sheets API directo) ==================
// ✅ Spreadsheet de "Lista tareas"
const SPREADSHEET_ID = "1pDZcf3ca_6_3pDolWWCY4P0132sv9VVjRSL6O6-EIo0";

// ✅ Meta cell (para control de versiones tipo "Lista de compras")
const META_CELL_A1 = "Z1";

// ✅ GID de la hoja (lo que viene en la URL: ...edit?gid=XXXX)
const SHEET_GID = 1308790294;

// Cache del título de hoja resuelto desde el GID (evita pedir metadata siempre)
const LS_SHEET_TITLE = "lista_tareas_sheet_title_v1";

// Cache de datos para render instantáneo
const LS_CACHE_DATA = "lista_tareas_cache_data_v1";
const LS_CACHE_TS   = "lista_tareas_cache_ts_v1";

// TTL cache (ej: 60s). Ajustalo si querés.
const CACHE_TTL_MS = 60_000;

// =====================
// CONFIG OAUTH (Google Identity Services)
// =====================
// ⚠️ Usá tu OAuth Client ID (tipo "Web application") del Google Cloud Console
const OAUTH_CLIENT_ID = "917192108969-6d693ji2l5ku1vsje8s6brvio2j01hio.apps.googleusercontent.com";


// scope mínimo para identificar al usuario (email)
const OAUTH_SCOPES =
  "openid email profile " +
  "https://www.googleapis.com/auth/userinfo.email " +
  "https://www.googleapis.com/auth/userinfo.profile " +
  // ✅ necesario para leer/escribir la planilla directo (Sheets API)
  "https://www.googleapis.com/auth/spreadsheets " +
  // ✅ opcional (lo dejás si tu backend usa allowlist con drive metadata)
  "https://www.googleapis.com/auth/drive.metadata.readonly";

  // ================== SHEETS API HELPERS (rápido) ==================

// Resuelve el título real de la pestaña usando el SHEET_GID (sheetId)
// y lo guarda en localStorage para no pedirlo siempre.
async function resolveSheetTitleFromGid_(accessToken) {
  // 1) cache
  try {
    const cached = (localStorage.getItem(LS_SHEET_TITLE) || "").trim();
    if (cached) return cached;
  } catch {}

  // 2) pedir metadata mínima
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}` +
    `?fields=sheets(properties(sheetId,title))`;

  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const txt = await r.text();
  if (!r.ok) throw new Error("sheet_meta_failed: " + txt.slice(0, 300));

  const json = JSON.parse(txt);
  const sheets = Array.isArray(json?.sheets) ? json.sheets : [];

  const found = sheets.find(s => Number(s?.properties?.sheetId) === Number(SHEET_GID));
  const title = (found?.properties?.title || "").toString().trim();
  if (!title) throw new Error("sheet_title_not_found_for_gid");

  try { localStorage.setItem(LS_SHEET_TITLE, title); } catch {}
  return title;
}

// Lee headers + datos en 1 request (batchGet)
async function sheetsBatchGet_(accessToken, sheetTitle) {
  const sheetEsc = encodeURIComponent(sheetTitle);

  // Row 1 = headers; Row 2.. = data
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}` +
    `/values:batchGet?ranges=${sheetEsc}!1:1&ranges=${sheetEsc}!2:9999&majorDimension=ROWS`;

  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  const txt = await r.text();
  if (!r.ok) throw new Error("list_failed: " + txt.slice(0, 400));

  const json = JSON.parse(txt);
  const ranges = Array.isArray(json?.valueRanges) ? json.valueRanges : [];

  const headerValues = ranges?.[0]?.values?.[0] || [];
  const dataValues = ranges?.[1]?.values || [];

  const headers = headerValues.map(h => (h || "").toString().trim());
  return { headers, rows: dataValues };
}

// Convierte rows -> objetos según headers
function rowsToObjects_(headers, rows) {
  const out = [];
  const safeHeaders = (headers || []).map(h => (h || "").toString().trim());

  for (let i = 0; i < (rows || []).length; i++) {
    const r = rows[i];
    if (!Array.isArray(r)) continue;

    // si está totalmente vacía, saltearla
    const hasAny = r.some(c => (c || "").toString().trim() !== "");
    if (!hasAny) continue;

    const obj = {};
    for (let j = 0; j < safeHeaders.length; j++) {
      const h = safeHeaders[j];
      if (!h) continue;
      obj[h] = (r[j] ?? "").toString();
    }

    // ✅ fila real en sheet: data empieza en fila 2
    obj.__rowNumber = 2 + i;

    out.push(obj);
  }
  return out;
}

// Cache local: guardar/leer
function cacheRead_() {
  try {
    const ts = Number(localStorage.getItem(LS_CACHE_TS) || "0");
    const raw = localStorage.getItem(LS_CACHE_DATA);
    if (!raw) return null;
    return { ts, data: JSON.parse(raw) };
  } catch {
    return null;
  }
}
function cacheWrite_(data) {
  try {
    localStorage.setItem(LS_CACHE_DATA, JSON.stringify(data));
    localStorage.setItem(LS_CACHE_TS, String(Date.now()));
  } catch {}
}

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

async function fetchUserEmailFromToken(token) {
  try {
    const r = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!r.ok) return "";
    const data = await r.json();
    return String(data?.email || "").trim().toLowerCase();
  } catch {
    return "";
  }
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
  const hadStored = loadStoredOAuth();
  if (isTokenValid()) return oauthAccessToken;

  const hintEmail = loadStoredOAuthEmail();

  // ✅ CORTE: si NO es interactivo y NO había nada guardado, NO llames GIS
  if (!allowInteractive && !hadStored && !hintEmail) {
    throw new Error("TOKEN_NEEDS_INTERACTIVE");
  }

  // 3) Silent real (prompt:"")
  try {
    console.log("[ensureOAuthToken] silent refresh, hint =", hintEmail);

    const r = await requestAccessToken({
      prompt: "",                 // ✅ silent real estilo Drive XL
      hint: hintEmail || undefined
    });

    if (r?.access_token) {
      oauthAccessToken = r.access_token;
      oauthExpiresAt = Date.now() + (r.expires_in * 1000);
      saveStoredOAuth(oauthAccessToken, oauthExpiresAt);

      // 🔑 Guardar email como hint (no depende de backend)
      const em = await fetchUserEmailFromToken(oauthAccessToken);
      if (em) saveStoredOAuthEmail(em);

      return oauthAccessToken;
    }
  } catch (e) {
    console.warn("[ensureOAuthToken] silent refresh failed:", e?.message || e);
  }

  // 4) Interactivo
  if (allowInteractive) {
    const r = await requestAccessToken({ prompt: interactivePrompt ?? "consent" });
    oauthAccessToken = r.access_token;
    oauthExpiresAt = Date.now() + (r.expires_in * 1000);
    saveStoredOAuth(oauthAccessToken, oauthExpiresAt);

    // 🔑 también acá
    const em = await fetchUserEmailFromToken(oauthAccessToken);
    if (em) saveStoredOAuthEmail(em);

    return oauthAccessToken;
  }

  throw new Error("TOKEN_NEEDS_INTERACTIVE");
}

// =====================
// Local cache/offline keys (tareas)
// =====================
const LS_CACHE = "tareas_drive_cache_v1";
const LS_PENDING = "tareas_drive_pending_v1";

const LS_TOMBSTONES = "tareas_drive_tombstones_v1";

// borrados intencionales por el usuario (para que el merge no los re-agregue)
function loadTombstones() {
  try {
    const raw = localStorage.getItem(LS_TOMBSTONES);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set((arr || []).map(x => String(x || "").toLowerCase()).filter(Boolean));
  } catch {
    return new Set();
  }
}
function saveTombstones(set) {
  try { localStorage.setItem(LS_TOMBSTONES, JSON.stringify([...set])); } catch { }
}
function clearTombstones() {
  try { localStorage.removeItem(LS_TOMBSTONES); } catch { }
}


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
// UI construir estructura (HEADER 2-LINEAS)
// =====================
const header = document.querySelector("header");

// contenedor principal del header
const titulo = document.createElement("section");
titulo.classList = "titulo";
header.appendChild(titulo);

// ----- fila 1: título -----
const headerRow1 = document.createElement("div");
headerRow1.className = "header-row header-row-1";
titulo.appendChild(headerRow1);

const h1 = document.createElement("h1");
h1.innerText = "Lista de Tareas";
headerRow1.appendChild(h1);

// ----- fila 2: controles -----
const headerRow2 = document.createElement("div");
headerRow2.className = "header-row header-row-2";
titulo.appendChild(headerRow2);

// estado sync
const syncPill = document.createElement("div");
syncPill.className = "sync-pill";
syncPill.innerHTML = `<span class="sync-dot"></span><span class="sync-text">Cargando…</span>`;
headerRow2.appendChild(syncPill);

// botones (agrupados)
const headerActions = document.createElement("div");
headerActions.className = "header-actions";
headerRow2.appendChild(headerActions);

const btnConnect = document.createElement("button");
btnConnect.className = "btn-connect";
btnConnect.textContent = "Conectar";
btnConnect.dataset.mode = "connect";
headerActions.appendChild(btnConnect);

// --- Botón refresh/reintento (estilo Drive XL) ---
const btnRefresh = document.createElement("button");
btnRefresh.className = "btn-refresh";
btnRefresh.textContent = "↻";
btnRefresh.title = "Reintentar conexión / Refrescar";
btnRefresh.style.display = "none"; // solo aparece cuando hace falta
headerActions.appendChild(btnRefresh);

// email (a la derecha, con truncado)
const accountPill = document.createElement("div");
accountPill.className = "account-pill";
accountPill.textContent = "";
headerRow2.appendChild(accountPill);

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

// Click: reintentar conexión + refresh sin selector de cuenta (silent first)
btnRefresh.addEventListener("click", async () => {
  await reconnectAndRefresh({ showToast: true });
});

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

    // 2) (rápido) Validación directa: email desde token (sin backend)
    const em = await fetchUserEmailFromToken(oauthAccessToken);
    if (em) {
      saveStoredOAuthEmail(em);
      setAccountUI(em);
      console.log("Email guardado para hint:", em);
    } else {
      setAccountUI(loadStoredOAuthEmail());
    }

    // 3) (ya seteado) email desde token (sin backend)
    //    No hacemos whoami acá para evitar latencia

    // 4) Conectado OK → ahora sí cargamos la lista real desde Sheets (rápido)
    await refreshFromRemote(true);

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
let tombstones = loadTombstones();

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

  // Mostrar refresh solo cuando estamos "offline / necesita conectar"
  const needs = (state === "offline") && /necesita conectar/i.test(String(text || ""));
  if (btnRefresh) btnRefresh.style.display = needs ? "inline-block" : "none";
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
// Sheets -> items {texto, completado}
// =====================
function sheetsObjectsToListaItems_(objs) {
  // objs: [{Texto:"...", Completado:"TRUE", ...}, ...]
  // soporta distintos nombres de columnas
  const out = [];

  for (const o of (objs || [])) {
    // posibles nombres para texto
    const texto =
      (o?.texto ?? o?.Texto ?? o?.Tarea ?? o?.tarea ?? o?.Item ?? o?.item ?? "").toString().trim();

    if (!texto) continue;

    // posibles nombres para completado
    const rawDone =
      (o?.completado ?? o?.Completado ?? o?.done ?? o?.Done ?? o?.Estado ?? o?.estado ?? "").toString().trim().toLowerCase();

    const completado =
      rawDone === "true" || rawDone === "1" || rawDone === "sí" || rawDone === "si" || rawDone === "x" || rawDone === "checked";

    out.push({ texto, completado });
  }

  return dedupNormalize(out);
}

function keyOf(texto) {
  return normalizarTexto(texto).toLowerCase();
}

function mergeRemoteWithLocal(remoteItems, localItems, tombstonesSet) {
  const map = new Map(); // key -> {texto, completado}

  // 1) base: remoto
  for (const it of (remoteItems || [])) {
    const texto = normalizarTexto(it?.texto);
    if (!texto) continue;
    const k = keyOf(texto);
    if (tombstonesSet?.has(k)) continue;
    map.set(k, { texto, completado: !!it?.completado });
  }

  // 2) overlay: local (gana local)
  for (const it of (localItems || [])) {
    const texto = normalizarTexto(it?.texto);
    if (!texto) continue;
    const k = keyOf(texto);
    if (tombstonesSet?.has(k)) continue;
    map.set(k, { texto, completado: !!it?.completado });
  }

  return dedupNormalize([...map.values()]);
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
// API (Sheets API directo) ✅ (como Lista de Compras)
// - get: lee A2:B + meta Z1
// - set: escribe A2:B + meta Z1 con control de conflicto por updatedAt
// =====================

async function fetchJson_(url, token, options = {}) {
  const r = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    },
    cache: "no-store"
  });

  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}

  return { r, status: r.status, url, text, json };
}

function classifyGoogleApiError_(resp) {
  const status = Number(resp?.status || 0);
  const msg = String(resp?.json?.error?.message || resp?.text || "").toLowerCase();

  if (status === 401) return { error: "auth_required" };

  if (status === 403) {
    if (
      msg.includes("insufficient authentication scopes") ||
      msg.includes("access_token_scope_insufficient") ||
      msg.includes("insufficientpermissions")
    ) return { error: "missing_scope" };

    return { error: "permission_denied" };
  }

  if (status === 404) return { error: "not_found_or_no_access" };

  return { error: "http_" + status };
}

// Convierte valores A2:B -> listaItems
function valuesToItems_(values) {
  const rows = Array.isArray(values) ? values : [];
  return rows
    .filter(row => (row?.[0] || "").toString().trim() !== "")
    .map(row => ({
      texto: (row?.[0] || "").toString(),
      completado:
        String(row?.[1] || "").toLowerCase().trim() === "true" ||
        String(row?.[1] || "").trim() === "1"
    }));
}

// Lee items + meta (batchGet)
async function sheetsGet_(token) {
  // Resolver título desde GID (cacheado por tu función existente)
  const sheetTitle = await resolveSheetTitleFromGid_(token);
  const sheetEsc = encodeURIComponent(sheetTitle);

  const rangeItems = `${sheetTitle}!A2:B`;
  const rangeMeta = `${sheetTitle}!${META_CELL_A1}`;

  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}` +
    `/values:batchGet?ranges=${encodeURIComponent(rangeItems)}&ranges=${encodeURIComponent(rangeMeta)}` +
    `&majorDimension=ROWS`;

  const resp = await fetchJson_(url, token);
  if (!resp?.r?.ok) {
    const cls = classifyGoogleApiError_(resp);
    return { ok: false, error: cls.error, status: resp.status, url: resp.url, detail: String(resp.text || "").slice(0, 1200) };
  }

  const vr = Array.isArray(resp?.json?.valueRanges) ? resp.json.valueRanges : [];
  const itemsValues = Array.isArray(vr?.[0]?.values) ? vr[0].values : [];
  const metaValues  = Array.isArray(vr?.[1]?.values) ? vr[1].values : [];

  const updatedAt = Number(metaValues?.[0]?.[0] || 0);
  const items = valuesToItems_(itemsValues);

  return { ok: true, items, meta: { updatedAt, count: items.length } };
}

// Escribe toda la lista A2:B + Z1 (batchUpdate)
// expectedUpdatedAt: si no coincide => conflict
async function sheetsSet_(token, items, expectedUpdatedAt = 0) {
  const sheetTitle = await resolveSheetTitleFromGid_(token);

  // 1) leer meta actual (solo Z1) para conflicto rápido
  const urlMeta =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}` +
    `/values/${encodeURIComponent(sheetTitle + "!" + META_CELL_A1)}?majorDimension=ROWS`;

  const metaResp = await fetchJson_(urlMeta, token);
  if (!metaResp?.r?.ok) {
    const cls = classifyGoogleApiError_(metaResp);
    return { ok: false, error: cls.error, status: metaResp.status, detail: String(metaResp.text || "").slice(0, 1000) };
  }

  const remoteUA = Number(metaResp?.json?.values?.[0]?.[0] || 0);
  if (Number(expectedUpdatedAt || 0) !== remoteUA) {
    // conflicto: devolvemos remoto completo para merge (como en Compras)
    const full = await sheetsGet_(token);
    if (full?.ok) {
      return { ok: false, error: "conflict", items: full.items, meta: full.meta };
    }
    return { ok: false, error: "conflict", items: [], meta: { updatedAt: remoteUA, count: 0 } };
  }

  // 2) normalizar/dedup/ordenar (misma idea que Compras)
  let clean = (items || [])
    .map(it => ({ texto: (it?.texto || "").toString().trim(), completado: !!it?.completado }))
    .filter(it => it.texto !== "");

  const seen = new Set();
  clean = clean.filter(it => {
    const k = it.texto.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  clean.sort((a, b) => {
    if (a.completado === b.completado) return a.texto.toLowerCase().localeCompare(b.texto.toLowerCase());
    return (b.completado === true) - (a.completado === true);
  });

  if (clean.length === 0) return { ok: false, error: "empty_list_blocked" };

  // 3) preparar values
  // Para limpiar sobrantes, leemos count remoto (del get rápido) una vez
  const before = await sheetsGet_(token);
  const remoteCount = Number(before?.meta?.count || 0);

  const nextUA = Date.now();
  const maxLen = Math.max(remoteCount, clean.length);

  const values = [];
  for (let i = 0; i < maxLen; i++) {
    if (i < clean.length) values.push([clean[i].texto, clean[i].completado ? "TRUE" : "FALSE"]);
    else values.push(["", ""]);
  }

  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}` +
    `/values:batchUpdate`;

  const body = {
    valueInputOption: "USER_ENTERED",
    data: [
      { range: `${sheetTitle}!A2:B`, majorDimension: "ROWS", values },
      { range: `${sheetTitle}!${META_CELL_A1}`, majorDimension: "ROWS", values: [[String(nextUA)]] }
    ]
  };

  const resp2 = await fetchJson_(url, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!resp2?.r?.ok) {
    const cls = classifyGoogleApiError_(resp2);
    return { ok: false, error: cls.error, status: resp2.status, detail: String(resp2.text || "").slice(0, 1200) };
  }

  return { ok: true, saved: clean.length, meta: { updatedAt: nextUA, count: clean.length } };
}

// Interfaz “apiCall/apiGet/apiSet” para que el resto de tu código cambie lo mínimo
async function apiCall(mode, items, extra = {}, { allowInteractive = false } = {}) {
  // 1) token
  const token = await ensureOAuthToken(allowInteractive, allowInteractive ? "consent" : "consent");

  // 2) modos
  const m = String(mode || "").toLowerCase();

  if (m === "get") {
    return await sheetsGet_(token);
  }

  if (m === "set") {
    const expected = Number(extra?.expectedUpdatedAt || 0);
    return await sheetsSet_(token, items, expected);
  }

  if (m === "whoami") {
    // (sin backend) email desde userinfo
    try {
      const r = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { Authorization: `Bearer ${token}` }
      });
      const j = await r.json();
      return { ok: true, email: String(j?.email || "").trim().toLowerCase() };
    } catch {
      return { ok: false, error: "whoami_failed" };
    }
  }

  return { ok: false, error: "bad_mode" };
}

async function apiGet(mode) {
  return await apiCall(mode);
}

async function apiSet(items, expectedUpdatedAt = 0, { allowInteractive = false } = {}) {
  if (!Array.isArray(items)) throw new Error("apiSet_invalid_items");
  if (items.length === 0) throw new Error("apiSet_empty_blocked");

  return await apiCall(
    "set",
    items,
    { expectedUpdatedAt: Number(expectedUpdatedAt || 0) },
    { allowInteractive: !!allowInteractive }
  );
}

// Ya no hay backend real que validar; dejamos función “compatible” por si la llamás
async function verifyBackendAccessOrThrow() {
  const r = await apiCall("whoami", null, {}, { allowInteractive: true });
  if (r?.ok === true) return r;
  throw new Error(String(r?.error || "auth_required"));
}

// =====================
// Reconnect / Refresh (silent-first)
// =====================
let reconnecting = false;

async function reconnectAndRefresh({ showToast = true } = {}) {
  if (reconnecting) return;
  reconnecting = true;

  try {
    setSync("saving", "Reconectando…");

    // 1) Intento SILENT (no popup)
    await ensureOAuthToken(false);

    // 2) Email desde token (sin backend)
    const em = await fetchUserEmailFromToken(oauthAccessToken);
    if (em) {
      saveStoredOAuthEmail(em);
      setAccountUI(em);
    } else {
      setAccountUI(loadStoredOAuthEmail());
    }

    // 3) Traer lista real (Sheets API)
    await refreshFromRemote(false);

    setSync("ok", "Conectado ✅");
    if (showToast) toast("Conectado ✅", "ok", "Reconexión automática.");
  } catch (e) {
    const msg = String(e?.message || "");

    if (msg === "TOKEN_NEEDS_INTERACTIVE") {
      setSync("offline", "Necesita Conectar");
      if (showToast) toast("Necesitás autorizar", "warn", "Tocá Conectar.");
      return;
    }

    setSync("offline", "Necesita Conectar");
    if (showToast) toast("No se pudo reconectar", "err", msg);
  } finally {
    reconnecting = false;
  }
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

  // si el usuario re-agrega algo que había borrado, se “perdona” el tombstone
  const k = keyOf(t);
  if (tombstones.has(k)) {
    tombstones.delete(k);
    saveTombstones(tombstones);
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

  // tombstone: borrado intencional (para que el merge no lo re-agregue)
  tombstones.add(keyOf(item.texto));
  saveTombstones(tombstones);


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

// =====================
// Auto-retry sync pending (backoff) ✅ (igual que Lista de compras)
// =====================
let retryTimer = null;
let retryDelayMs = 2000;
const RETRY_MAX_MS = 60000;

function resetRetry() {
  retryDelayMs = 2000;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

async function scheduleRetry(label = "") {
  // si ya hay un retry programado, no duplicar
  if (retryTimer) return;

  // si no hay pending real, no programes nada
  const p = loadPending();
  if (!p?.items) return;

  // no reintentar si no hay condiciones mínimas
  if (!isOnline()) return;
  if (saving) return;

  // intento silencioso de token; si no se puede, cortamos (evita loops)
  if (!isTokenValid()) {
    try {
      await ensureOAuthToken(false);
    } catch (e) {
      // si necesita interacción, no insistir
      setSync("offline", "Necesita Conectar");
      return;
    }
  }

  if (!isTokenValid()) return;

  retryTimer = setTimeout(async () => {
    retryTimer = null;
    try {
      await trySyncPending();

      // si sigue pendiente, backoff y reintento
      if (loadPending()?.items) {
        retryDelayMs = Math.min(Math.floor(retryDelayMs * 1.7), RETRY_MAX_MS);
        scheduleRetry("retry_loop");
      } else {
        resetRetry();
      }
    } catch {
      retryDelayMs = Math.min(Math.floor(retryDelayMs * 1.7), RETRY_MAX_MS);
      scheduleRetry("retry_loop_err");
    }
  }, retryDelayMs);
}

function scheduleSave(reason = "") {
  // guardamos cache SIEMPRE (UI instantánea)
  saveCache(listaItems, remoteMeta);

  // offline => cola
  if (!isOnline()) {
    setSync("offline", "Sin conexión — Guardado local");
    setPending(listaItems);
    if (reason) toast("Guardado local (offline)", "warn", "Se sincroniza cuando vuelva internet.");
    return;
  }

  // Intento silencioso de token (no popup) para no bloquear el click
  if (!isTokenValid()) {
    ensureOAuthToken(false).catch(() => { /* noop */ });
  }

  // si sigue sin token válido, queda en pending
  if (!isTokenValid()) {
    setSync("offline", "Necesita Conectar");
    setPending(listaItems);
    if (reason) toast("Guardado local", "warn", "Conectá para sincronizar.");
    return;
  }

  // UI feedback inmediato
  setSync("saving", "Guardando…");
  clearTimeout(saveTimer);

  saveTimer = setTimeout(async () => {
    if (saving) return;
    saving = true;

    // ✅ Snapshot LOCAL (para guardar) + versión al inicio
    const startedVersion = localVersion;
    const localSnapshot = dedupNormalize(listaItems); // lo que queremos persistir

    try {
      // ✅ OPTIMISTIC SAVE (igual que Lista de compras):
      // usamos updatedAt que ya tenemos; si está viejo => conflict y re-merge
      const expectedUA = Number(remoteMeta?.updatedAt || 0);

      // merge “seguro” sin remoto (si hay conflicto, re-mergeamos con remoto real)
      // OJO: usamos snapshot, no listaItems viva
      const merged = mergeRemoteWithLocal([], localSnapshot, tombstones);

      if (merged.length === 0) {
        setPending(listaItems);
        setSync("offline", "No se guardó (lista vacía bloqueada)");
        toast("Bloqueado", "warn", "No se permite guardar una lista vacía por seguridad.");
        return;
      }

      // 1er intento (sin popup)
      let saved = await apiSet(merged, expectedUA, { allowInteractive: false });

      // conflicto => backend nos devuelve items + meta actual, re-merge y reintento 1 vez
      if (saved?.ok === false && saved?.error === "conflict") {
        const remoteItemsNow = Array.isArray(saved?.items) ? saved.items : [];
        const remoteUA = Number(saved?.meta?.updatedAt || 0);

        const merged2 = mergeRemoteWithLocal(remoteItemsNow, localSnapshot, tombstones);
        const saved2 = await apiSet(merged2, remoteUA, { allowInteractive: false });

        if (saved2?.ok !== true) throw new Error(String(saved2?.error || "save_failed"));

        saved = saved2;

        // ✅ IMPORTANTE:
        // NO asignamos listaItems acá todavía (para no pisar clicks nuevos)
        // Solo guardamos el "resultado final que se guardó"
        var finalSavedItems = dedupNormalize(merged2);
      } else {
        if (saved?.ok !== true) {
          if (saved?.error === "auth_required") throw new Error("TOKEN_NEEDS_INTERACTIVE");
          throw new Error(String(saved?.error || "save_failed"));
        }

        // también: no tocar listaItems todavía
        var finalSavedItems = dedupNormalize(merged);
      }

      // ✅ CLAVE (igual que Lista de compras):
      // si hubo cambios mientras guardábamos, NO pisar estado local
      if (localVersion !== startedVersion) {
        setPending(listaItems);          // dejamos la versión más nueva en cola
        setSync("saving", "Guardando…");
        saving = false;
        scheduleSave("");                // reintenta con lo último
        return;
      }

      // ✅ Recién ahora podemos aplicar normalización local (sin perder clicks)
      listaItems = finalSavedItems;

      // éxito: actualizar meta desde backend
      remoteMeta = { updatedAt: Number(saved?.meta?.updatedAt || remoteMeta?.updatedAt || 0) };

      // ya aplicamos borrados al remoto => limpiamos tombstones
      tombstones.clear();
      saveTombstones(tombstones);

      saveCache(listaItems, remoteMeta);
      clearPending();

      render();
      setSync("ok", "Guardado ✅");
      if (reason) toast("Guardado ✅", "ok", reason);

    } catch (e) {
      setPending(listaItems);

      const msg = String(e?.message || "");

      if (msg === "TOKEN_NEEDS_INTERACTIVE") {
        setSync("offline", "Necesita Conectar");
        toast("Necesitás autorizar", "warn", "Tocá el botón Conectar.");
      } else {
        setSync("offline", "No se pudo guardar — Queda en cola");
        toast("No se pudo guardar", "err", msg || "Quedó pendiente.");
        // ✅ reintento automático como Lista de compras (lo agregamos en el CAMBIO 2)
        scheduleRetry("save_failed");
      }

    } finally {
      saving = false;
    }

  }, 250); // ✅ más “instantáneo” (en compras lo sentís rápido). Ajustable.
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

    const before = await apiGet("get");
    if (before?.ok !== true) {
      if (before?.error === "auth_required") throw new Error("TOKEN_NEEDS_INTERACTIVE");
      throw new Error(String(before?.error || "precheck_failed"));
    }

    const remoteItemsNow = Array.isArray(before?.items) ? before.items : [];
    const remoteUA_now = Number(before?.meta?.updatedAt || 0);

    // merge remoto + pending/local, menos tombstones
    const merged = mergeRemoteWithLocal(remoteItemsNow, listaItems, tombstones);

    let saved = await apiSet(merged, remoteUA_now);
    if (saved?.ok === false && saved?.error === "conflict") {
      const remote2 = Array.isArray(saved?.items) ? saved.items : [];
      const ua2 = Number(saved?.meta?.updatedAt || 0);
      const merged2 = mergeRemoteWithLocal(remote2, listaItems, tombstones);
      saved = await apiSet(merged2, ua2);
    }
    if (saved?.ok !== true) throw new Error(String(saved?.error || "save_failed"));

    listaItems = merged;
    render();

    tombstones.clear();
    saveTombstones(tombstones);

    remoteMeta = { updatedAt: Number(saved?.meta?.updatedAt || remoteUA_now || 0) };
    saveCache(listaItems, remoteMeta);
    clearPending();

    setSync("ok", "Sincronizado ✅");
    toast("Sincronizado ✅", "ok", "Se aplicaron cambios pendientes.");
    return;

  } catch (e) {
    if ((e?.message || "") === "TOKEN_NEEDS_INTERACTIVE") {
      setSync("offline", "Necesita Conectar");
      toast("Necesitás autorizar", "warn", "Tocá el botón Conectar.");
      return;
    }
    setSync("offline", "Sincronización pendiente");

    // ✅ reintento automático con backoff
    scheduleRetry("trySyncPending_failed");
  }

}

async function refreshFromRemote(showToast = true) {
  const startedVersion = localVersion;

  if (!isOnline()) {
    setSync("offline", "Sin conexión — usando cache");
    return;
  }

  try {
    // ✅ Traer remoto + meta REAL (Z1)
    const resp = await apiCall("get", null, {}, { allowInteractive: false });

    if (!resp?.ok) {
      if (resp?.error === "auth_required") throw new Error("TOKEN_NEEDS_INTERACTIVE");
      throw new Error(String(resp?.error || "get_failed"));
    }

    const remoteItems = Array.isArray(resp?.items) ? resp.items : [];
    const meta = resp?.meta || { updatedAt: 0 };

    // ✅ Si hubo cambios locales mientras cargaba, no pisar UI
    if (localVersion !== startedVersion) {
      remoteMeta = { updatedAt: Number(meta.updatedAt || 0) };
      saveCache(listaItems, remoteMeta);
      setSync("ok", "Cambios locales ✅");
      if (showToast) toast("Cambios locales detectados", "warn", "No se reemplazó tu lista por la versión remota.");
      return;
    }

    // merge remoto - tombstones (como ya hacías)
    listaItems = mergeRemoteWithLocal(remoteItems, [], tombstones);

    remoteMeta = { updatedAt: Number(meta.updatedAt || 0) };
    saveCache(listaItems, remoteMeta);
    render();

    setSync("ok", "Listo ✅");
    if (showToast) toast("Lista actualizada", "ok", "Se cargó desde Sheets (rápido).");

  } catch (e) {
    const msg = String(e?.message || "");

    if (msg === "TOKEN_NEEDS_INTERACTIVE") {
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

  ensureOAuthToken(false)
    .catch(() => { /* noop */ })
    .finally(() => {
      trySyncPending().finally(() => {
        // ✅ si quedó pending, reintentar solo
        scheduleRetry("online_event");
      });
    });
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

  // UI: si tenías email guardado, mostrálo como en Drive XL
  const hinted = loadStoredOAuthEmail();
  setAccountUI(hinted);

  // Si el token está inválido, intentamos reconexión SILENT si tenemos hint (sin popup)
  // Esto evita que quede "Necesita Conectar" hasta que el usuario toque algo.
  if (!isTokenValid()) {
    setSync("offline", "Necesita Conectar");

    if (hinted) {
      // intento silent en background (sin toast para que no moleste)
      reconnectAndRefresh({ showToast: false });
    }
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
        if (!oauthAccessToken) loadStoredOAuth();
        if (!oauthAccessToken) return;


        // Solo si la pestaña está visible (reduce chance de bloqueos)
        if (document.visibilityState !== "visible") return;

        // Si falta menos de 2 minutos, refrescar
        const msLeft = oauthExpiresAt - Date.now();
        if (msLeft > 120_000) return;

        console.log("[token] proactive refresh, msLeft:", msLeft);

        // Refresh permisivo (puede abrir popup "espera un momento..." y cerrarse solo)
        await ensureOAuthToken(false).catch(() => { });

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

  // Si la pestaña vuelve a estar visible y estamos en "Necesita Conectar", reintentar silent
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;

    const txt = syncPill?.querySelector(".sync-text")?.textContent || "";
    if (/necesita conectar/i.test(txt)) {
      reconnectAndRefresh({ showToast: false });
    }
  });

});
