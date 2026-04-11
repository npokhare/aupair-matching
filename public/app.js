// ============================================================
// app.js — AuPair Rematch
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup,
  signInAnonymously, signOut, onAuthStateChanged,
  connectAuthEmulator
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore, connectFirestoreEmulator,
  doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, addDoc, getDocs,
  query, where, limit, serverTimestamp, increment, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

// ── Config ──────────────────────────────────────────────────
const useLocalEmulators = ["localhost", "127.0.0.1"].includes(window.location.hostname);

const baseConfig = {
  apiKey:            "REPLACE_API_KEY",
  authDomain:        "aupair-matching.firebaseapp.com",
  projectId:         "aupair-matching",
  storageBucket:     "aupair-matching.appspot.com",
  messagingSenderId: "REPLACE_SENDER_ID",
  appId:             "REPLACE_APP_ID"
};

// ── State ───────────────────────────────────────────────────
// Set this to your Google account email to enable the admin dashboard.
// Leave empty ("") to disable admin mode.
const ADMIN_EMAIL = "niru.nirajanpokharel@gmail.com";

let selectedRole       = "aupair";
let currentUser        = null;
let isEditingProfile   = false;
let currentMatchId     = null;
let currentMatchState  = "mutual_match";
let currentChatParticipants = [];
let chatRulesAcceptedForAccount = false;
let matchesUnreadTotal = 0;
let matchesCacheEntries = null;
let matchesCacheAtMs = 0;
let discoverActionedTargetsCache = null;
let discoverActionedTargetsCacheAtMs = 0;
let discoverRefreshCooldownUntilMs = 0;
let discoverRefreshCooldownTimer = null;
let app, auth, db;
let unsubChatMessages  = null;
let unsubMatchState    = null;
let lastChatRenderKey  = "";
const provider = new GoogleAuthProvider();
const UI_TAB_KEY = "am_active_tab";
const UI_MATCH_KEY = "am_active_match";
const UNMATCH_COOLDOWN_DAYS = 30;
const DISCOVER_BUCKETS_TOTAL = 12;
const DISCOVER_BUCKETS_PER_WINDOW = 2;
const DISCOVER_ROTATION_MINUTES = 20;
const DISCOVER_RENDER_LIMIT = 12;
const DISCOVER_REFRESH_COOLDOWN_MS = 30000;
const MATCHES_CACHE_TTL_MS = 60000;
const DISCOVER_ACTION_CACHE_TTL_MS = 120000;
const CHAT_RULES_VERSION = "v1";
const CHAT_RULES_KEY = "am_chat_rules_v1";
const LEGAL_VERSION = "2026-04-10";
const LEGAL_PENDING_KEY = "am_pending_legal_acceptance";
const LEGAL_ACCEPTED_KEY = "am_legal_accepted";
const PRIORITY_SCORE = { normal: 1, high: 2, urgent: 3 };

// ── DOM helper ───────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

function hasDeviceLegalAcceptance() {
  const raw = localStorage.getItem(LEGAL_ACCEPTED_KEY);
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw);
    return parsed?.version === LEGAL_VERSION;
  } catch (_err) {
    return false;
  }
}

function rememberDeviceLegalAcceptance(acceptedAtMs = Date.now()) {
  localStorage.setItem(LEGAL_ACCEPTED_KEY, JSON.stringify({
    version: LEGAL_VERSION,
    acceptedAtMs: Number(acceptedAtMs) || Date.now()
  }));
}

function validateLegalChecks() {
  if (hasDeviceLegalAcceptance()) {
    const errorEl = $("authLegalError");
    if (errorEl) errorEl.textContent = "";
    return true;
  }

  const ageOk = $("ageConfirm")?.checked;
  const legalOk = $("legalConfirm")?.checked;
  const errorEl = $("authLegalError");

  if (!ageOk || !legalOk) {
    if (errorEl) errorEl.textContent = "Please confirm age (18+) and accept Terms + Privacy.";
    return false;
  }

  if (errorEl) errorEl.textContent = "";
  rememberDeviceLegalAcceptance();
  sessionStorage.setItem(LEGAL_PENDING_KEY, JSON.stringify({
    version: LEGAL_VERSION,
    acceptedAtMs: Date.now()
  }));
  return true;
}

async function persistPendingLegalAcceptance(uid) {
  const raw = sessionStorage.getItem(LEGAL_PENDING_KEY);
  if (!raw || !db) return;

  try {
    const parsed = JSON.parse(raw);
    if (!parsed?.version || !parsed?.acceptedAtMs) return;

    await setDoc(doc(db, "users", uid), {
      legalAcceptance: {
        version: parsed.version,
        acceptedAtMs: Number(parsed.acceptedAtMs),
        acceptedAt: serverTimestamp(),
        source: "auth-checkbox"
      },
      updatedAt: serverTimestamp()
    }, { merge: true });
    rememberDeviceLegalAcceptance(parsed.acceptedAtMs);
  } catch (_err) {
    // Non-critical; user flow should continue.
  } finally {
    sessionStorage.removeItem(LEGAL_PENDING_KEY);
  }
}

// ── View routing ─────────────────────────────────────────────
function showView(id) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  $(id).classList.add("active");
}

function showTab(name) {
  document.querySelectorAll(".tab-pane").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
  $("tab-" + name).classList.add("active");
  document.querySelector(`[data-tab="${name}"]`)?.classList.add("active");
  if (["discover", "matches", "profile"].includes(name)) {
    localStorage.setItem(UI_TAB_KEY, name);
  }
}

function storedTab() {
  const tab = localStorage.getItem(UI_TAB_KEY);
  return ["discover", "matches", "profile"].includes(tab) ? tab : "discover";
}

function storedMatchId() {
  return localStorage.getItem(UI_MATCH_KEY) || "";
}

function setStoredMatchId(matchId) {
  if (!matchId) {
    localStorage.removeItem(UI_MATCH_KEY);
    return;
  }
  localStorage.setItem(UI_MATCH_KEY, matchId);
}

