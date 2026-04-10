import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInAnonymously,
  signOut,
  onAuthStateChanged,
  connectAuthEmulator
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFunctions,
  httpsCallable,
  connectFunctionsEmulator
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";

const useLocalEmulators = ["localhost", "127.0.0.1"].includes(window.location.hostname);

const firebaseConfig = {
  apiKey: "REPLACE_API_KEY",
  authDomain: "aupair-matching.firebaseapp.com",
  projectId: "aupair-matching",
  storageBucket: "aupair-matching.appspot.com",
  messagingSenderId: "REPLACE_SENDER_ID",
  appId: "REPLACE_APP_ID"
};

if (useLocalEmulators) {
  firebaseConfig.apiKey = "demo-key";
  firebaseConfig.authDomain = "demo-aupair-matching.firebaseapp.com";
  firebaseConfig.projectId = "demo-aupair-matching";
  firebaseConfig.storageBucket = "demo-aupair-matching.appspot.com";
  firebaseConfig.messagingSenderId = "000000000000";
  firebaseConfig.appId = "1:000000000000:web:demo";
}

if (!useLocalEmulators && firebaseConfig.apiKey.startsWith("REPLACE_")) {
  console.error("Firebase web config is not set. Update public/app.js with SDK config from Firebase console.");
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const functions = getFunctions(app);

if (useLocalEmulators) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
}

const provider = new GoogleAuthProvider();

const el = {
  loginBtn: document.getElementById("loginBtn"),
  demoLoginBtn: document.getElementById("demoLoginBtn"),
  logoutBtn: document.getElementById("logoutBtn"),
  authState: document.getElementById("authState"),
  profileForm: document.getElementById("profileForm"),
  role: document.getElementById("role"),
  alias: document.getElementById("alias"),
  region: document.getElementById("region"),
  interests: document.getElementById("interests"),
  availability: document.getElementById("availability"),
  about: document.getElementById("about"),
  loadCandidatesBtn: document.getElementById("loadCandidatesBtn"),
  candidates: document.getElementById("candidates"),
  threadId: document.getElementById("threadId"),
  revealBtn: document.getElementById("revealBtn"),
  messageText: document.getElementById("messageText"),
  sendMessageBtn: document.getElementById("sendMessageBtn"),
  requestDeleteBtn: document.getElementById("requestDeleteBtn"),
  runDeleteBtn: document.getElementById("runDeleteBtn"),
  logs: document.getElementById("logs")
};

let currentUser = null;

function log(message, data) {
  const line = data ? `${message} ${JSON.stringify(data)}` : message;
  el.logs.textContent = `${new Date().toISOString()}  ${line}\n${el.logs.textContent}`;
}

async function call(name, payload = {}) {
  const fn = httpsCallable(functions, name);
  const res = await fn(payload);
  return res.data;
}

el.loginBtn.addEventListener("click", async () => {
  try {
    if (useLocalEmulators) {
      log("Google popup is disabled in local emulator mode. Use Local demo login.");
      return;
    }
    await signInWithPopup(auth, provider);
  } catch (err) {
    log("Login failed", { message: err.message });
  }
});

el.demoLoginBtn.addEventListener("click", async () => {
  try {
    await signInAnonymously(auth);
  } catch (err) {
    log("Local demo login failed", { message: err.message });
  }
});

el.logoutBtn.addEventListener("click", async () => {
  await signOut(auth);
});

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (!user) {
    el.authState.textContent = "Not signed in";
    return;
  }

  const label = user.email || `demo-user:${user.uid.slice(0, 6)}`;
  el.authState.textContent = `Signed in as ${label}`;
  try {
    const result = await call("ensureUser");
    log("ensureUser", result);
  } catch (err) {
    log("ensureUser failed", { message: err.message });
  }
});

el.profileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentUser) {
    log("Sign in first");
    return;
  }

  const interests = el.interests.value
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  try {
    const result = await call("upsertAnonymousProfile", {
      role: el.role.value,
      alias: el.alias.value,
      region: el.region.value,
      interests,
      availability: el.availability.value,
      about: el.about.value
    });
    log("Profile saved", result);
  } catch (err) {
    log("Profile save failed", { message: err.message });
  }
});

el.loadCandidatesBtn.addEventListener("click", async () => {
  if (!currentUser) {
    log("Sign in first");
    return;
  }

  try {
    const result = await call("getCandidates", { region: el.region.value.trim() });
    log("Candidates loaded", { count: result.candidates.length });

    el.candidates.innerHTML = "";
    result.candidates.forEach((candidate) => {
      const wrap = document.createElement("div");
      wrap.className = "candidate";
      wrap.innerHTML = `
        <strong>${candidate.alias}</strong><br>
        role: ${candidate.role}<br>
        region: ${candidate.region}<br>
        interests: ${(candidate.interests || []).join(", ")}<br>
        score: ${candidate.score}
      `;

      const actions = document.createElement("div");
      actions.className = "actions";

      const likeBtn = document.createElement("button");
      likeBtn.textContent = "Like";
      likeBtn.addEventListener("click", async () => {
        const r = await call("likeCandidate", { targetUid: candidate.uid });
        if (r.mutual && r.matchId) {
          el.threadId.value = r.matchId;
        }
        log("likeCandidate", r);
      });

      const passBtn = document.createElement("button");
      passBtn.className = "secondary";
      passBtn.textContent = "Pass";
      passBtn.addEventListener("click", async () => {
        const r = await call("passCandidate", { targetUid: candidate.uid });
        log("passCandidate", r);
      });

      actions.appendChild(likeBtn);
      actions.appendChild(passBtn);
      wrap.appendChild(actions);
      el.candidates.appendChild(wrap);
    });
  } catch (err) {
    log("Failed to load candidates", { message: err.message });
  }
});

el.revealBtn.addEventListener("click", async () => {
  if (!currentUser) {
    log("Sign in first");
    return;
  }

  if (!el.threadId.value.trim()) {
    log("Enter match id in thread field");
    return;
  }

  try {
    const result = await call("setRevealConsent", { matchId: el.threadId.value.trim() });
    log("setRevealConsent", result);
  } catch (err) {
    log("Reveal failed", { message: err.message });
  }
});

el.sendMessageBtn.addEventListener("click", async () => {
  if (!currentUser) {
    log("Sign in first");
    return;
  }

  if (!el.threadId.value.trim()) {
    log("Enter thread id");
    return;
  }

  try {
    const result = await call("sendMessage", {
      threadId: el.threadId.value.trim(),
      text: el.messageText.value
    });
    log("sendMessage", result);
    el.messageText.value = "";
  } catch (err) {
    log("Message failed", { message: err.message });
  }
});

el.requestDeleteBtn.addEventListener("click", async () => {
  if (!currentUser) {
    log("Sign in first");
    return;
  }
  try {
    const result = await call("requestAccountDeletion");
    log("requestAccountDeletion", result);
  } catch (err) {
    log("Delete request failed", { message: err.message });
  }
});

el.runDeleteBtn.addEventListener("click", async () => {
  if (!currentUser) {
    log("Sign in first");
    return;
  }
  try {
    const result = await call("runDeletionJob");
    log("runDeletionJob", result);
  } catch (err) {
    log("Deletion job failed", { message: err.message });
  }
});
