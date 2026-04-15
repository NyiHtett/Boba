/**
 * Firebase module — handles Google auth and Firestore cloud sync.
 *
 * Architecture decisions:
 * - We use chrome.identity.getAuthToken() for Google sign-in because it's the
 *   native Chrome extension OAuth flow — no redirect pages or popup windows.
 *   Chrome manages the token lifecycle (refresh, cache, revoke) for us.
 * - We pass that OAuth access token to Firebase Auth via GoogleAuthProvider.credential()
 *   so Firestore security rules can gate reads/writes to the authenticated user.
 * - Each note is stored as a separate Firestore document under users/{uid}/notes/{noteId}.
 *   This avoids hitting the 1MB document limit when a user has many notes.
 * - We strip base64 images from HTML before writing to Firestore because a single
 *   embedded image can be 5MB+ as base64, far exceeding the 1MB doc limit.
 *   Images stay in chrome.storage.local only.
 */

import { initializeApp } from "firebase/app";
import {
  getAuth,
  signInWithCredential,
  GoogleAuthProvider,
  signOut as fbSignOut,
  onAuthStateChanged,
} from "firebase/auth/web-extension";
import {
  getFirestore,
  doc,
  setDoc,
  collection,
  getDocs,
  deleteDoc,
  writeBatch,
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyBybjrrWdowL25RSFPwwS01Ur3giSyBEUE",
  authDomain: "splash-9d0aa.firebaseapp.com",
  projectId: "splash-9d0aa",
  storageBucket: "splash-9d0aa.firebasestorage.app",
  messagingSenderId: "701906353733",
  appId: "1:701906353733:web:159ebbdc37e93ae5892d2c",
  measurementId: "G-W90M0RB2M5",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ── Auth ──

/**
 * Sign in using Chrome's built-in identity system.
 * chrome.identity.getAuthToken() shows Google's consent screen the first time,
 * then returns a cached token on subsequent calls. We feed that token to Firebase
 * Auth so Firestore knows who the user is.
 */
export async function signIn() {
  const { token } = await chrome.identity.getAuthToken({ interactive: true });
  const credential = GoogleAuthProvider.credential(null, token);
  return signInWithCredential(auth, credential);
}

/**
 * Sign out from both Firebase and Chrome's token cache.
 * We revoke the cached token so the next signIn() shows the account picker again.
 */
export async function signOutUser() {
  try {
    const { token } = await chrome.identity.getAuthToken({ interactive: false });
    if (token) {
      await chrome.identity.removeCachedAuthToken({ token });
    }
  } catch {
    // Token may already be cleared — that's fine.
  }
  return fbSignOut(auth);
}

/**
 * Subscribe to auth state changes. The callback receives the Firebase user object
 * (or null when signed out). Returns an unsubscribe function.
 */
export function onAuth(callback) {
  return onAuthStateChanged(auth, callback);
}

// ── Firestore sync ──

/**
 * Strip base64 data URLs from HTML before sending to Firestore.
 * Why: A single 5MB image becomes ~6.7MB as base64. Firestore's doc limit is 1MB.
 * We replace <img src="data:..."> with a placeholder so the structure is preserved.
 */
function stripBase64FromHtml(html) {
  if (!html) return html;
  return html.replace(/src="data:[^"]+"/g, 'src=""');
}

/**
 * Prepare a note entry for Firestore storage.
 * - Strips base64 images (too large)
 * - Trims history to last 5 snapshots (saves space and write cost)
 * - Converts undefined values to null (Firestore rejects undefined)
 */
function sanitizeForCloud(entry) {
  return {
    text: entry.text || "",
    html: stripBase64FromHtml(entry.html || ""),
    label: entry.label || "",
    sourceUrl: entry.sourceUrl || null,
    updatedAt: entry.updatedAt || Date.now(),
    history: (entry.history || []).slice(-5),
  };
}

/**
 * Upload all local notes to Firestore, overwriting cloud data.
 * Uses a batched write — Firestore processes the batch atomically,
 * so you never end up with half your notes synced.
 */
export async function pushAllNotes(userId, notesByCourse) {
  const entries = Object.entries(notesByCourse);
  // Firestore batches max 500 operations
  for (let i = 0; i < entries.length; i += 450) {
    const batch = writeBatch(db);
    for (const [noteId, entry] of entries.slice(i, i + 450)) {
      const ref = doc(db, "users", userId, "notes", encodeURIComponent(noteId));
      batch.set(ref, sanitizeForCloud(entry));
    }
    await batch.commit();
  }
}

/**
 * Upload a single note to Firestore.
 * Called on editor blur / visibility change — NOT on every keystroke.
 */
export async function pushNote(userId, noteId, entry) {
  const ref = doc(db, "users", userId, "notes", encodeURIComponent(noteId));
  await setDoc(ref, sanitizeForCloud(entry));
}

/**
 * Download all notes from Firestore.
 * Returns a notesByCourse object matching the local storage format.
 */
export async function pullAllNotes(userId) {
  const snapshot = await getDocs(collection(db, "users", userId, "notes"));
  const notes = {};
  snapshot.forEach((d) => {
    notes[decodeURIComponent(d.id)] = d.data();
  });
  return notes;
}

/**
 * Delete a note from Firestore.
 */
export async function deleteCloudNote(userId, noteId) {
  const ref = doc(db, "users", userId, "notes", encodeURIComponent(noteId));
  await deleteDoc(ref);
}

/**
 * Merge cloud notes into local notes.
 * Strategy: for each note, keep whichever version has the later updatedAt timestamp.
 * This handles the common case of switching computers — the most recent edit wins.
 * Local images are preserved since cloud notes don't have them.
 */
export function mergeNotes(local, cloud) {
  const merged = { ...local };
  for (const [id, cloudEntry] of Object.entries(cloud)) {
    const localEntry = merged[id];
    if (!localEntry) {
      // Note only exists in cloud — bring it down
      merged[id] = cloudEntry;
    } else {
      // Both exist — keep the one edited more recently.
      // But preserve local HTML (has images) if local is newer.
      const cloudTime = cloudEntry.updatedAt || 0;
      const localTime = localEntry.updatedAt || 0;
      if (cloudTime > localTime) {
        // Cloud is newer — use cloud text, but keep local images if cloud HTML is stripped
        merged[id] = {
          ...cloudEntry,
          html: cloudEntry.html && !cloudEntry.html.includes('src=""')
            ? cloudEntry.html
            : localEntry.html || cloudEntry.html,
        };
      }
      // If local is newer, keep local as-is (already in merged)
    }
  }
  return merged;
}
