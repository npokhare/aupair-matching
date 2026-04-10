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
  getFirestore,
  connectFirestoreEmulator,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  addDoc,
  query,
  where,
  getDocs,
  serverTimestamp,
  increment,
  limit
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const useLocalEmulators = ["localhost", "127.0.0.1"].includes(window.location.hostname);

const baseFirebaseConfig = {
  apiKey: "REPLACE_API_KEY",
  authDomain: "aupair-matching.firebaseapp.com",
  projectId: "aupair-matching",
  storageBucket: "aupair-matching.appspot.com",
  messagingSenderId: "REPLACE_SENDER_ID",
  appId: "REPLACE_APP_ID"
};

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
let app = null;
let auth = null;
let db = null;
const provider = new GoogleAuthProvider();

function localDemoConfig() {
  return {
    apiKey: "demo-key",
    authDomain: "demo-aupair-matching.firebaseapp.com",
    projectId: "demo-aupair-matching",
    storageBucket: "demo-aupair-matching.appspot.com",
    messagingSenderId: "000000000000",
    appId: "1:000000000000:web:demo"
  };
}

async function resolveFirebaseConfig() {
  if (useLocalEmulators) {
    return localDemoConfig();
  }

  if (!baseFirebaseConfig.apiKey.startsWith("REPLACE_")) {
    return baseFirebaseConfig;
  }

  try {
    const res = await fetch("/__/firebase/init.json", { cache: "no-store" });
    if (!res.ok) {
      throw new Error(`init.json request failed: ${res.status}`);
    }
    const hostedConfig = await res.json();
    if (!hostedConfig.apiKey) {
      throw new Error("init.json missing apiKey");
    }
    return {
      apiKey: hostedConfig.apiKey,
      authDomain: hostedConfig.authDomain || baseFirebaseConfig.authDomain,
      projectId: hostedConfig.projectId || baseFirebaseConfig.projectId,
      storageBucket: hostedConfig.storageBucket || baseFirebaseConfig.storageBucket,
      messagingSenderId: hostedConfig.messagingSenderId || "",
      appId: hostedConfig.appId || ""
    };
  } catch (err) {
    log("Firebase config missing", {
      message: "Create a Firebase Web App and set SDK config or allow Hosting auto-init."
    });
    console.error(err);
    return null;
  }
}

async function initFirebase() {
  const resolvedConfig = await resolveFirebaseConfig();
  if (!resolvedConfig) {
    return false;
  }

  app = initializeApp(resolvedConfig);
  auth = getAuth(app);
  db = getFirestore(app);

  if (useLocalEmulators) {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    connectFirestoreEmulator(db, "127.0.0.1", 8085);
  } else {
    el.demoLoginBtn.style.display = "none";
  }

  onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    if (!user) {
      el.authState.textContent = "Not signed in";
      return;
    }

    const label = user.email || `demo-user:${user.uid.slice(0, 6)}`;
    el.authState.textContent = `Signed in as ${label}`;

    try {
      await ensureUserDocs(user.uid);
      log("User ready", { uid: user.uid });
    } catch (err) {
      log("User init failed", { message: err.message });
    }
  });

  return true;
}

const firebaseReady = initFirebase();

async function requireFirebaseReady() {
  const ok = await firebaseReady;
  if (!ok || !auth || !db) {
    log("Firebase not configured for production yet.");
    return false;
  }
  return true;
}

function log(message, data) {
  const line = data ? `${message} ${JSON.stringify(data)}` : message;
  el.logs.textContent = `${new Date().toISOString()}  ${line}\n${el.logs.textContent}`;
}

function pairKey(uidA, uidB) {
  return [uidA, uidB].sort().join("_");
}