function truncateText(text, maxLen = 180) {
  const normalized = String(text || "").trim();
  if (!normalized) return "";
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen).trimEnd()}...`;
}

function invalidateMatchesCache() {
  matchesCacheEntries = null;
  matchesCacheAtMs = 0;
}

function invalidateDiscoverActionCache() {
  discoverActionedTargetsCache = null;
  discoverActionedTargetsCacheAtMs = 0;
}

async function getActionedTargetsForCurrentUser() {
  if (!currentUser || !db) return new Map();

  const isFresh = discoverActionedTargetsCache
    && (Date.now() - discoverActionedTargetsCacheAtMs) < DISCOVER_ACTION_CACHE_TTL_MS;
  if (isFresh) return new Map(Object.entries(discoverActionedTargetsCache));

  const snap = await getDocs(query(
    collection(db, "matchActions"),
    where("actorUid", "==", currentUser.uid),
    limit(80)
  ));

  const actioned = new Map();
  snap.forEach((d) => {
    const data = d.data() || {};
    const action = data.action === "like" || data.action === "pass" ? data.action : null;
    if (data.targetUid && action) actioned.set(data.targetUid, action);
  });

  discoverActionedTargetsCache = Object.fromEntries(actioned);
  discoverActionedTargetsCacheAtMs = Date.now();
  return actioned;
}

function bucketFromUid(uid, total = DISCOVER_BUCKETS_TOTAL) {
  const normalized = String(uid || "");
  if (!normalized) return 0;
  let hash = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
  }
  return hash % total;
}

function getDiscoverBucketsForNow(uid) {
  const nowWindow = Math.floor(Date.now() / (DISCOVER_ROTATION_MINUTES * 60 * 1000));
  const seed = bucketFromUid(uid, DISCOVER_BUCKETS_TOTAL);
  const buckets = [];
  for (let i = 0; i < DISCOVER_BUCKETS_PER_WINDOW; i += 1) {
    buckets.push((seed + nowWindow + i) % DISCOVER_BUCKETS_TOTAL);
  }
  return Array.from(new Set(buckets));
}

async function getLikeCount(uid) {
  const myActionsSnap = await getDocs(
    query(collection(db, "matchActions"), where("actorUid", "==", uid), limit(50))
  );
  let likeCount = 0;
  myActionsSnap.forEach((a) => {
    if (a.data()?.action === "like") likeCount += 1;
  });
  return likeCount;
}

async function updateLikeQuotaUI() {
  if (!currentUser || !db || !$("likeQuotaText")) return;
  try {
    const likeCount = await getLikeCount(currentUser.uid);
    $("likeQuotaText").textContent = `Selected: ${likeCount}/3`;
  } catch (_err) {
    $("likeQuotaText").textContent = "Selected: ?/3";
  }
}

function applyDiscoverRefreshCooldown() {
  const btn = $("loadCandidatesBtn");
  if (!btn) return;

  if (discoverRefreshCooldownTimer) {
    clearInterval(discoverRefreshCooldownTimer);
    discoverRefreshCooldownTimer = null;
  }

  const tick = () => {
    const remainingMs = discoverRefreshCooldownUntilMs - Date.now();
    if (remainingMs <= 0) {
      btn.disabled = false;
      btn.textContent = "Refresh";
      discoverRefreshCooldownUntilMs = 0;
      return false;
    }

    btn.disabled = true;
    const seconds = Math.ceil(remainingMs / 1000);
    btn.textContent = `Refresh in ${seconds}s`;
    return true;
  };

  if (tick()) {
    discoverRefreshCooldownTimer = setInterval(() => {
      if (!tick() && discoverRefreshCooldownTimer) {
        clearInterval(discoverRefreshCooldownTimer);
        discoverRefreshCooldownTimer = null;
      }
    }, 1000);
  }
}

function showLoading(on) {
  $("loadingOverlay").classList.toggle("active", on);
}

// ── Toast notifications ──────────────────────────────────────
const TOAST_ICONS = { info: "ℹ️", success: "✅", error: "❌", warning: "⚠️" };

function toast(message, type = "info", durationMs = 4000) {
  const container = $("toastContainer");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `
    <span class="toast-icon">${TOAST_ICONS[type] || TOAST_ICONS.info}</span>
    <span>${escHtml(message)}</span>
    <button class="toast-close" aria-label="Dismiss">×</button>
  `;
  el.querySelector(".toast-close").addEventListener("click", () => el.remove());
  container.prepend(el);
  if (durationMs > 0) setTimeout(() => el.remove(), durationMs);
}

// ── Confirm modal ────────────────────────────────────────────
// Returns a Promise<boolean> — resolves true on confirm, false on cancel.
function showConfirm(message, confirmLabel = "Confirm", dangerous = true) {
  return new Promise(resolve => {
    const backdrop = $("confirmModal");
    const msgEl    = $("modalMsg");
    const confirmBtn = $("modalConfirm");
    const cancelBtn  = $("modalCancel");

    msgEl.textContent    = message;
    confirmBtn.textContent = confirmLabel;
    confirmBtn.className = dangerous ? "modal-confirm" : "modal-confirm safe";
    backdrop.hidden = false;
    backdrop.setAttribute("aria-hidden", "false");
    backdrop.classList.add("active");

    const cleanup = (result) => {
      backdrop.classList.remove("active");
      backdrop.setAttribute("aria-hidden", "true");
      backdrop.hidden = true;
      confirmBtn.replaceWith(confirmBtn.cloneNode(true));
      cancelBtn.replaceWith(cancelBtn.cloneNode(true));
      resolve(result);
    };

    $("modalConfirm").addEventListener("click", () => cleanup(true),  { once: true });
    $("modalCancel") .addEventListener("click", () => cleanup(false), { once: true });
  });
}

// ── Chat community guidelines ─────────────────────────────────
function rememberChatRulesAcceptedLocal(acceptedAtMs = Date.now()) {
  localStorage.setItem(CHAT_RULES_KEY, JSON.stringify({
    version: CHAT_RULES_VERSION,
    acceptedAtMs: Number(acceptedAtMs) || Date.now()
  }));
}

function hasChatRulesAccepted() {
  if (chatRulesAcceptedForAccount) return true;
  const raw = localStorage.getItem(CHAT_RULES_KEY);
  if (!raw) return false;
  if (raw === "true") return true; // backward compatibility
  try {
    const parsed = JSON.parse(raw);
    return parsed?.version === CHAT_RULES_VERSION;
  } catch (_err) {
    return false;
  }
}

async function persistChatRulesAcceptance(uid, source = "chat-modal") {
  const acceptedAtMs = Date.now();
  rememberChatRulesAcceptedLocal(acceptedAtMs);
  chatRulesAcceptedForAccount = true;
  if (!db || !uid) return;
  try {
    await setDoc(doc(db, "users", uid), {
      chatRulesAcceptance: {
        version: CHAT_RULES_VERSION,
        acceptedAtMs,
        acceptedAt: serverTimestamp(),
        source
      },
      updatedAt: serverTimestamp()
    }, { merge: true });
  } catch (_err) {
    // Non-critical; do not block chat entry if persistence fails.
  }
}

async function ensureChatRulesAccepted(matchId) {
  if (!currentUser || !db) return true;
  if (hasChatRulesAccepted()) return true;

  try {
    const threadSnap = await getDoc(doc(db, "threads", matchId));
    if (threadSnap.exists()) {
      const t = threadSnap.data() || {};
      const hasHistory = Number(t.messageCount || 0) > 0 || Boolean((t.lastMessagePreview || "").trim());
      if (hasHistory) {
        await persistChatRulesAcceptance(currentUser.uid, "existing-chat");
        return true;
      }
    }
  } catch (_err) {
    // If thread read fails, fall back to explicit consent modal.
  }

  const accepted = await showChatRulesModal();
  if (!accepted) return false;
  await persistChatRulesAcceptance(currentUser.uid, "chat-modal");
  return true;
}

function showChatRulesModal() {
  return new Promise((resolve) => {
    const modal      = $("chatRulesModal");
    const acceptBtn  = $("chatRulesAccept");
    const declineBtn = $("chatRulesDecline");

    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    modal.classList.add("active");

    const cleanup = (accepted) => {
      modal.classList.remove("active");
      modal.setAttribute("aria-hidden", "true");
      modal.hidden = true;
      acceptBtn.replaceWith(acceptBtn.cloneNode(true));
      declineBtn.replaceWith(declineBtn.cloneNode(true));
      if (accepted) rememberChatRulesAcceptedLocal();
      resolve(accepted);
    };

    $("chatRulesAccept") .addEventListener("click", () => cleanup(true),  { once: true });
    $("chatRulesDecline").addEventListener("click", () => cleanup(false), { once: true });
  });
}

// ── Datalist helpers ─────────────────────────────────────────
function setDatalistOptions(listId, values) {
  const dl = document.getElementById(listId);
  if (!dl) return;
  const existing = new Set(Array.from(dl.options).map(o => o.value.toLowerCase()));
  values.forEach(v => {
    if (v && !existing.has(v.toLowerCase())) {
      const opt = document.createElement("option");
      opt.value = v;
      dl.appendChild(opt);
      existing.add(v.toLowerCase());
    }
  });
}

async function populateRegionList() {
  if (!db) return;
  try {
    const snap = await getDocs(query(collection(db, "profiles"), where("profileVisible", "==", true), limit(100)));
    const regions = [];
    snap.forEach(d => {
      const r = (d.data().region || "").trim();
      if (r) regions.push(r);
    });
    setDatalistOptions("regionList", [...new Set(regions)]);
  } catch (_err) {
    // non-critical
  }
}

// ── Au-pair field visibility ──────────────────────────────────
function updateAupairFields(role) {
  document.querySelectorAll(".aupair-field").forEach(el => {
    el.classList.toggle("visible", role === "aupair");
  });
  const chip = $("onboardRoleChip");
  const label = role === "host" ? "🏡 Host Family" : "🧳 Au Pair";
  chip.innerHTML = `${label} <span class="role-chip-switch">switch ⇄</span>`;
}

// Toggle role chip
$("onboardRoleChip").addEventListener("click", () => {
  const newRole = $("role").value === "host" ? "aupair" : "host";
  selectedRole       = newRole;
  $("role").value    = newRole;
  if (newRole === "host") {
    $("onboardSub").textContent = "Tell potential au pairs about your family — anonymously.";
    $("aboutLabel").textContent = "About your family";
  } else {
    $("onboardSub").textContent = "Tell us about yourself — nothing here reveals your real identity.";
    $("aboutLabel").textContent = "About you";
  }
  updateAupairFields(newRole);
});

// ── Firebase config ──────────────────────────────────────────
async function resolveFirebaseConfig() {
  if (useLocalEmulators) {
    return {
      apiKey:            "demo-key",
      authDomain:        "demo-aupair-matching.firebaseapp.com",
      projectId:         "demo-aupair-matching",
      storageBucket:     "demo-aupair-matching.appspot.com",
      messagingSenderId: "000000000000",
      appId:             "1:000000000000:web:demo"
    };
  }
  if (!baseConfig.apiKey.startsWith("REPLACE_")) return baseConfig;
  try {
    const res = await fetch("/__/firebase/init.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`init.json HTTP ${res.status}`);
    const cfg = await res.json();
    if (!cfg.apiKey) throw new Error("init.json missing apiKey");
    return { ...baseConfig, ...cfg };
  } catch (err) {
    console.error("Firebase config error:", err);
    return null;
  }
}

async function initFirebase() {
  const cfg = await resolveFirebaseConfig();
  if (!cfg) return false;

  app  = initializeApp(cfg);
  auth = getAuth(app);
  db   = getFirestore(app);

  if (useLocalEmulators) {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    connectFirestoreEmulator(db, "127.0.0.1", 8085);
    $("demoLoginBtn").style.removeProperty("display");
  } else {
    $("demoLoginBtn").style.display = "none";
  }

  onAuthStateChanged(auth, handleAuthChange);
  populateRegionList();
  return true;
}

// ── Auth state handler ───────────────────────────────────────
async function handleAuthChange(user) {
  currentUser = user;
  showLoading(false);

  if (!user) {
    chatRulesAcceptedForAccount = false;
    showView("view-landing");
    return;
  }

  const isAdminUser = Boolean(ADMIN_EMAIL && user.email === ADMIN_EMAIL);
  const isAdminUserMode = Boolean(sessionStorage.getItem("am_admin_user_mode"));

  // Admin shortcut — bypass normal profile flow unless user chose user-mode
  if (isAdminUser && !isAdminUserMode) {
    $("adminUserPill").textContent = user.email;
    showView("view-admin");
    loadAdminDashboard().catch(err => console.error("Admin dashboard error:", err));
    return;
  }

  // If admin is browsing as regular user, keep a visible way back to admin.
  if ($("switchToAdminBtn")) {
    $("switchToAdminBtn").hidden = !isAdminUser;
  }

  $("userPill").textContent = user.email || `demo:${user.uid.slice(0, 6)}`;

  showLoading(true);
  try {
    await ensureUserDocs(user.uid);
    await persistPendingLegalAcceptance(user.uid);
    const userSnap = await getDoc(doc(db, "users", user.uid));
    const userData = userSnap.exists() ? (userSnap.data() || {}) : {};
    const legal = userData.legalAcceptance;
    const chatLegal = userData.chatRulesAcceptance;
    if (legal?.version === LEGAL_VERSION || legal?.acceptedAtMs) {
      rememberDeviceLegalAcceptance(legal.acceptedAtMs || Date.now());
    }
    if (chatLegal?.version === CHAT_RULES_VERSION || chatLegal?.acceptedAtMs) {
      chatRulesAcceptedForAccount = true;
      rememberChatRulesAcceptedLocal(chatLegal.acceptedAtMs || Date.now());
    }
    const profileSnap = await getDoc(doc(db, "profiles", user.uid));
    const profile = profileSnap.exists() ? profileSnap.data() : null;

    const hasRealAlias = profile?.alias && !profile.alias.startsWith("user_");
    if (hasRealAlias) {
      renderProfilePreview(profile);
      showView("view-app");
      const preferredTab = storedTab();

      const tabToShow = preferredTab === "profile" ? "profile" : preferredTab;
      showTab(tabToShow);
      // Run tab-specific loads independently so any error never crashes auth routing
      if (tabToShow === "discover") {
        loadCandidates().catch((err) => console.warn("Discover load failed:", err));
      } else if (tabToShow === "matches") {
        loadMatches().catch((err) => console.warn("Matches load failed:", err));
      }
    } else {
      prefillOnboarding(profile);
      showView("view-onboarding");
    }
  } catch (err) {
    console.error("Routing error:", err);
    showView("view-onboarding");
  } finally {
    showLoading(false);
  }
}

// ── Firestore helpers ─────────────────────────────────────────
function pairKey(a, b) { return [a, b].sort().join("_"); }

async function isPairInCooldown(uidA, uidB) {
  if (!db) return false;
  try {
    const pairId = pairKey(uidA, uidB);
    const snap = await getDoc(doc(db, "unmatchPairs", pairId));
    if (!snap.exists()) return false;
    const data = snap.data();
    const expiresAtMs = Number(data.expiresAtMs || 0);
    return expiresAtMs > Date.now();
  } catch (_err) {
    // Non-existent docs trigger permission-denied under strict rules — safe to ignore
    return false;
  }
}

async function hasActiveMatch(uid) {
  const docs = await fetchMatchesForUser(uid);
  return docs.some((d) => d.data()?.state !== "unmatched");
}

async function fetchMatchesForUser(uid) {
  const [snapA, snapB] = await Promise.all([
    getDocs(query(collection(db, "matches"), where("userA", "==", uid))),
    getDocs(query(collection(db, "matches"), where("userB", "==", uid)))
  ]);
  return [...snapA.docs, ...snapB.docs];
}

async function setCurrentUserDiscoverability(discoverable) {
  if (!currentUser || !db) return;
  await setDoc(doc(db, "profiles", currentUser.uid), {
    profileVisible: discoverable,
    matchingState: discoverable ? "discoverable" : "matched",
    updatedAt: serverTimestamp()
  }, { merge: true });
}

async function ensureUserDocs(uid) {
  const userRef    = doc(db, "users",    uid);
  const profileRef = doc(db, "profiles", uid);
  const [uSnap, pSnap] = await Promise.all([getDoc(userRef), getDoc(profileRef)]);

  if (!uSnap.exists()) {
    await setDoc(userRef, {
      uid, status: "active",
      createdAt: serverTimestamp(), updatedAt: serverTimestamp()
    });
  }
  if (!pSnap.exists()) {
    // Use the role the user picked on the landing screen
    const roleToSave = $('role').value || selectedRole || "aupair";
    await setDoc(profileRef, {
      uid, role: roleToSave,
      alias: `user_${uid.slice(0, 6)}`,
      region: "", interests: [], availability: "",
      countryOfOrigin: "", visaMonthsLeft: null,
      about: "",
      serveBucket: bucketFromUid(uid),
      profileVisible: true, updatedAt: serverTimestamp()
    });
  }
}

// ── Profile helpers ───────────────────────────────────────────
function prefillOnboarding(profile) {
  // Determine role: prefer what the user selected on the landing, fall back to saved profile role.
  // For a brand-new profile (auto-created by ensureUserDocs), selectedRole already matches
  // the landing choice. For returning users editing their profile, use the saved role.
  const role = profile?.alias && !profile.alias.startsWith("user_")
    ? (profile.role || selectedRole)   // returning user — trust saved role
    : selectedRole;                    // new user — trust landing choice

  selectedRole    = role;
  $("role").value = role;

  $("alias").value         = profile?.alias?.startsWith("user_") ? "" : (profile?.alias || "");
  $("region").value        = profile?.region || "";
  $("availability").value  = profile?.availability || "";
  $("interests").value     = Array.isArray(profile?.interests) ? profile.interests.join(", ") : "";
  $("countryOfOrigin").value = profile?.countryOfOrigin || "";
  $("visaMonths").value    = profile?.visaMonthsLeft != null ? String(profile.visaMonthsLeft) : "";
  $("about").value         = profile?.about || "";
  $("aboutCount").textContent = String(($("about").value || "").length);

  const firstChar = ($("alias").value || profile?.alias || "?")[0].toUpperCase();
  $("onboardAvatar").textContent = firstChar;

  if (role === "host") {
    $("onboardSub").textContent = "Tell potential au pairs about your family — anonymously.";
    $("aboutLabel").textContent = "About your family";
  } else {
    $("onboardSub").textContent = "Tell us about yourself — nothing here reveals your real identity.";
    $("aboutLabel").textContent = "About you";
  }

  updateAupairFields(role);
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderProfilePreview(profile) {
  const el = $("profilePreview");
  if (!el || !profile) return;

  const alias     = profile.alias || "Anonymous";
  const roleLabel = profile.role === "host" ? "Host Family" : "Au Pair";
  const tags      = (Array.isArray(profile.interests) ? profile.interests : [])
    .map(t => `<span class="interest-tag">${escHtml(t)}</span>`).join("");
  const isAupair  = profile.role !== "host";

  el.innerHTML = `
    <div class="profile-av">${escHtml(alias[0].toUpperCase())}</div>
    <h4>${escHtml(alias)}</h4>
    <span class="role-badge">${roleLabel}</span>
    ${profile.region       ? `<p class="meta-line"><svg class="meta-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z" clip-rule="evenodd"/></svg> ${escHtml(profile.region)}</p>` : ""}
    ${profile.availability ? `<p class="meta-line"><svg class="meta-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 000 2h8a1 1 0 100-2H6z" clip-rule="evenodd"/></svg> ${escHtml(profile.availability)}</p>` : ""}
    ${profile.countryOfOrigin ? `<p class="meta-line"><svg class="meta-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M3 6a3 3 0 013-3h10a1 1 0 01.8 1.6L14.25 8l2.55 3.4A1 1 0 0116 13H6a1 1 0 00-1 1v3a1 1 0 11-2 0V6z" clip-rule="evenodd"/></svg> From: ${escHtml(profile.countryOfOrigin)}</p>` : ""}
    ${isAupair && profile.visaMonthsLeft != null ? `<p class="meta-line"><svg class="meta-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clip-rule="evenodd"/></svg> ${escHtml(String(profile.visaMonthsLeft))} months on visa</p>` : ""}
    ${tags ? `<div class="interest-tags" style="margin-top:10px">${tags}</div>` : ""}
    ${profile.about ? `<p class="about-text">${escHtml(profile.about)}</p>` : ""}
  `;
}

// ── Discover: load candidates ─────────────────────────────────
async function loadCandidates() {
  if (!currentUser || !db) return;

  await updateLikeQuotaUI();

  const myMatchDocs = await fetchMatchesForUser(currentUser.uid);
  const activeMatchedUids = new Set();
  myMatchDocs.forEach((d) => {
    const m = d.data() || {};
    if (m.state === "unmatched") return;
    const otherUid = m.userA === currentUser.uid ? m.userB : m.userA;
    if (otherUid) activeMatchedUids.add(otherUid);
  });

  const mySnap = await getDoc(doc(db, "profiles", currentUser.uid));
  if (!mySnap.exists()) return;
  const actionedTargets = await getActionedTargetsForCurrentUser();

  const mine       = mySnap.data();
  const targetRole = mine.role === "aupair" ? "host" : "aupair";
  const roleLabel  = targetRole === "host" ? "host families" : "au pairs";
  const activeBuckets = getDiscoverBucketsForNow(currentUser.uid);
  $("discoverSub").textContent = `Showing rotating ${roleLabel} batch`;

  let snap;
  try {
    snap = await getDocs(query(
      collection(db, "profiles"),
      where("role", "==", targetRole),
      where("profileVisible", "==", true),
      where("serveBucket", "in", activeBuckets),
      limit(30)
    ));

    // Migration fallback for older profiles that don't have serveBucket yet.
    if (snap.empty) {
      snap = await getDocs(query(
        collection(db, "profiles"),
        where("role", "==", targetRole),
        where("profileVisible", "==", true),
        limit(30)
      ));
    }
  } catch (_err) {
    // Fallback if composite index is not ready yet.
    snap = await getDocs(query(
      collection(db, "profiles"),
      where("role", "==", targetRole),
      where("profileVisible", "==", true),
      limit(30)
    ));
  }

  const mineInterests = Array.isArray(mine.interests) ? mine.interests : [];
  const candidates = [];

  snap.forEach(d => {
    if (d.id === currentUser.uid) return;
    const actionState = actionedTargets.get(d.id) || null;
    const p = d.data();
    const theirInterests = Array.isArray(p.interests) ? p.interests : [];
    const overlap = theirInterests.filter(x => mineInterests.includes(x)).length;
    const sameRegion = (p.region || "").trim().toLowerCase() === (mine.region || "").trim().toLowerCase();
    const score = (sameRegion ? 1000 : 0) + (overlap * 20);
    candidates.push({
      uid: d.id, alias: p.alias || "anonymous",
      role: p.role, region: p.region || "",
      interests: theirInterests, availability: p.availability || "",
      countryOfOrigin: p.countryOfOrigin || "",
      visaMonthsLeft: p.visaMonthsLeft ?? null,
      about: p.about || "",
      actionState,
      matched: activeMatchedUids.has(d.id) || p.matchingState === "matched" || p.hasMatch === true,
      score,
      sameRegion,
      overlap
    });
  });

  const candidatesWithCooldown = await Promise.all(candidates.map(async (candidate) => ({
    ...candidate,
    blockedByCooldown: await isPairInCooldown(currentUser.uid, candidate.uid)
  })));

  const visibleCandidates = candidatesWithCooldown.filter((candidate) => !candidate.blockedByCooldown);
  visibleCandidates.sort((a, b) => b.score - a.score);

  const grid = $("candidates");
  grid.innerHTML = "";

  if (visibleCandidates.length === 0) {
    grid.innerHTML = `<p class="empty-state">No candidates available right now — check back later.</p>`;
    return;
  }

  visibleCandidates.slice(0, DISCOVER_RENDER_LIMIT).forEach(c => {
    const card = document.createElement("div");
    card.className = "candidate-card";
    const cRoleLabel = c.role === "host" ? "Host Family" : "Au Pair";
    const tags = c.interests.map(t => `<span class="interest-tag">${escHtml(t)}</span>`).join("");

    const visaLine = c.role === "aupair" && c.visaMonthsLeft != null
      ? `<span><svg class="meta-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clip-rule="evenodd"/></svg> ${escHtml(String(c.visaMonthsLeft))} mo. visa</span>` : "";
    const countryLine = c.countryOfOrigin
      ? `<span><svg class="meta-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M3 6a3 3 0 013-3h10a1 1 0 01.8 1.6L14.25 8l2.55 3.4A1 1 0 0116 13H6a1 1 0 00-1 1v3a1 1 0 11-2 0V6z" clip-rule="evenodd"/></svg> ${escHtml(c.countryOfOrigin)}</span>` : "";
    const liked = c.actionState === "like";
    const passed = c.actionState === "pass";
    const likeDisabled = c.matched || liked;
    const passDisabled = c.matched || passed;
    const likeLabel = c.matched ? "Matched" : (liked ? "Liked" : "💚 Like");
    const passLabel = passed ? "Passed" : "Pass";
    const actionBadge = c.matched
      ? '<span class="candidate-match-badge">Matched</span>'
      : (liked ? '<span class="candidate-match-badge">Liked</span>' : (passed ? '<span class="candidate-match-badge">Passed</span>' : ""));

    card.innerHTML = `
      <div class="candidate-top">
        <div class="candidate-avatar">${escHtml(c.alias[0].toUpperCase())}</div>
        <div class="candidate-meta">
          <strong>${escHtml(c.alias)} ${actionBadge}</strong>
          <div class="role-tag">${cRoleLabel}${countryLine ? " · " + countryLine : ""}${visaLine ? " · " + visaLine : ""}</div>
        </div>
      </div>
      ${c.region ? `<div class="region-line">📍 ${escHtml(c.region)}${c.availability ? " · " + escHtml(c.availability) : ""}${c.sameRegion ? " · ⭐ same location" : ""}${c.overlap ? ` · ${c.overlap} shared interests` : ""}</div>` : ""}
      ${c.about ? `<p class="candidate-about"><strong>About:</strong> ${escHtml(truncateText(c.about, 220))}</p>` : ""}
      ${tags ? `<div class="interest-tags">${tags}</div>` : ""}
      <div class="candidate-actions">
        <button class="btn-like" ${likeDisabled ? "disabled" : ""}>${likeLabel}</button>
        <button class="btn-pass" ${passDisabled ? "disabled" : ""}>${passLabel}</button>
      </div>
    `;

    const likeBtn = card.querySelector(".btn-like");
    if (!likeDisabled && likeBtn) {
      likeBtn.addEventListener("click", () => likeCandidate(c.uid, c.alias, card));
    }
    const passBtn = card.querySelector(".btn-pass");
    if (!passDisabled && passBtn) {
      passBtn.addEventListener("click", () => passCandidate(c.uid, card));
    }
    grid.appendChild(card);
  });
}

