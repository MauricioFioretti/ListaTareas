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


// scope mínimo para identificar al usuario (email) + leer/escribir Sheets
// (drive.metadata.readonly NO es necesario para leer/escribir una Sheet por ID)
const OAUTH_SCOPES =
  "https://www.googleapis.com/auth/userinfo.email " +
  "https://www.googleapis.com/auth/userinfo.profile " +
  "https://www.googleapis.com/auth/spreadsheets";

// ================== SHEETS API HELPERS (rápido) ==================

// Resuelve el título real de la pestaña usando el SHEET_GID (sheetId)
// y lo guarda en localStorage para no pedirlo siempre.
async function resolveSheetTitleFromGid_(accessToken) {
  // 1) cache
  try {
    const cached = (localStorage.getItem(LS_SHEET_TITLE) || "").trim();
    if (cached) return { ok: true, title: cached };
  } catch {}

  // 2) pedir metadata mínima
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}` +
    `?fields=sheets(properties(sheetId,title))`;

  const resp = await fetchJson_(url, accessToken);

  if (!resp?.r?.ok) {
    const cls = classifyGoogleApiError_(resp);
    return {
      ok: false,
      error: cls.error,
      status: resp.status,
      url: resp.url,
      detail: String(resp.text || "").slice(0, 1200)
    };
  }

  let json = resp?.json;
  const sheets = Array.isArray(json?.sheets) ? json.sheets : [];

  const found = sheets.find(s => Number(s?.properties?.sheetId) === Number(SHEET_GID));
  const title = (found?.properties?.title || "").toString().trim();

  if (!title) {
    return { ok: false, error: "sheet_title_not_found_for_gid" };
  }

  try { localStorage.setItem(LS_SHEET_TITLE, title); } catch {}
  return { ok: true, title };
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
  clearStoredOAuth(); // borra token + email
  try { localStorage.removeItem(LS_SHEET_TITLE); } catch {}

  // ✅ FORZAR interactivo (NO silent)
  await ensureOAuthToken(true, "select_account", true);
  await ensureOAuthToken(true, "consent", true);

  // ✅ y asegurar spreadsheets
  await ensureSheetsScopeOrThrow_();
}

let oauthTokenClient = null;
let oauthAccessToken = "";
let oauthExpiresAt = 0;

// Inicializa GIS Token Client
// Inicializa GIS Token Client
// Inicializa GIS Token Client
function initOAuth() {
  oauthTokenClient = google.accounts.oauth2.initTokenClient({
    client_id: OAUTH_CLIENT_ID,
    scope: OAUTH_SCOPES,

    // ✅ evita pedir permisos de nuevo si ya fueron otorgados
    include_granted_scopes: true,

    // ✅ IMPORTANTE: mejora el upgrade incremental de scopes (evita tokens “recortados”)
    enable_serial_consent: true,

    // (lo dejamos apagado como lo tenías; si querés luego lo probamos con Brave)
    // use_fedcm_for_prompt: true,

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

// =====================
// DEBUG: ver scopes reales del access_token
// =====================
async function debugTokenScopes_(token) {
  try {
    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`);
    const txt = await r.text();
    console.log("[tokeninfo]", txt);
  } catch (e) {
    console.warn("[tokeninfo] failed:", e?.message || e);
  }
}

// =====================
// UI helper: falta permiso Sheets (mensaje único y consistente)
// =====================
function handleMissingSheetsPermission_() {
  setSync("offline", "Falta permiso Sheets");
  setAccountUI(loadStoredOAuthEmail() || "");

  getTokenInfo_(oauthAccessToken).then((info) => {
    let aud = "";
    let scopes = "";
    try {
      const j = JSON.parse(String(info?.text || "{}"));
      aud = String(j?.aud || j?.audience || "").trim();
      scopes = String(j?.scope || "").trim();
    } catch {}

    toast(
      "No se pudo obtener permiso de Sheets",
      "err",
      (
        "El token NO trae el permiso de Google Sheets. " +
        "Solución: Google Cloud Console → Google Auth Platform → Acceso a los datos → Agregar permisos → " +
        "Google Sheets API → seleccionar '.../auth/spreadsheets' (o readonly) → Guardar. " +
        "Después: quitar acceso a la app desde tu cuenta Google y reconectar. " +
        (aud ? (" | aud=" + aud) : "") +
        (scopes ? (" | scopes=" + scopes) : "")
      ).slice(0, 900)
    );
  }).catch(() => {
    toast(
      "No se pudo obtener permiso de Sheets",
      "err",
      "El token NO trae el permiso de Google Sheets. Agregá '.../auth/spreadsheets' en Acceso a los datos y reconectá."
    );
  });
}