async function ensureUserDocs(uid) {
  const userRef = doc(db, "users", uid);
  const profileRef = doc(db, "profiles", uid);

  const [userSnap, profileSnap] = await Promise.all([getDoc(userRef), getDoc(profileRef)]);

  if (!userSnap.exists()) {
    await setDoc(userRef, {
      uid,
      status: "active",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  } else {
    await updateDoc(userRef, { updatedAt: serverTimestamp() });
  }

  if (!profileSnap.exists()) {
    await setDoc(profileRef, {
      uid,
      role: "aupair",
      alias: `user_${uid.slice(0, 6)}`,
      region: "",
      interests: [],
      availability: "",
      about: "",
      profileVisible: true,
      updatedAt: serverTimestamp()
    });
  }
}

el.loginBtn.addEventListener("click", async () => {
  try {
    if (!(await requireFirebaseReady())) return;
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
    if (!(await requireFirebaseReady())) return;
    await signInAnonymously(auth);
  } catch (err) {
    log("Local demo login failed", { message: err.message });
  }
});

el.logoutBtn.addEventListener("click", async () => {
  if (!(await requireFirebaseReady())) return;
  await signOut(auth);
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
    .filter(Boolean)
    .slice(0, 12);

  try {
    await setDoc(doc(db, "profiles", currentUser.uid), {
      uid: currentUser.uid,
      role: el.role.value === "host" ? "host" : "aupair",
      alias: (el.alias.value || `user_${currentUser.uid.slice(0, 6)}`).trim().slice(0, 40),
      region: (el.region.value || "").trim().slice(0, 64),
      interests,
      availability: (el.availability.value || "").trim().slice(0, 64),
      about: (el.about.value || "").trim().slice(0, 300),
      profileVisible: true,
      updatedAt: serverTimestamp()
    }, { merge: true });

    log("Profile saved", { ok: true });
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
    const mySnap = await getDoc(doc(db, "profiles", currentUser.uid));
    if (!mySnap.exists()) {
      log("Complete profile first");
      return;
    }

    const mine = mySnap.data();
    const targetRole = mine.role === "aupair" ? "host" : "aupair";
    const requestedRegion = el.region.value.trim() || mine.region || "";

    let candidatesQuery = query(
      collection(db, "profiles"),
      where("role", "==", targetRole),
      where("profileVisible", "==", true),
      limit(50)
    );

    if (requestedRegion) {
      candidatesQuery = query(
        collection(db, "profiles"),
        where("role", "==", targetRole),
        where("profileVisible", "==", true),
        where("region", "==", requestedRegion),
        limit(50)
      );
    }

    const snap = await getDocs(candidatesQuery);
    const mineInterests = Array.isArray(mine.interests) ? mine.interests : [];

    const candidates = [];
    snap.forEach((candidateDoc) => {
      if (candidateDoc.id === currentUser.uid) return;
      const p = candidateDoc.data();
      const theirInterests = Array.isArray(p.interests) ? p.interests : [];
      const overlap = theirInterests.filter((x) => mineInterests.includes(x)).length;
      const score = overlap * 10 + ((p.region || "") === (mine.region || "") ? 30 : 0);

      candidates.push({
        uid: candidateDoc.id,
        alias: p.alias || "anonymous",
        role: p.role,
        region: p.region || "",
        interests: theirInterests,
        score
      });
    });

    candidates.sort((a, b) => b.score - a.score);
    el.candidates.innerHTML = "";

    candidates.forEach((candidate) => {
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
        try {
          const actionId = `${currentUser.uid}_${candidate.uid}`;
          const reverseId = `${candidate.uid}_${currentUser.uid}`;

          await setDoc(doc(db, "matchActions", actionId), {
            actorUid: currentUser.uid,
            targetUid: candidate.uid,
            action: "like",
            createdAt: serverTimestamp()
          }, { merge: true });

          const reverse = await getDoc(doc(db, "matchActions", reverseId));
          const mutual = reverse.exists() && reverse.data().action === "like";

          if (!mutual) {
            log("likeCandidate", { mutual: false });
            return;
          }

          const matchId = pairKey(currentUser.uid, candidate.uid);
          const sorted = [currentUser.uid, candidate.uid].sort();

          await setDoc(doc(db, "matches", matchId), {
            matchId,
            userA: sorted[0],
            userB: sorted[1],
            state: "mutual_match",
            revealA: false,
            revealB: false,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          }, { merge: true });

          await setDoc(doc(db, "threads", matchId), {
            threadId: matchId,
            userA: sorted[0],
            userB: sorted[1],
            messageCount: 0,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          }, { merge: true });

          el.threadId.value = matchId;
          log("likeCandidate", { mutual: true, matchId });
        } catch (err) {
          log("likeCandidate failed", { message: err.message });
        }
      });

      const passBtn = document.createElement("button");
      passBtn.className = "secondary";
      passBtn.textContent = "Pass";
      passBtn.addEventListener("click", async () => {
        try {
          await setDoc(doc(db, "matchActions", `${currentUser.uid}_${candidate.uid}`), {
            actorUid: currentUser.uid,
            targetUid: candidate.uid,
            action: "pass",
            createdAt: serverTimestamp()
          }, { merge: true });
          log("passCandidate", { ok: true });
        } catch (err) {
          log("passCandidate failed", { message: err.message });
        }
      });

      actions.appendChild(likeBtn);
      actions.appendChild(passBtn);
      wrap.appendChild(actions);
      el.candidates.appendChild(wrap);
    });

    log("Candidates loaded", { count: candidates.length });
  } catch (err) {
    log("Failed to load candidates", { message: err.message });
  }
});