async function likeCandidate(targetUid, targetAlias, cardEl) {
  if (!currentUser || !db) return;

  const likeBtn = cardEl.querySelector(".btn-like");
  likeBtn.disabled    = true;
  likeBtn.textContent = "Liked ✓";

  const actionId  = `${currentUser.uid}_${targetUid}`;
  const reverseId = `${targetUid}_${currentUser.uid}`;

  try {
    const currentActionSnap = await getDoc(doc(db, "matchActions", actionId));
    const currentAction = currentActionSnap.exists() ? currentActionSnap.data().action : null;

    if (currentAction !== "like") {
      const likeCount = await getLikeCount(currentUser.uid);

      if (likeCount >= 3) {
        likeBtn.disabled = false;
        likeBtn.textContent = "💚 Like";
        toast("You can select up to 3 candidates. Pass or wait for a match.", "warning", 5500);
        await updateLikeQuotaUI();
        return;
      }
    }

    await setDoc(doc(db, "matchActions", actionId), {
      actorUid: currentUser.uid, targetUid, action: "like",
      createdAt: serverTimestamp()
    }, { merge: true });
    invalidateDiscoverActionCache();

    const reverse = await getDoc(doc(db, "matchActions", reverseId));
    const mutual  = reverse.exists() && reverse.data().action === "like";

    if (mutual) {
      const matchId = pairKey(currentUser.uid, targetUid);
      const sorted  = [currentUser.uid, targetUid].sort();

      await setDoc(doc(db, "matches", matchId), {
        matchId, userA: sorted[0], userB: sorted[1],
        state: "mutual_match", revealA: false, revealB: false,
        createdAt: serverTimestamp(), updatedAt: serverTimestamp()
      }, { merge: true });

      await setDoc(doc(db, "threads", matchId), {
        threadId: matchId, userA: sorted[0], userB: sorted[1],
        messageCount: 0,
        unreadCountA: 0,
        unreadCountB: 0,
        lastReadAtA: null,
        lastReadAtB: null,
        lastSenderUid: null,
        lastMessagePreview: "",
        createdAt: serverTimestamp(), updatedAt: serverTimestamp()
      }, { merge: true });

      await setDoc(doc(db, "profiles", currentUser.uid), {
        hasMatch: true,
        matchingState: "matched",
        profileVisible: true,
        updatedAt: serverTimestamp()
      }, { merge: true });

      invalidateMatchesCache();
      invalidateDiscoverActionCache();

      cardEl.innerHTML = `
        <div class="match-burst">
          <div class="match-emoji">💚</div>
          <strong>It's a match with ${escHtml(targetAlias)}!</strong>
          <p>Go to the Matches tab to start chatting.</p>
        </div>
      `;

      await updateLikeQuotaUI();
      toast("Mutual match created. You can continue discovering or open Matches.", "success", 5000);
    } else {
      cardEl.style.opacity = "0.5";
      await updateLikeQuotaUI();
    }
  } catch (err) {
    console.error("Like failed:", err);
    likeBtn.disabled    = false;
    likeBtn.textContent = "💚 Like";
  }
}

