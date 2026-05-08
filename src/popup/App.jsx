import { useState, useEffect, useCallback } from "react";
import { NOTES_KEY, PREVIEW_MODE_KEY, hasMeaningfulData, deriveLabelFromId } from "../shared/storage";
import {
  signIn,
  signOutUser,
  onAuth,
  pushAllNotes,
  pullAllNotes,
  mergeNotes,
  deleteCloudNote,
} from "../shared/firebase";

function cleanTabTitle(title) {
  if (!title) return "";
  return title
    .replace(/\s*[-|]\s*(Canvas|YouTube|Netflix|Reddit|X|Twitter|Instagram|TikTok).*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function makeTopicSlug(title) {
  if (!title) return "";
  const stop = ["the", "a", "an", "and", "or", "for", "to", "of", "in", "on", "with", "by"];
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !stop.includes(w))
    .slice(0, 5)
    .join("-")
    .slice(0, 60);
}

function makeCustomNoteId(name) {
  const slug = makeTopicSlug(name) || "untitled-note";
  return `custom:${slug}:${Date.now().toString(36)}`;
}

function getPreviewText(entry) {
  const raw = entry?.text || entry?.html || "";
  const stripped = String(raw)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
  return stripped;
}

function getNotePreview(entry, fallbackLabel) {
  const text = getPreviewText(entry);
  const imageCount = (String(entry?.html || "").match(/<img\b/gi) || []).length;
  const wordCount = text ? text.split(/\s+/).length : 0;
  const updatedAt = entry?.updatedAt
    ? new Date(entry.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : "Not saved";

  return {
    title: entry?.label || fallbackLabel,
    meta: `${wordCount} word${wordCount === 1 ? "" : "s"} · ${imageCount} image${imageCount === 1 ? "" : "s"} · ${updatedAt}`,
    snippet: text || (imageCount ? "Image-only note." : "No saved content yet."),
  };
}

function deriveContextFromTab(tab) {
  const fallback = { id: "general:quick-note", label: "Quick note", url: null };
  if (!tab?.url) return fallback;
  let parsed;
  try { parsed = new URL(tab.url); } catch { return fallback; }

  const notesPrefix = chrome.runtime.getURL("src/notes/index.html");
  if (tab.url.startsWith(notesPrefix)) {
    const params = new URLSearchParams(parsed.search);
    const contextId = params.get("contextId");
    const label = params.get("label");
    if (contextId) return { id: contextId, label: label || deriveLabelFromId(contextId), url: tab.url, isNotesPage: true };
    return { ...fallback, url: tab.url, isNotesPage: true };
  }

  const title = cleanTabTitle(tab.title || "");
  const host = parsed.hostname.replace(/^www\./, "");
  const slug = makeTopicSlug(title) || host;
  return { id: `web:${host}:${slug}`, label: title || host, url: tab.url };
}

function getAuthErrorMessage(err) {
  const message = err?.message || String(err || "");
  const lower = message.toLowerCase();

  if (lower.includes("oauth") || lower.includes("client") || lower.includes("bad request")) {
    return "Google sign-in setup issue. Check the extension ID in Google Cloud.";
  }
  if (lower.includes("user did not approve") || lower.includes("cancel")) {
    return "Google sign-in was canceled.";
  }
  if (lower.includes("network") || lower.includes("fetch")) {
    return "Network issue. Try again.";
  }

  return `Sign-in failed: ${message}`;
}

export default function App() {
  const [notesByCourse, setNotesByCourse] = useState({});
  const [currentCtx, setCurrentCtx] = useState(null);
  const [selected, setSelected] = useState(null);
  const [newNoteName, setNewNoteName] = useState("");
  const [previewedNoteId, setPreviewedNoteId] = useState(null);
  const [previewMode, setPreviewMode] = useState(true);

  // ── Auth state ──
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [syncStatus, setSyncStatus] = useState("");

  useEffect(() => {
    const unsub = onAuth((u) => {
      setUser(u);
      setAuthLoading(false);
    });
    return unsub;
  }, []);

  useEffect(() => {
    (async () => {
      const data = await chrome.storage.local.get([NOTES_KEY]);
      const notes = data[NOTES_KEY] || {};
      setNotesByCourse(notes);

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const ctx = deriveContextFromTab(tab);
      setCurrentCtx(ctx);
      setSelected(ctx && !ctx.isNotesPage ? `context:${ctx.id}` : null);
    })();

    const listener = (changes, area) => {
      if (area !== "local") return;
      if (changes[NOTES_KEY]) setNotesByCourse(changes[NOTES_KEY].newValue || {});
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  useEffect(() => {
    chrome.storage.local.get([PREVIEW_MODE_KEY]).then((data) => {
      setPreviewMode(data[PREVIEW_MODE_KEY] !== false);
    });
  }, []);

  const options = buildOptions(notesByCourse, currentCtx);
  const previewEntry = previewedNoteId ? notesByCourse[previewedNoteId] : null;
  const previewOption = previewedNoteId
    ? options.find((o) => o.value === `context:${previewedNoteId}`)
    : null;
  const notePreview = previewMode && previewedNoteId
    ? getNotePreview(previewEntry, previewOption?.label || deriveLabelFromId(previewedNoteId))
    : null;

  useEffect(() => {
    if (selected && options.some((o) => o.value === selected)) return;
    const def = currentCtx && !currentCtx.isNotesPage
      ? `context:${currentCtx.id}`
      : options[0]?.value || null;
    setSelected(def);
  }, [options.length, currentCtx]);

  // ── Auth handlers ──
  const handleSignIn = useCallback(async () => {
    try {
      setSyncStatus("Signing in...");
      const result = await signIn({ chooseAccount: true });
      setSyncStatus("Syncing...");
      const cloudNotes = await pullAllNotes(result.user.uid);
      const localData = await chrome.storage.local.get([NOTES_KEY]);
      const localNotes = localData[NOTES_KEY] || {};
      const merged = mergeNotes(localNotes, cloudNotes);
      setNotesByCourse(merged);
      await chrome.storage.local.set({ [NOTES_KEY]: merged });
      await pushAllNotes(result.user.uid, merged);
      setSyncStatus("Synced");
    } catch (err) {
      console.error("Sign-in failed:", err);
      setSyncStatus(getAuthErrorMessage(err));
    }
  }, []);

  const handleSignOut = useCallback(async () => {
    try {
      await signOutUser();
      setSyncStatus("");
    } catch (err) {
      console.error("Sign-out failed:", err);
    }
  }, []);

  const handleSyncNow = useCallback(async () => {
    if (!user) return;
    try {
      setSyncStatus("Syncing...");
      const cloudNotes = await pullAllNotes(user.uid);
      const localData = await chrome.storage.local.get([NOTES_KEY]);
      const localNotes = localData[NOTES_KEY] || {};
      const merged = mergeNotes(localNotes, cloudNotes);
      setNotesByCourse(merged);
      await chrome.storage.local.set({ [NOTES_KEY]: merged });
      await pushAllNotes(user.uid, merged);
      setSyncStatus("Synced");
    } catch (err) {
      console.error("Sync failed:", err);
      setSyncStatus("Sync failed");
    }
  }, [user]);

  const openNote = useCallback(async (mode = "tab") => {
    let ctx = null;
    if (selected?.startsWith("context:")) {
      const id = selected.replace(/^context:/, "");
      if (currentCtx?.id === id) ctx = currentCtx;
      else {
        const entry = notesByCourse[id];
        ctx = { id, label: entry?.label || deriveLabelFromId(id), url: entry?.sourceUrl || null };
      }
    }
    if (!ctx) ctx = currentCtx || { id: "general:quick-note", label: "Quick note", url: null };

    const base = chrome.runtime.getURL("src/notes/index.html");
    const params = new URLSearchParams();
    params.set("contextId", ctx.id);
    params.set("label", ctx.label);
    if (ctx.url) params.set("sourceUrl", ctx.url);
    const url = `${base}?${params}`;
    if (mode === "side") {
      await chrome.sidePanel.setOptions({ path: `src/notes/index.html?${params}`, enabled: true });
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.sidePanel.open({ windowId: tab.windowId });
      return;
    }
    chrome.tabs.create({ url });
  }, [selected, currentCtx, notesByCourse]);

  const openCustomNote = useCallback(async (mode = "tab") => {
    const label = newNoteName.trim() || "Untitled note";
    const ctx = { id: makeCustomNoteId(label), label, url: null };
    setNewNoteName("");

    const base = chrome.runtime.getURL("src/notes/index.html");
    const params = new URLSearchParams();
    params.set("contextId", ctx.id);
    params.set("label", ctx.label);
    const url = `${base}?${params}`;
    if (mode === "side") {
      await chrome.sidePanel.setOptions({ path: `src/notes/index.html?${params}`, enabled: true });
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.sidePanel.open({ windowId: tab.windowId });
      return;
    }
    chrome.tabs.create({ url });
  }, [newNoteName]);

  const deleteNote = useCallback(async (noteId) => {
    const entry = notesByCourse[noteId];
    const label = entry?.label || deriveLabelFromId(noteId) || "this note";
    if (!window.confirm(`Delete "${label}"?`)) return;
    const next = { ...notesByCourse };
    delete next[noteId];
    setNotesByCourse(next);
    if (previewedNoteId === noteId) setPreviewedNoteId(null);
    await chrome.storage.local.set({ [NOTES_KEY]: next });
    if (user) {
      try { await deleteCloudNote(user.uid, noteId); } catch { /* local delete still succeeded */ }
    }
  }, [notesByCourse, previewedNoteId, user]);

  const togglePreviewMode = useCallback(async () => {
    const next = !previewMode;
    setPreviewMode(next);
    if (!next) setPreviewedNoteId(null);
    await chrome.storage.local.set({ [PREVIEW_MODE_KEY]: next });
  }, [previewMode]);

  return (
    <div className="wrap">
      <section className="splash-card">
        <div>
          <h1>Boba</h1>
          <p className="sub">Take notes in an aesthetic world.</p>
        </div>
        <img className="logo" src={chrome.runtime.getURL("icons/icon128.png")} alt="Splash logo" />
      </section>

      {/* ── Auth card ── */}
      <section className="auth-block">
        {authLoading ? (
          <p className="hint">Loading...</p>
        ) : user ? (
          <>
            <div className="auth-user">
              {user.photoURL && <img className="avatar" src={user.photoURL} alt="" />}
              <div className="auth-info">
                <span className="auth-name">{user.displayName || user.email}</span>
                {syncStatus && <span className="sync-status">{syncStatus}</span>}
              </div>
            </div>
            <div className="auth-actions">
              <button className="btn btn-sync" onClick={handleSyncNow}>Sync now</button>
              <button className="btn btn-signout" onClick={handleSignOut}>Sign out</button>
            </div>
          </>
        ) : (
          <button className="btn btn-google" onClick={handleSignIn}>
            Sign in with Google
          </button>
        )}
      </section>

      <section className="notes-block">
        <div className="notes-heading">
          <h2>Notes</h2>
          <button
            type="button"
            className={`preview-toggle${previewMode ? " active" : ""}`}
            onClick={togglePreviewMode}
            aria-pressed={previewMode}
            title={previewMode ? "Turn previews off" : "Turn previews on"}
          >
            Preview {previewMode ? "on" : "off"}
          </button>
        </div>
        <form
          className="new-note-form"
          onSubmit={(e) => {
            e.preventDefault();
            openCustomNote("tab");
          }}
        >
          <input
            className="new-note-input"
            value={newNoteName}
            onChange={(e) => setNewNoteName(e.target.value)}
            placeholder="New note name"
            aria-label="New note name"
          />
          <button className="btn btn-new-note" type="submit">Create</button>
        </form>
        <div className="notes-picker">
          {options.length === 0 && <div className="empty">No notes yet.</div>}
          {options.map((opt) => {
            const noteId = opt.value.startsWith("context:") ? opt.value.replace(/^context:/, "") : opt.value;
            const canDelete = hasMeaningfulData(notesByCourse[noteId]);
            return (
              <div className="notes-row" key={opt.value}>
                <button
                  type="button"
                  className={`notes-row-main${opt.value === selected ? " active" : ""}`}
                  title={opt.label}
                  onClick={() => setSelected(opt.value)}
                  onMouseEnter={() => setPreviewedNoteId(noteId)}
                  onMouseLeave={() => setPreviewedNoteId(null)}
                  onFocus={() => setPreviewedNoteId(noteId)}
                  onBlur={() => setPreviewedNoteId(null)}
                >
                  {opt.label}
                </button>
                <button
                  type="button"
                  className="notes-row-delete"
                  disabled={!canDelete}
                  title={canDelete ? "Delete note" : "No saved note yet"}
                  onClick={() => canDelete && deleteNote(noteId)}
                >
                  x
                </button>
              </div>
            );
          })}
        </div>
        {notePreview && (
          <div className="note-preview-popover" aria-live="polite">
            <p className="preview-title">{notePreview.title}</p>
            <p className="preview-meta">{notePreview.meta}</p>
            <p className="preview-snippet">{notePreview.snippet}</p>
          </div>
        )}
        <div className="open-actions">
          <button className="btn" onClick={() => openNote("tab")}>Open page</button>
          <button className="btn btn-secondary" onClick={() => openNote("side")}>Side panel</button>
        </div>
      </section>
    </div>
  );
}

function buildOptions(notesByCourse, currentCtx) {
  const options = [];
  if (currentCtx && !currentCtx.isNotesPage) {
    options.push({ value: `context:${currentCtx.id}`, label: `Current page: ${currentCtx.label}` });
  }
  for (const [id, entry] of Object.entries(notesByCourse)) {
    if (currentCtx && id === currentCtx.id) continue;
    if (!hasMeaningfulData(entry)) continue;
    options.push({ value: `context:${id}`, label: entry.label || deriveLabelFromId(id) });
  }
  return options;
}