el.revealBtn.addEventListener("click", async () => {
  if (!currentUser) {
    log("Sign in first");
    return;
  }

  const matchId = el.threadId.value.trim();
  if (!matchId) {
    log("Enter match id in thread field");
    return;
  }

  try {
    const matchRef = doc(db, "matches", matchId);
    const matchSnap = await getDoc(matchRef);

    if (!matchSnap.exists()) {
      log("Match not found");
      return;
    }

    const matchData = matchSnap.data();
    if (matchData.userA !== currentUser.uid && matchData.userB !== currentUser.uid) {
      log("Not part of this match");
      return;
    }

    const patch = { updatedAt: serverTimestamp() };
    if (matchData.userA === currentUser.uid) patch.revealA = true;
    if (matchData.userB === currentUser.uid) patch.revealB = true;

    await updateDoc(matchRef, patch);

    const updatedSnap = await getDoc(matchRef);
    const updated = updatedSnap.data();

    if (updated.revealA && updated.revealB && updated.state !== "revealed") {
      await updateDoc(matchRef, { state: "revealed", updatedAt: serverTimestamp() });
    }

    await setDoc(doc(db, "revealConsents", `${matchId}_${currentUser.uid}`), {
      matchId,
      uid: currentUser.uid,
      participants: [updated.userA, updated.userB],
      consentedAt: serverTimestamp()
    }, { merge: true });

    log("setRevealConsent", { ok: true });
  } catch (err) {
    log("Reveal failed", { message: err.message });
  }
});

el.sendMessageBtn.addEventListener("click", async () => {
  if (!currentUser) {
    log("Sign in first");
    return;
  }

  const threadId = el.threadId.value.trim();
  const text = el.messageText.value.trim();

  if (!threadId) {
    log("Enter thread id");
    return;
  }

  if (!text) {
    log("Type a message first");
    return;
  }

  try {
    const [threadSnap, matchSnap] = await Promise.all([
      getDoc(doc(db, "threads", threadId)),
      getDoc(doc(db, "matches", threadId))
    ]);

    if (!threadSnap.exists() || !matchSnap.exists()) {
      log("Thread or match not found");
      return;
    }

    const thread = threadSnap.data();
    const matchData = matchSnap.data();

    if (thread.userA !== currentUser.uid && thread.userB !== currentUser.uid) {
      log("Not part of this thread");
      return;
    }

    if (matchData.state !== "revealed") {
      log("Identity reveal is required before chat");
      return;
    }

    const participants = [thread.userA, thread.userB];

    await addDoc(collection(db, "messages"), {
      threadId,
      participants,
      senderUid: currentUser.uid,
      text: text.slice(0, 2000),
      createdAt: serverTimestamp(),
      purgeAt: Date.now() + (1000 * 60 * 60 * 24 * 30)
    });

    await updateDoc(doc(db, "threads", threadId), {
      messageCount: increment(1),
      lastMessageAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    el.messageText.value = "";
    log("sendMessage", { ok: true });
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
    await setDoc(doc(db, "deletionQueue", currentUser.uid), {
      uid: currentUser.uid,
      status: "pending",
      requestedAt: serverTimestamp()
    }, { merge: true });

    log("requestAccountDeletion", { ok: true });
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
    await setDoc(doc(db, "profiles", currentUser.uid), {
      alias: "deleted_user",
      region: "",
      interests: [],
      availability: "",
      about: "",
      profileVisible: false,
      deletedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }, { merge: true });

    await setDoc(doc(db, "users", currentUser.uid), {
      status: "deleted",
      deletedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }, { merge: true });

    const msgSnap = await getDocs(query(collection(db, "messages"), where("senderUid", "==", currentUser.uid), limit(200)));
    for (const messageDoc of msgSnap.docs) {
      await deleteDoc(messageDoc.ref);
    }

    const consentSnap = await getDocs(query(collection(db, "revealConsents"), where("uid", "==", currentUser.uid), limit(200)));
    for (const consentDoc of consentSnap.docs) {
      await deleteDoc(consentDoc.ref);
    }

    await setDoc(doc(db, "deletionQueue", currentUser.uid), {
      uid: currentUser.uid,
      status: "completed",
      completedAt: serverTimestamp()
    }, { merge: true });

    log("runDeletionJob", { status: "completed" });
  } catch (err) {
    log("Deletion job failed", { message: err.message });
  }
});