async function passCandidate(targetUid, cardEl) {
  if (!currentUser || !db) return;
  try {
    await setDoc(doc(db, "matchActions", `${currentUser.uid}_${targetUid}`), {
      actorUid: currentUser.uid, targetUid, action: "pass",
      createdAt: serverTimestamp()
    }, { merge: true });
    await updateLikeQuotaUI();
    invalidateDiscoverActionCache();
    cardEl.style.display = "none";
  } catch (err) {
    console.error("Pass failed:", err);
  }
}

// ── Matches & Chat ────────────────────────────────────────────
function renderMatchesList(matchEntries, resumeMatchId = "") {
  const list = $("matchesList");
  let resumeMatchData = null;
  let totalUnread = 0;

  if (!Array.isArray(matchEntries) || matchEntries.length === 0) {
    matchesUnreadTotal = 0;
    setMatchesTabUnreadBadge(0);
    list.innerHTML = `<p class="empty-state">No matches yet — start discovering!</p>`;
    return;
  }

  list.innerHTML = "";

  for (const entry of matchEntries) {
    const m = entry.match;
    const other = entry.other;
    const unreadCount = Number(entry.unreadCount || 0);
    totalUnread += unreadCount;

    const item = document.createElement("div");
    item.className = "match-item";

    const cRoleLabel = other.role === "host" ? "Host Family" : "Au Pair";
    const stateLabel = m.state === "unmatched"
      ? "Match closed"
      : (m.state === "revealed" ? "Identity revealed" : "Anonymous chat");
    const aboutPreview = truncateText(other.about || "", 120);

    item.innerHTML = `
      <div class="match-avatar">${escHtml((other.alias || "A")[0].toUpperCase())}</div>
      <div class="match-info">
        <strong>${escHtml(other.alias || "Anonymous")}${unreadCount > 0 ? ` <span class="candidate-match-badge">${unreadCount} new</span>` : ""}</strong>
        <small>${cRoleLabel} · ${stateLabel}</small>
        ${aboutPreview ? `<p class="match-about">${escHtml(aboutPreview)}</p>` : ""}
      </div>
      <span class="match-chevron">${m.state === "unmatched" ? "🔒" : "›"}</span>
    `;

    if (m.state === "unmatched") item.classList.add("closed");

    item.addEventListener("click", () => openChat(m.matchId, other, m.state || "mutual_match", unreadCount));
    list.appendChild(item);

    if (m.matchId === resumeMatchId) {
      resumeMatchData = { matchId: m.matchId, other, state: m.state || "mutual_match", unreadCount };
    }
  }

  matchesUnreadTotal = totalUnread;
  setMatchesTabUnreadBadge(totalUnread);

  if (resumeMatchData) {
    openChat(resumeMatchData.matchId, resumeMatchData.other, resumeMatchData.state, resumeMatchData.unreadCount || 0);
  }
}

async function loadMatches(force = false) {
  if (!currentUser || !db) return;

  const resumeMatchId = storedMatchId();
  const cacheFresh = !force
    && Array.isArray(matchesCacheEntries)
    && (Date.now() - matchesCacheAtMs) < MATCHES_CACHE_TTL_MS;

  if (cacheFresh) {
    renderMatchesList(matchesCacheEntries, resumeMatchId);
    return;
  }

  const [snapA, snapB] = await Promise.all([
    getDocs(query(collection(db, "matches"), where("userA", "==", currentUser.uid))),
    getDocs(query(collection(db, "matches"), where("userB", "==", currentUser.uid)))
  ]);

  const matchDocs = [...snapA.docs, ...snapB.docs];
  if (matchDocs.length === 0) {
    matchesCacheEntries = [];
    matchesCacheAtMs = Date.now();
    renderMatchesList([], resumeMatchId);
    return;
  }

  const entries = [];
  for (const matchDoc of matchDocs) {
    const m        = matchDoc.data();
    const otherUid = m.userA === currentUser.uid ? m.userB : m.userA;

    const otherSnap = await getDoc(doc(db, "profiles", otherUid));
    const otherData = otherSnap.exists() ? otherSnap.data() : { alias: "Anonymous", role: "aupair" };
    const other     = { uid: otherUid, ...otherData };
    const threadSnap = await getDoc(doc(db, "threads", m.matchId));
    const threadData = threadSnap.exists() ? threadSnap.data() : { userA: m.userA, userB: m.userB };
    const unreadCount = m.state === "unmatched" ? 0 : getUnreadCountForUid(threadData, currentUser.uid);

    entries.push({
      match: { matchId: m.matchId, state: m.state || "mutual_match" },
      other,
      unreadCount
    });
  }

  matchesCacheEntries = entries;
  matchesCacheAtMs = Date.now();
  renderMatchesList(entries, resumeMatchId);
}

function setChatComposerEnabled(enabled, placeholder = "Type a message…") {
  const textEl = $("messageText");
  const sendEl = $("sendMessageBtn");
  if (!textEl || !sendEl) return;
  textEl.disabled = !enabled;
  sendEl.disabled = !enabled;
  textEl.placeholder = placeholder;
}

function setMatchesTabUnreadBadge(count) {
  const btn = document.querySelector('.nav-btn[data-tab="matches"]');
  if (!btn) return;

  const normalized = Number(count) > 0 ? Number(count) : 0;
  const labelEl = btn.querySelector("span");
  if (!labelEl) return;

  const currentLabel = (labelEl.textContent || "").trim();
  const base = btn.dataset.baseLabel || currentLabel.replace(/\s*\(\d+\)\s*$/, "").trim() || "Matches";
  btn.dataset.baseLabel = base;
  labelEl.textContent = normalized > 0 ? `${base} (${normalized})` : base;
}