// =====================
// tokeninfo helpers (chequeo de scopes)
// =====================
async function getTokenInfo_(token) {
  const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`);
  const txt = await r.text();
  return { ok: r.ok, status: r.status, text: txt };
}

function tokenInfoHasScope_(tokenInfoText, scopeUrl) {
  try {
    const raw = String(tokenInfoText || "");
    // tokeninfo es JSON; a veces estás haciendo includes() sobre texto plano y
    // podés tener falsos positivos/negativos.
    const j = JSON.parse(raw);
    const scopes = String(j?.scope || "")
      .split(/\s+/)
      .map(s => s.trim())
      .filter(Boolean);

    return scopes.includes(scopeUrl);
  } catch {
    // fallback: si no fue JSON por algún motivo, mantenemos el comportamiento anterior
    const t = String(tokenInfoText || "");
    return t.includes(scopeUrl);
  }
}

// ✅ Asegura que el token tenga spreadsheets; si no, revoca+reauth y re-chequea.
// Si aun así no aparece, cortamos con error claro.
async function ensureSheetsScopeOrThrow_() {
  if (!oauthAccessToken) throw new Error("NO_TOKEN");

  const SHEETS_RW = "https://www.googleapis.com/auth/spreadsheets";
  const SHEETS_RO = "https://www.googleapis.com/auth/spreadsheets.readonly";

  // 1) chequeo actual
  let info = await getTokenInfo_(oauthAccessToken);

  // Debug claro (para ver exactamente qué scopes trae)
  try {
    const j = JSON.parse(String(info.text || "{}"));
    console.log("[scope] tokeninfo scopes =", j?.scope || "(none)");
    console.log("[scope] tokeninfo aud =", j?.aud || j?.audience || "(none)");
  } catch {
    console.log("[scope] tokeninfo raw =", info.text);
  }

  if (tokenInfoHasScope_(info.text, SHEETS_RW) || tokenInfoHasScope_(info.text, SHEETS_RO)) return true;

  console.warn("[scope] Falta spreadsheets(.readonly). Intentando revokeAndReauth_()...");
  await revokeAndReauth_(true);

  // 2) re-chequeo después de reauth
  info = await getTokenInfo_(oauthAccessToken);

  try {
    const j2 = JSON.parse(String(info.text || "{}"));
    console.log("[scope] AFTER reauth tokeninfo scopes =", j2?.scope || "(none)");
    console.log("[scope] AFTER reauth tokeninfo aud =", j2?.aud || j2?.audience || "(none)");
  } catch {
    console.log("[scope] AFTER reauth tokeninfo raw =", info.text);
  }

  if (tokenInfoHasScope_(info.text, SHEETS_RW) || tokenInfoHasScope_(info.text, SHEETS_RO)) return true;

  // 3) sigue sin aparecer => es configuración OAuth (consent screen / proyecto / test users)
  handleMissingSheetsPermission_();
  throw new Error("SPREADSHEETS_SCOPE_NOT_GRANTED");
}

// =====================
// FIX: revocar token para forzar upgrade de scopes (spreadsheets)
// =====================
// =====================
// FIX: revocar token para forzar upgrade de scopes (spreadsheets)
// =====================
async function revokeAndReauth_(forceSelectAccount = true) {
  // ✅ Guardar token actual ANTES de limpiar
  const tokenToRevoke = oauthAccessToken || (function () {
    try {
      const raw = localStorage.getItem(LS_OAUTH);
      if (!raw) return "";
      const t = JSON.parse(raw);
      return String(t?.access_token || "");
    } catch {
      return "";
    }
  })();

  // ✅ Revocar token (revoca token, no necesariamente el grant completo)
  if (window.google?.accounts?.oauth2?.revoke && tokenToRevoke) {
    await new Promise((res) => {
      try {
        google.accounts.oauth2.revoke(tokenToRevoke, () => res());
      } catch {
        res();
      }
    });
  }

  // ✅ Limpieza local fuerte (esto evita que el flujo “silent” te vuelva a traer el recortado)
  clearStoredOAuth();
  try { localStorage.removeItem(LS_SHEET_TITLE); } catch {}

  // 🔥 IMPORTANTE:
  // 1) select_account (si corresponde)
  // 2) consent FORZADO saltando silent (forceInteractive=true)
  const firstPrompt = forceSelectAccount ? "select_account" : "consent";

  await ensureOAuthToken(true, firstPrompt, true);
  await ensureOAuthToken(true, "consent", true);

  // Debug del token final
  await debugTokenScopes_(oauthAccessToken);
}

// ✅ Evita carreras: GIS usa un solo callback. Si dos requestAccessToken corren juntos,
// se pisan y queda todo inestable (muy común en incógnito con auto-refresh + save + retry).
let oauthTokenRequestInFlight = null;

function requestAccessToken({ prompt, hint } = {}) {
  // Si ya hay una solicitud en vuelo, devolvemos la misma Promise
  if (oauthTokenRequestInFlight) return oauthTokenRequestInFlight;

  oauthTokenRequestInFlight = new Promise((resolve, reject) => {
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      oauthTokenRequestInFlight = null;
      reject(new Error("popup_timeout_or_closed"));
    }, 45_000);

    oauthTokenClient.callback = (resp) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      oauthTokenRequestInFlight = null;

      if (resp?.error) {
        const err = String(resp.error || "");
        const sub = String(resp.error_subtype || "");
        const msg = (err + (sub ? `:${sub}` : "")).toLowerCase();

        if (
          msg.includes("interaction_required") ||
          msg.includes("access_denied") ||
          msg.includes("popup_closed") ||
          msg.includes("popup_closed_by_user")
        ) {
          reject(new Error("TOKEN_NEEDS_INTERACTIVE"));
          return;
        }

        reject(new Error(err));
        return;
      }

      resolve(resp);
    };

    const opts = {};

    // ✅ SIEMPRE scopes explícitos (evita quedarse con scopes viejos)
    opts.scope = OAUTH_SCOPES;

    // ✅ Mejora incremental auth (cuando hay interacción)
    if (prompt && prompt !== "") {
      opts.enable_serial_consent = true;
    }

    if (prompt !== undefined) opts.prompt = prompt; // "" = silent real
    if (hint && hint.includes("@")) opts.hint = hint;

    try {
      oauthTokenClient.requestAccessToken(opts);
    } catch (e) {
      clearTimeout(timer);
      oauthTokenRequestInFlight = null;
      reject(e);
    }
  });

  return oauthTokenRequestInFlight;
}

function isTokenValid() {
  return oauthAccessToken && Date.now() < (oauthExpiresAt - 30_000);
}

// Esto intenta silent. Si falla y allowInteractive=true, abre popup.
// Esto intenta silent SIEMPRE primero. Si falla y allowInteractive=true, abre popup.
// Esto intenta silent. Si falla y allowInteractive=true, abre popup.
// ✅ Anti-incógnito: si el token silent viene de OTRO email distinto al hint, se invalida.
// Esto intenta silent. Si falla y allowInteractive=true, abre popup.
// ✅ NUEVO: si forceInteractive=true, SALTA el silent y fuerza el popup (para pedir scopes nuevos).
// ✅ NUEVO: si forceInteractive=true, SALTA el silent y fuerza el popup (para pedir scopes nuevos).
// ✅ FIX: si forceInteractive=true, NO devolver temprano aunque haya token “válido” (porque puede faltar scope).
async function ensureOAuthToken(allowInteractive = false, interactivePrompt = "consent", forceInteractive = false) {
  // 1) si ya está en memoria, OK (PERO solo si NO estamos forzando interacción)
  if (!forceInteractive && isTokenValid()) return oauthAccessToken;

  // 2) si hay token guardado, cargarlo (PERO solo si NO estamos forzando interacción)
  const hadStored = loadStoredOAuth();
  if (!forceInteractive && isTokenValid()) return oauthAccessToken;

  const hintEmail = loadStoredOAuthEmail();

  // ✅ CORTE incógnito:
  // Si NO es interactivo y NO había token guardado y NO hay hint => NO llames GIS (evita loops raros)
  if (!allowInteractive && !hadStored && !hintEmail) {
    throw new Error("TOKEN_NEEDS_INTERACTIVE");
  }

  // Helper: valida que el token corresponda al email esperado (si hay hint)
  async function validateTokenEmailOrThrow_() {
    if (!hintEmail) return;
    const em = await fetchUserEmailFromToken(oauthAccessToken);
    if (!em) return; // si no se pudo leer userinfo, no bloqueamos acá

    if (em !== hintEmail) {
      // token de otra cuenta: limpiamos para no quedar pegados a la equivocada
      clearStoredOAuth();
      throw new Error("TOKEN_NEEDS_INTERACTIVE");
    }
  }

  // ✅ 3) Silent real (prompt:"") SOLO si NO estamos forzando interacción
  if (!forceInteractive) {
    try {
      console.log("[ensureOAuthToken] silent refresh, hint =", hintEmail);

      const r = await requestAccessToken({
        prompt: "",
        hint: hintEmail || undefined
      });

      if (r?.access_token) {
        oauthAccessToken = r.access_token;
        oauthExpiresAt = Date.now() + (Number(r.expires_in || 3600) * 1000);

        // Guardamos token y validamos mismatch (si hay hint)
        saveStoredOAuth(oauthAccessToken, oauthExpiresAt);
        await validateTokenEmailOrThrow_();

        // Guardar email como hint (si lo conseguimos)
        const em = await fetchUserEmailFromToken(oauthAccessToken);
        if (em) saveStoredOAuthEmail(em);

        return oauthAccessToken;
      }
    } catch (e) {
      const msg = String(e?.message || e || "");
      console.warn("[ensureOAuthToken] silent refresh failed:", msg);

      if (!allowInteractive) {
        throw new Error("TOKEN_NEEDS_INTERACTIVE");
      }
      // si allowInteractive=true, seguimos al flujo interactivo
    }
  }

  // 4) Interactivo
  // ✅ En primer uso/incógnito, preferimos select_account si no hay hint
  const promptToUse = interactivePrompt ?? "consent";
  const finalPrompt = (!hintEmail && promptToUse === "consent") ? "select_account" : promptToUse;

  const r2 = await requestAccessToken({
    prompt: finalPrompt,
    hint: hintEmail || undefined
  });

  if (!r2?.access_token) throw new Error("TOKEN_NEEDS_INTERACTIVE");

  oauthAccessToken = r2.access_token;
  oauthExpiresAt = Date.now() + (Number(r2.expires_in || 3600) * 1000);
  saveStoredOAuth(oauthAccessToken, oauthExpiresAt);

  const em2 = await fetchUserEmailFromToken(oauthAccessToken);
  if (em2) saveStoredOAuthEmail(em2);

  return oauthAccessToken;
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
  markUserGesture_(); // ✅ permite fallback interactivo si falta scope/permisos
  await reconnectAndRefresh({ showToast: true });
});

btnConnect.addEventListener("click", async () => {
  markUserGesture_(); // ✅ gesto real (permite abrir consentimiento si falta scope)
  uiBusyStart("btnConnect_click");

  try {
    setSync("saving", "Autorizando…");

    // Drive XL behavior:
    // - Si ya estás conectado y tocás el botón -> forzá selector de cuenta
    // - Si no -> conectá normal
    const isSwitch = (btnConnect.dataset.mode === "switch");
    if (isSwitch) {
      await forceSwitchAccount(); // limpia y abre selector (select_account)
    } else {
      // 1) selector de cuenta
      await ensureOAuthToken(true, "select_account");

      // 2) ✅ FORZAR consentimiento para pedir/actualizar scopes (spreadsheets)
      // IMPORTANTE: salta el silent para evitar quedar con token viejo sin scopes.
      await ensureOAuthToken(true, "consent", true);
    }

    await debugTokenScopes_(oauthAccessToken);

    // ✅ Bloqueo duro: si no conseguimos spreadsheets, NO seguimos
    try {
      await ensureSheetsScopeOrThrow_();
    } catch (e) {
      const msg = String(e?.message || "");

      if (msg === "SPREADSHEETS_SCOPE_NOT_GRANTED") {
        setSync("offline", "Falta permiso Sheets");
        setAccountUI(loadStoredOAuthEmail() || "");
        toast(
          "No se pudo obtener permiso de Sheets",
          "err",
          "Esto ya no es el código. Revisá en Google Cloud Console: OAuth Consent Screen → Publishing status (Testing) y agregá tu email como Test User, o publicá la app. Luego tocá Conectar de nuevo."
        );
        return; // 👈 IMPORTANTÍSIMO: cortamos acá
      }

      throw e;
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
  } finally {
    uiBusyEnd("btnConnect_click");
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
// User-gesture marker (permite pedir token interactivo si falla por scopes/permisos)
// =====================
let lastUserGestureAt = 0;

// ✅ En incógnito / redes lentas, 2.5s a veces no alcanza para llegar al error y fallback interactivo.
// Subimos a 15s para que, si el save falla por permisos, podamos abrir select_account.
const USER_GESTURE_TTL_MS = 15000;

function markUserGesture_() {
  lastUserGestureAt = Date.now();
}

function canUseInteractiveNow_() {
  return (Date.now() - lastUserGestureAt) <= USER_GESTURE_TTL_MS;
}

// =====================
// UI helpers
// =====================

// --- UI guard: evita que aparezca "Necesita Conectar" mientras estamos conectando/sincronizando ---
let uiBusyCount = 0;

function uiBusyStart(label = "") {
  uiBusyCount++;
  // console.log("[uiBusyStart]", label, "count=", uiBusyCount);
}

function uiBusyEnd(label = "") {
  uiBusyCount = Math.max(0, uiBusyCount - 1);
  // console.log("[uiBusyEnd]", label, "count=", uiBusyCount);
}

function uiIsBusy() {
  return uiBusyCount > 0;
}

function setSync(state, text) {
  const nextState = state || "";
  const nextText = String(text || "");

  // ✅ Guard anti-parpadeo:
  // Si estamos en medio de una conexión/reconexión/sync, NO mostrar "Necesita Conectar"
  // porque es un "downgrade" temporal que después se corrige solo.
  const isNeedsConnect = (nextState === "offline") && /necesita conectar/i.test(nextText);

  if (isNeedsConnect && uiIsBusy()) {
    // No tocamos el pill ni mostramos refresh durante un flujo "busy"
    return;
  }

  syncPill.classList.remove("ok", "saving", "offline");
  if (nextState) syncPill.classList.add(nextState);
  syncPill.querySelector(".sync-text").textContent = nextText;

  // Mostrar refresh solo cuando estamos "offline / necesita conectar"
  const needs = (nextState === "offline") && /necesita conectar/i.test(nextText);
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
      meta: { updatedAt: meta.updatedAt || 0, count: meta.count || 0, ts: Date.now() }
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

  // mensaje “humano” típico de Google APIs
  const rawMsg =
    String(resp?.json?.error?.message || resp?.text || "").toLowerCase();

  if (status === 401) return { error: "auth_required" };

  if (status === 403) {
    // ✅ scopes insuficientes
    if (
      rawMsg.includes("insufficient authentication scopes") ||
      rawMsg.includes("access_token_scope_insufficient") ||
      rawMsg.includes("insufficientpermissions")
    ) {
      return { error: "missing_scope" };
    }

    // ✅ API no habilitada / proyecto equivocado (CLÁSICO)
    // Mensajes típicos: "accessNotConfigured", "has not been used in project", "API has not been used..."
    if (
      rawMsg.includes("accessnotconfigured") ||
      rawMsg.includes("has not been used in project") ||
      rawMsg.includes("api has not been used") ||
      rawMsg.includes("google sheets api has not been used") ||
      rawMsg.includes("access not configured")
    ) {
      return { error: "api_not_enabled" };
    }

    // ✅ permiso del archivo (no sos editor / no tenés acceso)
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
  // 1) resolver título desde GID (ahora devuelve {ok,title} o error estructurado)
  const titleRes = await resolveSheetTitleFromGid_(token);
  if (!titleRes?.ok) return titleRes;

  const sheetTitle = titleRes.title;

  const rangeItems = `${sheetTitle}!A2:B`;
  const rangeMeta = `${sheetTitle}!${META_CELL_A1}`;

  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}` +
    `/values:batchGet?ranges=${encodeURIComponent(rangeItems)}&ranges=${encodeURIComponent(rangeMeta)}` +
    `&majorDimension=ROWS`;

  const resp = await fetchJson_(url, token);

  if (!resp?.r?.ok) {
    const cls = classifyGoogleApiError_(resp);
    return {
      ok: false,
      error: cls.error,
      status: resp.status,
      url: resp.url,
      detail: String(resp.text || "").slice(0, 1200)
    };
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
// Escribe toda la lista A2:B + Z1 (batchUpdate)
// expectedUpdatedAt: si no coincide => conflict
async function sheetsSet_(token, items, expectedUpdatedAt = 0) {
  const titleRes = await resolveSheetTitleFromGid_(token);
  if (!titleRes?.ok) return titleRes;
  const sheetTitle = titleRes.title;

  // ✅ 1) UN SOLO GET para conflicto + remoteCount (A2:B + Z1)
  const before = await sheetsGet_(token);
  if (!before?.ok) return before;

  const remoteUA = Number(before?.meta?.updatedAt || 0);
  const remoteCount = Number(before?.meta?.count || 0);

  if (Number(expectedUpdatedAt || 0) !== remoteUA) {
    return {
      ok: false,
      error: "conflict",
      items: Array.isArray(before?.items) ? before.items : [],
      meta: before?.meta || { updatedAt: remoteUA, count: remoteCount }
    };
  }

  // ✅ 2) normalizar/dedup/ordenar
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

  // ✅ 3) preparar values (limpia sobrantes usando remoteCount que ya vino en "before")
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
  // ✅ Si no hay hintEmail (típico incógnito), cuando sea interactivo usamos select_account
  const hint = loadStoredOAuthEmail();
  const prompt = allowInteractive ? (hint ? "consent" : "select_account") : "consent";

  const token = await ensureOAuthToken(allowInteractive, prompt);

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

  uiBusyStart("reconnectAndRefresh");

  try {
    setSync("saving", "Reconectando…");

    // 1) Intento SILENT (no popup)
    await ensureOAuthToken(false);

    // 2) Detectar email real del token
    const tokenEmail = await fetchUserEmailFromToken(oauthAccessToken);
    const hintedEmail = loadStoredOAuthEmail();

    // ✅ En incógnito, a veces el silent devuelve token de otra cuenta.
    // Si tengo "hint" guardado y el token viene con otro email, no sigo:
    if (hintedEmail && tokenEmail && tokenEmail !== hintedEmail) {
      // Dejamos consistente el estado (y obligamos selector al usuario)
      clearStoredOAuth();
      setAccountUI("");
      setSync("offline", "Necesita Conectar");
      if (showToast) toast("Cuenta incorrecta", "warn", "Tocá Conectar y elegí la cuenta con acceso.");
      return;
    }

    // 3) Guardar email como hint y reflejar en UI
    if (tokenEmail) {
      saveStoredOAuthEmail(tokenEmail);
      setAccountUI(tokenEmail);
    } else {
      setAccountUI(hintedEmail);
    }

    // 4) Traer lista real (Sheets API)
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
    uiBusyEnd("reconnectAndRefresh");
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
      markUserGesture_(); // ✅ marca gesto real del usuario (permite popup si falta scope)
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
  // ✅ Si esto vino de una acción del usuario (reason no vacío),
  // marcamos gesto para permitir popup si hace falta (incógnito / cuenta equivocada)
  if (reason) markUserGesture_();

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
      const expectedUA = Number(remoteMeta?.updatedAt || 0);

      const merged = mergeRemoteWithLocal([], localSnapshot, tombstones);

      if (merged.length === 0) {
        setPending(listaItems);
        setSync("offline", "No se guardó (lista vacía bloqueada)");
        toast("Bloqueado", "warn", "No se permite guardar una lista vacía por seguridad.");
        return;
      }

      // ✅ Si el último evento fue un gesto real del usuario, permitimos fallback interactivo
      const allowInteractive = canUseInteractiveNow_();

      // 1) primer intento (silencioso)
      let saved = await apiSet(merged, expectedUA, { allowInteractive: false });

      // 2) Si falla por auth/scope -> pedir interacción (consent)
      if (saved?.ok === false && (saved?.error === "auth_required" || saved?.error === "missing_scope")) {
        if (!allowInteractive) throw new Error("TOKEN_NEEDS_INTERACTIVE");

        // 🔥 upgrade completo (revoca + select_account + consent) porque en tu caso consent solo no alcanza
        await revokeAndReauth_(true);
        await debugTokenScopes_(oauthAccessToken);

        // Reintento
        saved = await apiSet(merged, expectedUA, { allowInteractive: false });

        // Si sigue faltando scope, ya no insistimos: es configuración OAuth
        if (saved?.ok === false && saved?.error === "missing_scope") {
          handleMissingSheetsPermission_();
          throw new Error("SPREADSHEETS_SCOPE_NOT_GRANTED");
        }
      }

      // 3) ✅ Si falla por "permission_denied" o "not_found_or_no_access",
      // en incógnito suele ser cuenta equivocada -> forzar selector de cuenta
      if (saved?.ok === false && (saved?.error === "permission_denied" || saved?.error === "not_found_or_no_access")) {
        if (!allowInteractive) throw new Error("TOKEN_NEEDS_INTERACTIVE");

        // Fuerza selector de cuenta (select_account) y reintenta una vez
        await forceSwitchAccount();
        saved = await apiSet(merged, expectedUA, { allowInteractive: true });
      }

      // conflicto => re-merge y reintento 1 vez
      if (saved?.ok === false && saved?.error === "conflict") {
        const remoteItemsNow = Array.isArray(saved?.items) ? saved.items : [];
        const remoteUA = Number(saved?.meta?.updatedAt || 0);

        const merged2 = mergeRemoteWithLocal(remoteItemsNow, localSnapshot, tombstones);

        let saved2 = await apiSet(merged2, remoteUA, { allowInteractive: false });

        // auth/scope -> consent
        if (saved2?.ok === false && (saved2?.error === "auth_required" || saved2?.error === "missing_scope")) {
          if (!allowInteractive) throw new Error("TOKEN_NEEDS_INTERACTIVE");

          // ✅ FORZAR consentimiento para “upgrade” de scopes
          await ensureOAuthToken(true, "consent", true);

          // Reintento con token ya corregido
          saved2 = await apiSet(merged2, remoteUA, { allowInteractive: false });
        }

        // ✅ permiso/no access -> selector de cuenta
        if (saved2?.ok === false && (saved2?.error === "permission_denied" || saved2?.error === "not_found_or_no_access")) {
          if (!allowInteractive) throw new Error("TOKEN_NEEDS_INTERACTIVE");
          await forceSwitchAccount();
          saved2 = await apiSet(merged2, remoteUA, { allowInteractive: true });
        }

        if (saved2?.ok !== true) throw new Error(String(saved2?.error || "save_failed"));

        saved = saved2;
        var finalSavedItems = dedupNormalize(merged2);

      } else {
        if (saved?.ok !== true) {
          if (saved?.error === "auth_required") throw new Error("TOKEN_NEEDS_INTERACTIVE");
          throw new Error(String(saved?.error || "save_failed"));
        }

        var finalSavedItems = dedupNormalize(merged);
      }

      // ✅ Si hubo cambios mientras guardábamos, NO pisar estado local
      if (localVersion !== startedVersion) {
        setPending(listaItems);
        setSync("saving", "Guardando…");
        saving = false;
        scheduleSave("");
        return;
      }

      // ✅ Aplicar resultado final
      listaItems = finalSavedItems;

      remoteMeta = {
        updatedAt: Number(saved?.meta?.updatedAt || remoteMeta?.updatedAt || 0),
        count: Number(saved?.meta?.count || remoteMeta?.count || 0)
      };

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
        toast("No se pudo guardar", "err",
          (msg || "Quedó pendiente.") +
          " (Tip: si es 403, mirá si sos EDITOR o si la Sheets API está habilitada en el mismo proyecto del OAuth)"
        );
        scheduleRetry("save_failed");
      }

    } finally {
      saving = false;
    }

  }, 250);
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

    remoteMeta = {
      updatedAt: Number(saved?.meta?.updatedAt || remoteUA_now || 0),
      count: Number(saved?.meta?.count || remoteMeta?.count || 0)
    };

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

  uiBusyStart("refreshFromRemote");

  try {
    // ✅ 1) primer intento (sin popup)
    let resp = await apiCall("get", null, {}, { allowInteractive: false });

    // ✅ 2) Si falta scope (token sin spreadsheets), intentamos upgrade y si no, mostramos ayuda clara
    if (resp?.ok === false && resp?.error === "missing_scope") {
      const allowInteractive = canUseInteractiveNow_();
      if (!allowInteractive) throw new Error("TOKEN_NEEDS_INTERACTIVE");

      // intenta upgrade real (select_account + consent)
      await revokeAndReauth_(true);
      await debugTokenScopes_(oauthAccessToken);

      // reintento
      resp = await apiCall("get", null, {}, { allowInteractive: false });

      // si sigue faltando scope, cortar con mensaje unificado
      if (resp?.ok === false && resp?.error === "missing_scope") {
        handleMissingSheetsPermission_();
        throw new Error("SPREADSHEETS_SCOPE_NOT_GRANTED");
      }
    }

    if (!resp?.ok) {
      // auth => pedir conectar
      if (resp?.error === "auth_required") throw new Error("TOKEN_NEEDS_INTERACTIVE");

      // ✅ API no habilitada / proyecto equivocado
      if (resp?.error === "api_not_enabled") {
        const d = String(resp?.detail || "").slice(0, 700);
        toast(
          "Sheets API no habilitada (403)",
          "err",
          d || "Revisá que el OAuth Client ID pertenezca al MISMO proyecto donde activaste Google Sheets API."
        );
        throw new Error("api_not_enabled");
      }

      // cuenta sin acceso o spreadsheet no accesible => obligar selector
      if (resp?.error === "permission_denied" || resp?.error === "not_found_or_no_access") {
        const d = String(resp?.detail || "").slice(0, 260);
        clearStoredOAuth();
        setAccountUI("");
        toast("Sin acceso a la planilla (403)", "warn",
          d || "Probá Conectar y elegí la cuenta que sea EDITOR de la planilla.");
        throw new Error("TOKEN_NEEDS_INTERACTIVE");
      }

      // otros
      const d = String(resp?.detail || "").slice(0, 260);
      toast("Error al leer Sheets", "err", (resp?.error || "get_failed") + (d ? " — " + d : ""));
      throw new Error(String(resp?.error || "get_failed"));
    }

    const remoteItems = Array.isArray(resp?.items) ? resp.items : [];
    const meta = resp?.meta || { updatedAt: 0 };

    // ✅ Si hubo cambios locales mientras cargaba, no pisar UI
    if (localVersion !== startedVersion) {
      remoteMeta = {
        updatedAt: Number(meta.updatedAt || 0),
        count: Number(meta.count || 0)
      };

      saveCache(listaItems, remoteMeta);
      setSync("ok", "Cambios locales ✅");
      if (showToast) toast("Cambios locales detectados", "warn", "No se reemplazó tu lista por la versión remota.");
      return;
    }

    // merge remoto - tombstones
    listaItems = mergeRemoteWithLocal(remoteItems, [], tombstones);

    remoteMeta = {
      updatedAt: Number(meta.updatedAt || 0),
      count: Number(meta.count || 0)
    };

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
  } finally {
    uiBusyEnd("refreshFromRemote");
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
  // Uso:
  //   __expireTokenNow()           -> solo expira
  //   __expireAndReconnect()       -> expira y fuerza reconnectAndRefresh
  window.__expireTokenNow = () => {
    oauthExpiresAt = Date.now() - 1000;
    saveStoredOAuth(oauthAccessToken, oauthExpiresAt);
    console.log("Token forzado a expirar.");
  };

  window.__expireAndReconnect = async () => {
    window.__expireTokenNow();

    console.log("Probando reconexión automática…");
    try {
      await reconnectAndRefresh({ showToast: true });
      console.log("Reconexión OK ✅");
    } catch (e) {
      console.warn("Reconexión falló:", e?.message || e);
    }
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
