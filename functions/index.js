const admin = require("firebase-admin");
const functions = require("firebase-functions");
const { FieldValue, Timestamp } = require("firebase-admin/firestore");

admin.initializeApp();
const db = admin.firestore();

function requireAuth(context) {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Login required");
  }
  return context.auth.uid;
}

function pairKey(uidA, uidB) {
  return [uidA, uidB].sort().join("_");
}

exports.ensureUser = functions.https.onCall(async (_, context) => {
  const uid = requireAuth(context);

  const userRef = db.collection("users").doc(uid);
  const profileRef = db.collection("profiles").doc(uid);

  await userRef.set(
    {
      uid,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      status: "active"
    },
    { merge: true }
  );

  await profileRef.set(
    {
      uid,
      role: "aupair",
      alias: `user_${uid.slice(0, 6)}`,
      region: "",
      interests: [],
      availability: "",
      profileVisible: true,
      updatedAt: FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  return { ok: true, uid };
});

exports.upsertAnonymousProfile = functions.https.onCall(async (data, context) => {
  const uid = requireAuth(context);

  const role = data.role === "host" ? "host" : "aupair";
  const alias = typeof data.alias === "string" && data.alias.trim().length > 2
    ? data.alias.trim().slice(0, 40)
    : `user_${uid.slice(0, 6)}`;

  const profile = {
    uid,
    role,
    alias,
    region: typeof data.region === "string" ? data.region.trim().slice(0, 64) : "",
    interests: Array.isArray(data.interests) ? data.interests.slice(0, 12) : [],
    availability: typeof data.availability === "string" ? data.availability.trim().slice(0, 64) : "",
    about: typeof data.about === "string" ? data.about.trim().slice(0, 300) : "",
    profileVisible: true,
    updatedAt: FieldValue.serverTimestamp()
  };

  await db.collection("profiles").doc(uid).set(profile, { merge: true });
  return { ok: true };
});

exports.getCandidates = functions.https.onCall(async (data, context) => {
  const uid = requireAuth(context);
  const myProfile = await db.collection("profiles").doc(uid).get();

  if (!myProfile.exists) {
    throw new functions.https.HttpsError("failed-precondition", "Complete profile first");
  }

  const mine = myProfile.data();
  const targetRole = mine.role === "aupair" ? "host" : "aupair";
  const region = typeof data.region === "string" && data.region.trim() ? data.region.trim() : mine.region;

  let query = db.collection("profiles")
    .where("role", "==", targetRole)
    .where("profileVisible", "==", true)
    .limit(50);

  if (region) {
    query = query.where("region", "==", region);
  }

  const snap = await query.get();
  const candidates = [];

  snap.forEach((doc) => {
    if (doc.id === uid) return;
    const p = doc.data();

    const mineInterests = Array.isArray(mine.interests) ? mine.interests : [];
    const theirInterests = Array.isArray(p.interests) ? p.interests : [];
    const overlap = theirInterests.filter((x) => mineInterests.includes(x)).length;
    const score = overlap * 10 + (p.region && p.region === mine.region ? 30 : 0);

    candidates.push({
      uid: doc.id,
      alias: p.alias,
      role: p.role,
      region: p.region,
      interests: theirInterests,
      availability: p.availability,
      about: p.about,
      score
    });
  });

  candidates.sort((a, b) => b.score - a.score);
  return { ok: true, candidates: candidates.slice(0, 20) };
});

exports.likeCandidate = functions.https.onCall(async (data, context) => {
  const actorUid = requireAuth(context);
  const targetUid = typeof data.targetUid === "string" ? data.targetUid : "";

  if (!targetUid || targetUid === actorUid) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid target user");
  }

  const actionId = `${actorUid}_${targetUid}`;
  const reverseId = `${targetUid}_${actorUid}`;

  await db.collection("matchActions").doc(actionId).set({
    actorUid,
    targetUid,
    action: "like",
    createdAt: FieldValue.serverTimestamp()
  });

  const reverse = await db.collection("matchActions").doc(reverseId).get();
  if (!reverse.exists || reverse.data().action !== "like") {
    return { ok: true, mutual: false };
  }

  const matchId = pairKey(actorUid, targetUid);
  const sorted = [actorUid, targetUid].sort();
  await db.collection("matches").doc(matchId).set({
    matchId,
    userA: sorted[0],
    userB: sorted[1],
    state: "mutual_match",
    revealA: false,
    revealB: false,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  await db.collection("threads").doc(matchId).set({
    threadId: matchId,
    userA: sorted[0],
    userB: sorted[1],
    messageCount: 0,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  return { ok: true, mutual: true, matchId };
});

exports.passCandidate = functions.https.onCall(async (data, context) => {
  const actorUid = requireAuth(context);
  const targetUid = typeof data.targetUid === "string" ? data.targetUid : "";

  if (!targetUid || targetUid === actorUid) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid target user");
  }

  await db.collection("matchActions").doc(`${actorUid}_${targetUid}`).set({
    actorUid,
    targetUid,
    action: "pass",
    createdAt: FieldValue.serverTimestamp()
  });

  return { ok: true };
});

exports.setRevealConsent = functions.https.onCall(async (data, context) => {
  const uid = requireAuth(context);
  const matchId = typeof data.matchId === "string" ? data.matchId : "";
  if (!matchId) {
    throw new functions.https.HttpsError("invalid-argument", "matchId is required");
  }

  const matchRef = db.collection("matches").doc(matchId);
  const snap = await matchRef.get();
  if (!snap.exists) {
    throw new functions.https.HttpsError("not-found", "Match not found");
  }

  const m = snap.data();
  if (m.userA !== uid && m.userB !== uid) {
    throw new functions.https.HttpsError("permission-denied", "Not part of this match");
  }

  const patch = {
    updatedAt: FieldValue.serverTimestamp()
  };

  if (m.userA === uid) patch.revealA = true;
  if (m.userB === uid) patch.revealB = true;

  await matchRef.set(patch, { merge: true });

  const updated = (await matchRef.get()).data();
  if (updated.revealA && updated.revealB) {
    await matchRef.set({ state: "revealed", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }

  await db.collection("revealConsents").doc(`${matchId}_${uid}`).set({
    matchId,
    uid,
    participants: [updated.userA, updated.userB],
    consentedAt: FieldValue.serverTimestamp()
  });

  return { ok: true, state: updated.revealA && updated.revealB ? "revealed" : "mutual_match" };
});

exports.sendMessage = functions.https.onCall(async (data, context) => {
  const uid = requireAuth(context);
  const threadId = typeof data.threadId === "string" ? data.threadId : "";
  const text = typeof data.text === "string" ? data.text.trim() : "";

  if (!threadId || !text) {
    throw new functions.https.HttpsError("invalid-argument", "threadId and text are required");
  }

  const threadRef = db.collection("threads").doc(threadId);
  const thread = await threadRef.get();
  if (!thread.exists) {
    throw new functions.https.HttpsError("not-found", "Thread not found");
  }

  const t = thread.data();
  if (t.userA !== uid && t.userB !== uid) {
    throw new functions.https.HttpsError("permission-denied", "Not part of this thread");
  }

  const matchRef = db.collection("matches").doc(threadId);
  const matchSnap = await matchRef.get();
  if (!matchSnap.exists || matchSnap.data().state !== "revealed") {
    throw new functions.https.HttpsError("failed-precondition", "Identity reveal required before chat");
  }

  const doc = await db.collection("messages").add({
    threadId,
    participants: [t.userA, t.userB],
    senderUid: uid,
    text: text.slice(0, 2000),
    createdAt: FieldValue.serverTimestamp(),
    purgeAt: Timestamp.fromDate(new Date(Date.now() + (1000 * 60 * 60 * 24 * 30)))
  });

  await threadRef.set(
    {
      messageCount: (t.messageCount || 0) + 1,
      lastMessageAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  return { ok: true, messageId: doc.id };
});

exports.requestAccountDeletion = functions.https.onCall(async (_, context) => {
  const uid = requireAuth(context);
  await db.collection("deletionQueue").doc(uid).set({
    uid,
    status: "pending",
    requestedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  await db.collection("auditLogs").add({
    uid,
    action: "delete_requested",
    at: FieldValue.serverTimestamp()
  });

  return { ok: true, status: "pending" };
});

exports.runDeletionJob = functions.https.onCall(async (_, context) => {
  const uid = requireAuth(context);

  const queueDoc = await db.collection("deletionQueue").doc(uid).get();
  if (!queueDoc.exists || queueDoc.data().status !== "pending") {
    throw new functions.https.HttpsError("failed-precondition", "No pending deletion request");
  }

  const batch = db.batch();
  const profileRef = db.collection("profiles").doc(uid);
  const userRef = db.collection("users").doc(uid);

  batch.set(profileRef, {
    alias: "deleted_user",
    region: "",
    interests: [],
    availability: "",
    about: "",
    profileVisible: false,
    deletedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  batch.set(userRef, {
    status: "deleted",
    deletedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  const msgSnap = await db.collection("messages").where("participants", "array-contains", uid).get();
  msgSnap.forEach((d) => batch.delete(d.ref));

  const consentSnap = await db.collection("revealConsents").where("participants", "array-contains", uid).get();
  consentSnap.forEach((d) => batch.delete(d.ref));

  batch.set(db.collection("deletionQueue").doc(uid), {
    uid,
    status: "completed",
    completedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  batch.set(db.collection("auditLogs").doc(), {
    uid,
    action: "delete_completed",
    at: FieldValue.serverTimestamp()
  });

  await batch.commit();
  return { ok: true, status: "completed" };
});