function getThreadRoleForUid(threadLike, uid) {
  if (!threadLike || !uid) return null;
  if (threadLike.userA === uid) return "A";
  if (threadLike.userB === uid) return "B";
  return null;
}

function getUnreadCountForUid(threadLike, uid) {
  const role = getThreadRoleForUid(threadLike, uid);
  if (role === "A") return Number(threadLike.unreadCountA || 0);
  if (role === "B") return Number(threadLike.unreadCountB || 0);
  return 0;
}

async function markThreadRead(threadId) {
  if (!currentUser || !db || !threadId) return;

  try {
    const threadRef = doc(db, "threads", threadId);
    const snap = await getDoc(threadRef);
    if (!snap.exists()) return;

    const t = snap.data();
    const role = getThreadRoleForUid(t, currentUser.uid);
    if (!role) return;

    const unread = role === "A"
      ? Number(t.unreadCountA || 0)
      : Number(t.unreadCountB || 0);

    if (unread <= 0) return;

    const patch = {
      updatedAt: serverTimestamp()
    };
    if (role === "A") {
      patch.unreadCountA = 0;
      patch.lastReadAtA = serverTimestamp();
    } else {
      patch.unreadCountB = 0;
      patch.lastReadAtB = serverTimestamp();
    }

    await updateDoc(threadRef, patch);
    invalidateMatchesCache();
  } catch (_err) {
    // Non-critical: unread indicators can recover on next refresh.
  }
}

function stopChatRealtime() {
  if (typeof unsubChatMessages === "function") {
    unsubChatMessages();
  }
  if (typeof unsubMatchState === "function") {
    unsubMatchState();
  }
  unsubChatMessages = null;
  unsubMatchState = null;
  lastChatRenderKey = "";
  currentChatParticipants = [];
}

function applyChatStateUI(matchState) {
  const isClosed = matchState === "unmatched";

  if (isClosed) {
    $("chatClosedBanner").classList.remove("hidden");
    $("chatActions").classList.add("hidden");
    setChatComposerEnabled(false, "This chat is closed.");
  } else {
    $("chatClosedBanner").classList.add("hidden");
    $("chatActions").classList.remove("hidden");
    setChatComposerEnabled(true, "Type a message…");
  }
}

function renderChatMessages(msgs) {
  const container = $("chatMessages");
  if (!container) return;

  const last = msgs.length ? msgs[msgs.length - 1] : null;
  const nextKey = `${msgs.length}:${last?.id || ""}:${last?.createdAt?.seconds || 0}`;
  if (nextKey === lastChatRenderKey) return;
  lastChatRenderKey = nextKey;

  container.innerHTML = "";
  if (msgs.length === 0) {
    container.innerHTML = `<p class="empty-state" style="padding:16px 0">No messages yet - say hello!</p>`;
    return;
  }

  msgs.forEach(msg => {
    const div = document.createElement("div");
    div.className = `chat-msg ${msg.senderUid === currentUser.uid ? "mine" : "theirs"}`;
    div.textContent = msg.text || "";
    container.appendChild(div);
  });

  container.scrollTop = container.scrollHeight;
}

function subscribeChatMessages(matchId) {
  // Preferred low-read query: only this thread.
  const preferredQuery = query(
    collection(db, "messages"),
    where("threadId", "==", matchId),
    limit(120)
  );

  let fallbackAttached = false;

  const attachFallback = () => {
    if (fallbackAttached) return;
    fallbackAttached = true;

    const fallbackQuery = query(
      collection(db, "messages"),
      where("participants", "array-contains", currentUser.uid),
      limit(300)
    );

    unsubChatMessages = onSnapshot(fallbackQuery, (snap) => {
      const msgs = [];
      snap.forEach((d) => {
        const data = d.data();
        if (data.threadId === matchId) msgs.push({ id: d.id, ...data });
      });
      msgs.sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
      renderChatMessages(msgs);
      setChatStatus("");
    }, (err) => {
      console.error("Realtime fallback listener failed:", err);
      setChatStatus("Could not load live chat updates.", "error");
      toast("Live chat unavailable right now.", "error", 4500);
    });
  };

  unsubChatMessages = onSnapshot(preferredQuery, (snap) => {
    const msgs = [];
    snap.forEach((d) => msgs.push({ id: d.id, ...d.data() }));
    msgs.sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
    renderChatMessages(msgs);
    setChatStatus("");
  }, (err) => {
    console.warn("Preferred realtime query failed, using fallback:", err);
    attachFallback();
  });
}

function startChatRealtime(matchId) {
  if (!currentUser || !db || !matchId) return;
  stopChatRealtime();

  // Avoid reads while tab is in the background.
  if (document.hidden) return;

  setChatStatus("Connecting live chat...", "info");
  subscribeChatMessages(matchId);

  unsubMatchState = onSnapshot(doc(db, "matches", matchId), (snap) => {
    if (!snap.exists()) {
      currentMatchState = "unmatched";
      applyChatStateUI("unmatched");
      setChatStatus("This match no longer exists.", "error");
      return;
    }

    const data = snap.data() || {};
    const state = data.state || "mutual_match";
    currentChatParticipants = [data.userA, data.userB].filter(Boolean);
    currentMatchState = state;
    applyChatStateUI(state);
  }, (err) => {
    console.error("Match state listener failed:", err);
  });
}

async function openChat(matchId, otherProfile, matchState = "mutual_match", initialUnread = 0) {
  const isClosed = matchState === "unmatched";

  // First-time chat: show community guidelines gate
  if (!isClosed && !hasChatRulesAccepted()) {
    const accepted = await ensureChatRulesAccepted(matchId);
    if (!accepted) return;
  }

  const alias = typeof otherProfile === "string"
    ? otherProfile
    : (otherProfile?.alias || "Anonymous");
  const roleLabel = (typeof otherProfile === "object" && otherProfile?.role === "host")
    ? "Host Family"
    : "Au Pair";
  const aboutPreview = typeof otherProfile === "object"
    ? truncateText(otherProfile?.about || "", 160)
    : "";

  currentMatchId = matchId;
  currentMatchState = matchState;
  currentChatParticipants =
    (otherProfile && otherProfile.uid)
      ? [currentUser.uid, otherProfile.uid].filter(Boolean).sort()
      : [];
  setStoredMatchId(matchId);
  $("chatMatchHeader").innerHTML = `
    <strong>Chat with ${escHtml(alias)}${isClosed ? ' <span class="chat-header-closed">· Closed</span>' : ""}</strong>
    <div class="chat-match-sub">${escHtml(roleLabel)}${aboutPreview ? " · " + escHtml(aboutPreview) : ""}</div>
  `;
  $("matchesList").style.display   = "none";
  $("chatPanel").classList.remove("hidden");
  $("view-app").classList.add("chat-open");

  applyChatStateUI(matchState);
  setChatStatus("");
  resizeMessageInput();
  startChatRealtime(matchId);
  if (!isClosed) {
    markThreadRead(matchId);
    if (initialUnread > 0) {
      matchesUnreadTotal = Math.max(0, matchesUnreadTotal - Number(initialUnread));
      setMatchesTabUnreadBadge(matchesUnreadTotal);
      if (Array.isArray(matchesCacheEntries)) {
        matchesCacheEntries = matchesCacheEntries.map((entry) => {
          if (entry?.match?.matchId !== matchId) return entry;
          return { ...entry, unreadCount: 0 };
        });
      }
    }
  }
}

function setChatStatus(text, tone = "info") {
  const el = $("chatStatus");
  if (!el) return;
  el.textContent = text;
  el.className = `chat-status ${tone}`;
}

function resizeMessageInput() {
  const input = $("messageText");
  if (!input) return;

  const maxPx = 96;
  input.style.height = "auto";
  const nextHeight = Math.min(input.scrollHeight, maxPx);
  input.style.height = `${nextHeight}px`;
  input.style.overflowY = input.scrollHeight > maxPx ? "auto" : "hidden";
}

async function loadMessages(matchId) {
  if (!currentUser || !db) return;

  try {
    // Rules allow reads only when auth uid is in participants, so query by that first.
    const snap = await getDocs(
      query(
        collection(db, "messages"),
        where("participants", "array-contains", currentUser.uid),
        limit(300)
      )
    );

    const msgs = [];
    snap.forEach(d => {
      const data = d.data();
      if (data.threadId === matchId) {
        msgs.push({ id: d.id, ...data });
      }
    });
    msgs.sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));

    const container = $("chatMessages");
    container.innerHTML = "";

    if (msgs.length === 0) {
      container.innerHTML = `<p class="empty-state" style="padding:16px 0">No messages yet — say hello!</p>`;
      return;
    }

    msgs.forEach(msg => {
      const div = document.createElement("div");
      div.className = `chat-msg ${msg.senderUid === currentUser.uid ? "mine" : "theirs"}`;
      div.textContent = msg.text || "";
      container.appendChild(div);
    });

    container.scrollTop = container.scrollHeight;
  } catch (err) {
    console.error("Load messages failed:", err);
    setChatStatus("Could not load chat messages. Please try again.", "error");
    toast("Could not load chat messages.", "error", 4500);
  }
}

async function sendMessage(matchId, text) {
  if (!currentUser || !db || !text.trim()) return;

  const trimmedText = text.trim().slice(0, 2000);

  if (currentMatchState === "unmatched") {
    throw new Error("This chat is closed because the match was removed.");
  }

  let participants = Array.isArray(currentChatParticipants)
    ? currentChatParticipants.filter(Boolean)
    : [];

  // Fallback for first send before realtime match snapshot arrives.
  if (participants.length < 2) {
    const matchSnap = await getDoc(doc(db, "matches", matchId));
    if (!matchSnap.exists()) {
      throw new Error("Match no longer exists");
    }
    const matchData = matchSnap.data();
    if (matchData.state === "unmatched") {
      currentMatchState = "unmatched";
      setChatComposerEnabled(false, "This chat is closed after unmatch.");
      throw new Error("This chat is closed because the match was removed.");
    }
    participants = [matchData.userA, matchData.userB].filter(Boolean);
    currentChatParticipants = participants;
  }
  if (!participants.includes(currentUser.uid)) {
    throw new Error("You are not part of this conversation");
  }

  await addDoc(collection(db, "messages"), {
    threadId:  matchId,
    participants,
    senderUid: currentUser.uid,
    text:      trimmedText,
    createdAt: serverTimestamp()
  });

  const sortedParticipants = [...participants].sort();
  const senderIsA = sortedParticipants[0] === currentUser.uid;

  const threadPatch = {
    messageCount:  increment(1),
    lastMessageAt: serverTimestamp(),
    lastSenderUid: currentUser.uid,
    lastMessagePreview: trimmedText.slice(0, 80),
    updatedAt:     serverTimestamp()
  };

  if (senderIsA) {
    threadPatch.unreadCountB = increment(1);
    threadPatch.lastReadAtA = serverTimestamp();
  } else {
    threadPatch.unreadCountA = increment(1);
    threadPatch.lastReadAtB = serverTimestamp();
  }

  await updateDoc(doc(db, "threads", matchId), {
    ...threadPatch
  });
}

// ── Close match / Report ──────────────────────────────────────

function showReportModal() {
  return new Promise((resolve) => {
    const modal   = $("reportModal");
    if (!modal) {
      resolve(null);
      return;
    }
    const confirm = $("reportModalConfirm");
    const cancel  = $("reportModalCancel");
    const radios  = modal.querySelectorAll("input[name='reportReason']");

    // Reset state
    radios.forEach(r => { r.checked = false; });
    confirm.disabled = true;

    const onChange = () => { confirm.disabled = !modal.querySelector("input[name='reportReason']:checked"); };
    radios.forEach(r => r.addEventListener("change", onChange));

    const cleanup = (result) => {
      radios.forEach(r => r.removeEventListener("change", onChange));
      modal.classList.remove("active");
      modal.hidden = true;
      modal.setAttribute("aria-hidden", "true");
      resolve(result);
    };

    confirm.onclick = () => {
      const checked = modal.querySelector("input[name='reportReason']:checked");
      cleanup(checked ? checked.value : null);
    };
    cancel.onclick = () => cleanup(null);

    modal.classList.add("active");
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
  });
}

function showFeedbackModal() {
  return new Promise((resolve) => {
    const modal = $("feedbackModal");
    if (!modal) {
      resolve(null);
      return;
    }
    const textEl = $("feedbackText");
    const countEl = $("feedbackCount");
    const confirm = $("feedbackModalConfirm");
    const cancel = $("feedbackModalCancel");

    const updateState = () => {
      const text = (textEl.value || "").trim();
      countEl.textContent = String(textEl.value.length);
      confirm.disabled = text.length < 10;
    };

    textEl.value = "";
    countEl.textContent = "0";
    confirm.disabled = true;
    textEl.addEventListener("input", updateState);

    const cleanup = (result) => {
      textEl.removeEventListener("input", updateState);
      modal.classList.remove("active");
      modal.hidden = true;
      modal.setAttribute("aria-hidden", "true");
      resolve(result);
    };

    confirm.onclick = () => cleanup((textEl.value || "").trim());
    cancel.onclick = () => cleanup(null);

    modal.classList.add("active");
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    textEl.focus();
  });
}

async function sendFeedback() {
  if (!currentUser || !db) return;
  const feedbackText = await showFeedbackModal();
  if (!feedbackText) return;

  const triage = autoTriageFeedback(feedbackText);

  await addDoc(collection(db, "feedbackMessages"), {
    uid: currentUser.uid,
    email: currentUser.email || null,
    text: feedbackText.slice(0, 600),
    status: "todo",
    autoPriority: triage.priority,
    autoTags: triage.tags,
    autoRoute: triage.route,
    createdAt: serverTimestamp()
  });

  toast("Thanks for your feedback. Admin has received it.", "success", 4500);
}

function autoTriageFeedback(text) {
  const t = String(text || "").toLowerCase();
  const tags = [];
  let priority = "normal";
  let route = "product";

  if (/(crash|error|broken|bug|cannot|can't|not work|fail)/.test(t)) {
    tags.push("bug");
    priority = "high";
    route = "technical";
  }
  if (/(abuse|unsafe|threat|harass|scam|fraud)/.test(t)) {
    tags.push("safety");
    priority = "urgent";
    route = "safety";
  }
  if (/(feature|idea|improve|suggest)/.test(t)) {
    tags.push("feature");
  }

  if (tags.length === 0) tags.push("general");
  return { priority, tags: Array.from(new Set(tags)), route };
}

function abusePriorityFromReason(reason) {
  if (reason === "harassment") return "urgent";
  if (reason === "inappropriate") return "high";
  if (reason === "fake_profile") return "high";
  return "normal";
}

async function closeCurrentMatch(closeReason = "not_a_fit") {
  if (!currentUser || !db || !currentMatchId) return;

  const isReport = closeReason !== "not_a_fit";
  const confirmText = isReport
    ? "This will close the chat and submit your safety report to the admin team."
    : "End this match? The chat will close for both of you.";
  const confirmLabel = isReport ? "Submit report & close" : "End match";

  const ok = await showConfirm(confirmText, confirmLabel, true);
  if (!ok) return;

  const matchRef  = doc(db, "matches", currentMatchId);
  const matchSnap = await getDoc(matchRef);
  if (!matchSnap.exists()) {
    toast("This match was already removed.", "warning", 4500);
    return;
  }

  const matchData = matchSnap.data();
  if (matchData.userA !== currentUser.uid && matchData.userB !== currentUser.uid) {
    toast("You are not allowed to close this conversation.", "error", 4500);
    return;
  }
  if (matchData.state === "unmatched") {
    currentMatchState = "unmatched";
    setChatComposerEnabled(false, "This chat is already closed.");
    setCloseButtonsDisabled(true);
    setChatStatus("This match was already closed.", "info");
    return;
  }

  const otherUid   = matchData.userA === currentUser.uid ? matchData.userB : matchData.userA;
  const cooldownMs = UNMATCH_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

  await updateDoc(matchRef, {
    state: "unmatched",
    closedBy: currentUser.uid,
    closeReason,
    closedAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });

  await setDoc(doc(db, "unmatchPairs", pairKey(currentUser.uid, otherUid)), {
    pairId: pairKey(currentUser.uid, otherUid),
    userA: [currentUser.uid, otherUid].sort()[0],
    userB: [currentUser.uid, otherUid].sort()[1],
    closedBy: currentUser.uid,
    createdAt: serverTimestamp(),
    expiresAtMs: Date.now() + cooldownMs
  }, { merge: true });

  // Closing a match should free this slot from the "Selected" quota.
  await setDoc(doc(db, "matchActions", `${currentUser.uid}_${otherUid}`), {
    actorUid: currentUser.uid,
    targetUid: otherUid,
    action: "pass",
    createdAt: serverTimestamp()
  }, { merge: true });

  if (isReport) {
    const autoPriority = abusePriorityFromReason(closeReason);
    await addDoc(collection(db, "abuseReports"), {
      reporterUid: currentUser.uid,
      reportedUid: otherUid,
      matchId: currentMatchId,
      reason: closeReason,
      status: "pending",
      autoPriority,
      autoRoute: "safety",
      createdAt: serverTimestamp()
    });
  }

  const active = await hasActiveMatch(currentUser.uid);
  await setDoc(doc(db, "profiles", currentUser.uid), {
    hasMatch: active,
    matchingState: active ? "matched" : "discoverable",
    profileVisible: true,
    updatedAt: serverTimestamp()
  }, { merge: true });

  currentMatchState = "unmatched";
  setChatComposerEnabled(false, "This chat is now closed.");
  setCloseButtonsDisabled(true);
  $("revealBtn").disabled = true;

  if (isReport) {
    setChatStatus("Report submitted. Thank you — the chat is now closed.", "info");
    toast("Safety report submitted and chat closed.", "success", 5000);
  } else {
    setChatStatus("You ended this match. Chat is now closed.", "info");
    toast("Match ended. You can continue discovering others.", "success", 5000);
  }

  invalidateMatchesCache();
  invalidateDiscoverActionCache();
  await Promise.all([loadMatches(), loadCandidates(), updateLikeQuotaUI()]);
}

function setCloseButtonsDisabled(disabled) {
  const btn1 = $("closeMatchBtn");
  const btn2 = $("reportCloseBtn");
  if (btn1) btn1.disabled = disabled;
  if (btn2) btn2.disabled = disabled;
}

async function revealConsent(matchId) {
  if (!currentUser || !db) return;

  const matchRef  = doc(db, "matches", matchId);
  const matchSnap = await getDoc(matchRef);
  if (!matchSnap.exists()) return;

  const m = matchSnap.data();
  if (m.userA !== currentUser.uid && m.userB !== currentUser.uid) return;

  const patch = { updatedAt: serverTimestamp() };
  if (m.userA === currentUser.uid) patch.revealA = true;
  else                              patch.revealB = true;

  await updateDoc(matchRef, patch);
  invalidateMatchesCache();

  const updated = (await getDoc(matchRef)).data();
  if (updated.revealA && updated.revealB && updated.state !== "revealed") {
    await updateDoc(matchRef, { state: "revealed", updatedAt: serverTimestamp() });
    setChatStatus("Both of you consented. You can now share contact details.", "success");
    toast("Both of you consented! You can now share contact details in chat.", "success", 6000);
  } else {
    setChatStatus("Consent saved. Waiting for the other person.", "info");
    toast("Your consent to reveal has been recorded. Waiting for the other person.", "info", 5000);
  }
}

async function requestDelete() {
  if (!currentUser || !db) return;
  const ok = await showConfirm(
    "This will hide your profile and queue all your data for deletion. This cannot be undone.",
    "Delete my data",
    true
  );
  if (!ok) return;

  await setDoc(doc(db, "deletionQueue", currentUser.uid), {
    uid: currentUser.uid, status: "pending",
    requestedAt: serverTimestamp()
  });

  await updateDoc(doc(db, "profiles", currentUser.uid), {
    profileVisible: false, updatedAt: serverTimestamp()
  });

  toast("Deletion request submitted. Your profile is now hidden.", "info", 5000);
  await signOut(auth);
}

// ── Admin Dashboard ───────────────────────────────────────────

async function loadAdminDashboard() {
  $("adminStatus").textContent = "";
  $("adminLastRefresh").textContent = "Loading…";

  try {
    const [profileSnap, matchSnap, deletionSnap, cooldownSnap, abuseSnap, feedbackSnap] = await Promise.all([
      getDocs(collection(db, "profiles")),
      getDocs(collection(db, "matches")),
      getDocs(collection(db, "deletionQueue")),
      getDocs(collection(db, "unmatchPairs")),
      getDocs(collection(db, "abuseReports")),
      getDocs(collection(db, "feedbackMessages")),
    ]);

    let aupairs = 0, hosts = 0, visible = 0;
    profileSnap.forEach(d => {
      const p = d.data();
      if (p.role === "aupair") aupairs++; else hosts++;
      if (p.profileVisible) visible++;
    });

    let activeMatches = 0, closedMatches = 0;
    matchSnap.forEach(d => {
      if (d.data().state === "unmatched") closedMatches++; else activeMatches++;
    });

    const now = Date.now();
    let expiredCooldowns = 0;
    cooldownSnap.forEach(d => {
      if (Number(d.data().expiresAtMs || 0) < now) expiredCooldowns++;
    });

    const deletionPending = [];
    deletionSnap.forEach(d => {
      if (d.data().status === "pending") deletionPending.push({ id: d.id, ...d.data() });
    });

    const abusePending = [];
    abuseSnap.forEach(d => {
      const data = d.data();
      if (data.status === "pending") abusePending.push({ id: d.id, ...data, autoPriority: data.autoPriority || abusePriorityFromReason(data.reason) });
    });

    abusePending.sort((a, b) => {
      const p = PRIORITY_SCORE[b.autoPriority] - PRIORITY_SCORE[a.autoPriority];
      if (p !== 0) return p;
      return (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0);
    });

    const feedbackItems = [];
    let feedbackTodo = 0;
    let feedbackDoing = 0;
    let feedbackDone = 0;
    feedbackSnap.forEach(d => {
      const data = d.data();
      const status = data.status || "todo";
      feedbackItems.push({ id: d.id, ...data, status });
      if (status === "todo") feedbackTodo += 1;
      else if (status === "doing") feedbackDoing += 1;
      else if (status === "done") feedbackDone += 1;
    });

    feedbackItems.sort((a, b) => {
      const p = PRIORITY_SCORE[b.autoPriority || "normal"] - PRIORITY_SCORE[a.autoPriority || "normal"];
      if (p !== 0) return p;
      return (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0);
    });

    $("adminStatUsers").textContent     = String(profileSnap.size);
    $("adminStatAupairs").textContent   = String(aupairs);
    $("adminStatHosts").textContent     = String(hosts);
    $("adminStatVisible").textContent   = String(visible);
    $("adminStatMatches").textContent   = String(matchSnap.size);
    $("adminStatActive").textContent    = String(activeMatches);
    $("adminStatClosed").textContent    = String(closedMatches);
    $("adminStatDeletions").textContent = String(deletionPending.length);
    $("adminStatAbuse").textContent     = String(abusePending.length);
    $("adminStatFeedback").textContent  = String(feedbackItems.length);
    $("adminFeedbackTodoCount").textContent = String(feedbackTodo);
    $("adminFeedbackDoingCount").textContent = String(feedbackDoing);
    $("adminFeedbackDoneCount").textContent = String(feedbackDone);
    $("adminExpiredCooldownCount").textContent = String(expiredCooldowns);

    const purgeBtn = $("adminPurgeCooldownsBtn");
    if (purgeBtn) purgeBtn.disabled = expiredCooldowns === 0;

    renderAdminDeletionQueue(deletionPending);
    renderAdminAbuseReports(abusePending);
    renderAdminFeedback(feedbackItems);

    $("adminLastRefresh").textContent = `Last refreshed: ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    console.error("Admin dashboard load failed:", err);
    $("adminStatus").textContent = "Failed to load dashboard data. Check the console for details.";
    $("adminLastRefresh").textContent = "Failed";
  }
}

function fmtTs(ts) {
  if (!ts) return "—";
  const ms = ts?.seconds ? ts.seconds * 1000 : Number(ts);
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function renderAdminDeletionQueue(items) {
  const container = $("adminDeletionList");
  if (!container) return;
  if (items.length === 0) {
    container.innerHTML = `<p class="empty-state">No pending deletion requests.</p>`;
    return;
  }
  container.innerHTML = items.map(item => `
    <div class="admin-deletion-item" id="del-item-${escHtml(item.id)}">
      <div class="admin-deletion-meta">
        <code class="admin-uid">${escHtml(item.id)}</code>
        <span class="admin-del-date">Requested ${fmtTs(item.requestedAt)}</span>
      </div>
      <button class="btn-danger btn-sm" data-action="process-deletion" data-uid="${escHtml(item.id)}">
        Hide + Mark done
      </button>
    </div>
  `).join("");
}

const ABUSE_REASON_LABELS = {
  inappropriate: "Inappropriate or offensive messages",
  harassment:    "Harassment or threatening behaviour",
  fake_profile:  "Fake or misleading profile",
  other:         "Other safety concern",
};

function renderAdminAbuseReports(items) {
  const container = $("adminAbuseList");
  if (!container) return;
  if (items.length === 0) {
    container.innerHTML = `<p class="empty-state">No pending safety reports.</p>`;
    return;
  }
  container.innerHTML = items.map(item => `
    <div class="admin-deletion-item" id="abuse-item-${escHtml(item.id)}">
      <div class="admin-deletion-meta">
        <strong class="abuse-reason-label">${escHtml(ABUSE_REASON_LABELS[item.reason] || item.reason)}</strong>
        <span class="admin-del-date">Priority: <span class="feedback-status ${escHtml(item.autoPriority || "normal")}">${escHtml(item.autoPriority || "normal")}</span></span>
        <span class="admin-del-date">Match: <code class="admin-uid">${escHtml(item.matchId || "—")}</code></span>
        <span class="admin-del-date">Reported ${fmtTs(item.createdAt)}</span>
      </div>
      <button class="btn-secondary btn-sm" data-action="review-report" data-id="${escHtml(item.id)}">
        Mark reviewed
      </button>
    </div>
  `).join("");
}

function renderAdminFeedback(items) {
  const container = $("adminFeedbackList");
  if (!container) return;
  if (items.length === 0) {
    container.innerHTML = `<p class="empty-state">No user feedback yet.</p>`;
    return;
  }
  container.innerHTML = items.map(item => `
    <div class="admin-deletion-item" id="feedback-item-${escHtml(item.id)}">
      <div class="admin-deletion-meta">
        <strong class="abuse-reason-label">${escHtml((item.text || "").slice(0, 220))}</strong>
        <span class="admin-del-date">Priority: <span class="feedback-status ${escHtml(item.autoPriority || "normal")}">${escHtml(item.autoPriority || "normal")}</span> · Route: ${escHtml(item.autoRoute || "product")}</span>
        <span class="admin-del-date">From UID: <code class="admin-uid">${escHtml(item.uid || "—")}</code></span>
        <span class="admin-del-date">Submitted ${fmtTs(item.createdAt)} · Status: <span class="feedback-status ${escHtml(item.status)}">${escHtml(item.status)}</span></span>
      </div>
      <div class="feedback-actions">
        <button class="btn-secondary btn-sm" data-action="set-feedback-status" data-id="${escHtml(item.id)}" data-status="todo" ${item.status === "todo" ? "disabled" : ""}>To do</button>
        <button class="btn-secondary btn-sm" data-action="set-feedback-status" data-id="${escHtml(item.id)}" data-status="doing" ${item.status === "doing" ? "disabled" : ""}>Doing</button>
        <button class="btn-secondary btn-sm" data-action="set-feedback-status" data-id="${escHtml(item.id)}" data-status="done" ${item.status === "done" ? "disabled" : ""}>Done</button>
      </div>
    </div>
  `).join("");
}

async function markReportReviewed(reportId) {
  try {
    await setDoc(doc(db, "abuseReports", reportId), { status: "reviewed", reviewedAt: serverTimestamp() }, { merge: true });
    const el = $(`abuse-item-${reportId}`);
    if (el) el.remove();
    const stat = $("adminStatAbuse");
    if (stat) stat.textContent = String(Math.max(0, Number(stat.textContent) - 1));
    toast("Report marked as reviewed.", "success", 3000);
  } catch (err) {
    console.error("markReportReviewed error:", err);
    toast("Failed: " + (err.message || "unknown error"), "error", 5000);
  }
}

async function setFeedbackStatus(feedbackId, status) {
  if (!["todo", "doing", "done"].includes(status)) return;
  try {
    await setDoc(doc(db, "feedbackMessages", feedbackId), {
      status,
      updatedAt: serverTimestamp(),
      doneAt: status === "done" ? serverTimestamp() : null
    }, { merge: true });
    toast(`Feedback moved to ${status}.`, "success", 2200);
    await loadAdminDashboard();
  } catch (err) {
    console.error("setFeedbackStatus error:", err);
    toast("Failed: " + (err.message || "unknown error"), "error", 5000);
  }
}

async function processDeletion(uid) {
  const ok = await showConfirm(
    `Hide profile and mark deletion as processed?\nUID: ${uid}`,
    "Confirm",
    true
  );
  if (!ok) return;
  try {
    await Promise.all([
      setDoc(doc(db, "profiles", uid), { profileVisible: false, updatedAt: serverTimestamp() }, { merge: true }),
      setDoc(doc(db, "deletionQueue", uid), { status: "processed", processedAt: serverTimestamp() }, { merge: true }),
    ]);
    const el = $(`del-item-${uid}`);
    if (el) el.remove();
    const stat = $("adminStatDeletions");
    if (stat) stat.textContent = String(Math.max(0, Number(stat.textContent) - 1));
    toast("Profile hidden and marked as processed.", "success", 4500);
  } catch (err) {
    console.error("processDeletion error:", err);
    toast("Failed: " + (err.message || "unknown error"), "error", 5000);
  }
}

async function purgeExpiredCooldowns() {
  const btn = $("adminPurgeCooldownsBtn");
  if (btn) { btn.disabled = true; btn.textContent = "Purging…"; }
  try {
    const snap = await getDocs(collection(db, "unmatchPairs"));
    const now = Date.now();
    const staleIds = [];
    snap.forEach(d => {
      if (Number(d.data().expiresAtMs || 0) < now) staleIds.push(d.id);
    });
    await Promise.all(staleIds.map(id => deleteDoc(doc(db, "unmatchPairs", id))));
    toast(`Purged ${staleIds.length} expired cooldown${staleIds.length !== 1 ? "s" : ""}.`, "success", 4500);
    await loadAdminDashboard();
  } catch (err) {
    console.error("purgeExpiredCooldowns error:", err);
    toast("Purge failed: " + (err.message || "unknown error"), "error", 5000);
    if (btn) { btn.disabled = false; btn.textContent = "Purge expired"; }
  }
}

// ── Event Listeners ───────────────────────────────────────────

$("pickAupair").addEventListener("click", () => {
  selectedRole = "aupair";
  $("role").value                = "aupair";
  $("authRoleBadge").textContent = "Au Pair";
  updateAupairFields("aupair");
  showView("view-auth");
});

$("pickHost").addEventListener("click", () => {
  selectedRole = "host";
  $("role").value                = "host";
  $("authRoleBadge").textContent = "Host Family";
  updateAupairFields("host");
  showView("view-auth");
});

$("authBack").addEventListener("click", () => showView("view-landing"));

$("loginBtn").addEventListener("click", async () => {
  if (!auth) return;
  if (!validateLegalChecks()) return;
  if (useLocalEmulators) {
    toast("Use the demo login button when running locally.", "warning");
    return;
  }
  try {
    await signInWithPopup(auth, provider);
  } catch (err) {
    console.error("Login failed:", err);
    const msg = err.message?.includes("configuration-not-found")
      ? "Firebase Auth not configured. Enable Google sign-in in Firebase Console \u2192 Authentication."
      : (err.message || "Sign-in failed");
    toast(msg, "error", 8000);
  }
});

$("demoLoginBtn").addEventListener("click", async () => {
  if (!auth) return;
  if (!validateLegalChecks()) return;
  try {
    await signInAnonymously(auth);
  } catch (err) {
    console.error("Demo login failed:", err);
    toast(err.message || "Demo login failed", "error");
  }
});

$("logoutBtn").addEventListener("click", async () => {
  if (!auth) return;
  const ok = await showConfirm("Sign out of AuPair Rematch?", "Sign out", false);
  if (ok) await signOut(auth);
});

$("onboardBack").addEventListener("click", async () => {
  if (isEditingProfile) {
    isEditingProfile = false;
    showView("view-app");
    showTab("profile");
  } else {
    if (auth) await signOut(auth);
    showView("view-landing");
  }
});

$("profileForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!currentUser || !db) return;

  const btn      = $("saveProfileBtn");
  const statusEl = $("profileStatus");
  btn.disabled        = true;
  btn.textContent     = "Saving\u2026";
  statusEl.textContent = "";
  statusEl.className  = "status-msg";

  const interests = $("interests").value.split(",").map(s => s.trim()).filter(Boolean).slice(0, 12);
  const role      = $("role").value || selectedRole;
  const alias     = ($("alias").value || "").trim().slice(0, 40) || `user_${currentUser.uid.slice(0, 6)}`;

  const visaRaw   = $("visaMonths").value.trim();
  const visaNum   = visaRaw !== "" ? parseInt(visaRaw, 10) : null;

  try {
    const hasMatch = await hasActiveMatch(currentUser.uid);
    await setDoc(doc(db, "profiles", currentUser.uid), {
      uid:            currentUser.uid,
      role,
      alias,
      region:         ($("region").value         || "").trim().slice(0, 64),
      interests,
      availability:   ($("availability").value   || "").trim().slice(0, 64),
      countryOfOrigin: ($("countryOfOrigin").value || "").trim().slice(0, 64),
      visaMonthsLeft:  role === "aupair" ? (Number.isFinite(visaNum) ? visaNum : null) : null,
      about:          ($("about").value          || "").trim().slice(0, 300),
      serveBucket: bucketFromUid(currentUser.uid),
      profileVisible: true,
      hasMatch,
      matchingState: hasMatch ? "matched" : "discoverable",
      updatedAt:      serverTimestamp()
    }, { merge: true });

    statusEl.textContent = "Profile saved!";
    statusEl.className   = "status-msg";

    const profileSnap = await getDoc(doc(db, "profiles", currentUser.uid));
    renderProfilePreview(profileSnap.data());

    setTimeout(() => {
      if (isEditingProfile) {
        isEditingProfile = false;
        showView("view-app");
        showTab("profile");
      } else {
        showView("view-app");
        showTab("discover");
      }
    }, 700);
  } catch (err) {
    console.error("Profile save error:", err);
    const msg = err.code === "permission-denied"
      ? "Permission denied \u2014 deploy latest Firestore rules."
      : (err.message || "Save failed");
    statusEl.textContent = msg;
    statusEl.className   = "status-msg error";
  } finally {
    btn.disabled    = false;
    btn.textContent = "Save profile";
  }
});

$("about").addEventListener("input", () => {
  $("aboutCount").textContent = String($("about").value.length);
});

document.querySelectorAll(".nav-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab;
    showTab(tab);
    if (tab === "matches") loadMatches(false);
    if (tab === "discover") {
      updateLikeQuotaUI();
      if (discoverRefreshCooldownUntilMs > Date.now()) applyDiscoverRefreshCooldown();
      loadCandidates();
    }
  });
});

$("loadCandidatesBtn").addEventListener("click", async () => {
  if (!currentUser) return;

  if (discoverRefreshCooldownUntilMs > Date.now()) {
    applyDiscoverRefreshCooldown();
    return;
  }

  const btn = $("loadCandidatesBtn");
  btn.disabled    = true;
  btn.textContent = "Loading\u2026";
  try {
    await loadCandidates();
    discoverRefreshCooldownUntilMs = Date.now() + DISCOVER_REFRESH_COOLDOWN_MS;
    applyDiscoverRefreshCooldown();
  } catch (err) {
    console.error("Load candidates failed:", err);
    const msg = err.message?.includes("index")
      ? "A Firestore index is missing. Open the link in browser console to create it."
      : (err.message || "Failed to load");
    $("candidates").innerHTML = `<p class="empty-state">${escHtml(msg)}</p>`;
    btn.disabled    = false;
    btn.textContent = "Try again";
  }
});

$("chatBack").addEventListener("click", () => {
  stopChatRealtime();
  $("chatPanel").classList.add("hidden");
  $("matchesList").style.removeProperty("display");
  $("view-app").classList.remove("chat-open");
  setStoredMatchId("");
  setChatStatus("");
  setChatComposerEnabled(true, "Type a message…");
  $("revealBtn").disabled = false;
  setCloseButtonsDisabled(false);
  $("chatClosedBanner").classList.add("hidden");
  $("chatActions").classList.remove("hidden");
  currentMatchId = null;
  currentMatchState = "mutual_match";
});

$("sendMessageBtn").addEventListener("click", async () => {
  if (!currentMatchId) return;
  const text = $("messageText").value.trim();
  if (!text) return;
  try {
    await sendMessage(currentMatchId, text);
    $("messageText").value = "";
    resizeMessageInput();
    setChatStatus("");
  } catch (err) {
    console.error("Send failed:", err);
    setChatStatus(err.message || "Could not send message", "error");
    toast(err.message || "Could not send message", "error", 5000);
  }
});

document.addEventListener("visibilitychange", () => {
  if (!currentMatchId) return;

  if (document.hidden) {
    stopChatRealtime();
    return;
  }

  startChatRealtime(currentMatchId);
});

$("messageText").addEventListener("input", () => {
  resizeMessageInput();
});

$("messageText").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("sendMessageBtn").click();
  }
});

$("revealBtn").addEventListener("click", async () => {
  if (!currentMatchId) return;
  try {
    await revealConsent(currentMatchId);
    await loadMatches();
  } catch (err) {
    console.error("Reveal failed:", err);
  }
});

$('closeMatchBtn').addEventListener('click', async () => {
  try {
    await closeCurrentMatch('not_a_fit');
  } catch (err) {
    console.error('Close match failed:', err);
    setChatStatus(err.message || 'Could not close match', 'error');
    toast(err.message || 'Could not close match', 'error', 5000);
  }
});

$('reportCloseBtn').addEventListener('click', async () => {
  const reason = await showReportModal();
  if (!reason) return;
  try {
    await closeCurrentMatch(reason);
  } catch (err) {
    console.error('Report failed:', err);
    setChatStatus(err.message || 'Could not submit report', 'error');
    toast(err.message || 'Could not submit report', 'error', 5000);
  }
});

$("editProfileBtn").addEventListener("click", async () => {
  if (!currentUser || !db) return;
  isEditingProfile = true;
  const snap = await getDoc(doc(db, "profiles", currentUser.uid));
  if (snap.exists()) prefillOnboarding(snap.data());
  showView("view-onboarding");
});

$("sendFeedbackBtn").addEventListener("click", async () => {
  try {
    await sendFeedback();
  } catch (err) {
    console.error("Feedback failed:", err);
    toast(err.message || "Could not send feedback", "error", 5000);
  }
});

$("requestDeleteBtn").addEventListener("click", requestDelete);

$("adminLogoutBtn").addEventListener("click", async () => {
  if (!auth) return;
  const ok = await showConfirm("Sign out of admin?", "Sign out", false);
  if (ok) {
    sessionStorage.removeItem("am_admin_user_mode");
    await signOut(auth);
  }
});

$("adminEnterAppBtn").addEventListener("click", async () => {
  sessionStorage.setItem("am_admin_user_mode", "1");
  if (currentUser) {
    $("userPill").textContent = currentUser.email || "";
    $("switchToAdminBtn").hidden = false;
    showLoading(true);
    try {
      await ensureUserDocs(currentUser.uid);
      const profileSnap = await getDoc(doc(db, "profiles", currentUser.uid));
      const profile = profileSnap.exists() ? profileSnap.data() : null;
      const hasRealAlias = profile?.alias && !profile.alias.startsWith("user_");
      if (hasRealAlias) {
        renderProfilePreview(profile);
        showView("view-app");
        showTab(storedTab());
        loadCandidates().catch(err => console.warn(err));
      } else {
        prefillOnboarding(profile);
        showView("view-onboarding");
      }
    } finally {
      showLoading(false);
    }
  }
});

$("switchToAdminBtn").addEventListener("click", () => {
  sessionStorage.removeItem("am_admin_user_mode");
  $("switchToAdminBtn").hidden = true;
  $("adminUserPill").textContent = currentUser?.email || "";
  showView("view-admin");
  loadAdminDashboard().catch(err => console.error(err));
});

$("adminRefreshBtn").addEventListener("click", () => {
  loadAdminDashboard().catch(err => console.error("Admin refresh failed:", err));
});

$("adminPurgeCooldownsBtn").addEventListener("click", purgeExpiredCooldowns);

$("adminDeletionList").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action='process-deletion']");
  if (btn) processDeletion(btn.dataset.uid);
});

$("adminAbuseList").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action='review-report']");
  if (btn) markReportReviewed(btn.dataset.id);
});

$("adminFeedbackList").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action='set-feedback-status']");
  if (btn) setFeedbackStatus(btn.dataset.id, btn.dataset.status);
});

// ── Boot ──────────────────────────────────────────────────────
(async () => {
  showLoading(true);
  const ok = await initFirebase();
  if (!ok) {
    showLoading(false);
    showView("view-landing");
  }
})();