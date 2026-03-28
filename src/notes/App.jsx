import { useState, useEffect, useRef, useCallback } from "react";
import {
  NOTES_KEY, BG_MODE_KEY, MAX_HISTORY, MAX_IMAGE_BYTES, MAX_IMAGES_PER_NOTE,
  BG_MODES, normalizeBgMode,
} from "../shared/storage";
import { onAuth, pushNote } from "../shared/firebase";

function getParams() {
  const p = new URLSearchParams(window.location.search);
  return {
    contextId: p.get("contextId") || "general:quick-note",
    label: p.get("label") || "Quick note",
    sourceUrl: p.get("sourceUrl") || null,
  };
}

function escapeHtml(t) {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function textToHtml(t) { return escapeHtml(t).replace(/\n/g, "<br>"); }
function normalizeHtml(h) {
  return String(h || "").replace(/<div><br><\/div>/g, "<br>").replace(/&nbsp;/g, " ").trim();
}
function stripImages(html) {
  const d = document.createElement("div");
  d.innerHTML = html;
  d.querySelectorAll(".note-image-wrap, img").forEach((n) => n.remove());
  return normalizeHtml(d.innerHTML);
}
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function fileToDataUrl(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result || ""));
    r.onerror = () => rej(r.error || new Error("read failed"));
    r.readAsDataURL(file);
  });
}

export default function App() {
  const ctx = useRef(getParams()).current;
  const editorRef = useRef(null);
  const autosaveTimer = useRef(null);
  const resizeSession = useRef(null);
  const lastRange = useRef(null);
  const lastSavedHtml = useRef("");
  const lastSnapText = useRef("");

  const [status, setStatus] = useState("Idle");
  const [words, setWords] = useState(0);
  const [lastSaved, setLastSaved] = useState("Never");
  const [snapshots, setSnapshots] = useState(0);
  const [bgMode, setBgMode] = useState("floating");

  // Track signed-in user so we can sync to Firestore on save
  const userRef = useRef(null);
  useEffect(() => {
    return onAuth((u) => { userRef.current = u; });
  }, []);

  const notesRef = useRef({});

  // ── Serialization ──
  const serializeHtml = useCallback(() => {
    const el = editorRef.current;
    if (!el) return "";
    const clone = el.cloneNode(true);
    clone.querySelectorAll(".image-controls").forEach((n) => n.remove());
    clone.querySelectorAll(".note-image-wrap").forEach((w) => {
      w.classList.remove("selected");
      w.removeAttribute("contenteditable");
      w.removeAttribute("draggable");
    });
    return normalizeHtml(clone.innerHTML);
  }, []);

  const getPlainText = useCallback(() => {
    const el = editorRef.current;
    if (!el) return "";
    const clone = el.cloneNode(true);
    clone.querySelectorAll(".image-controls").forEach((n) => n.remove());
    clone.querySelectorAll(".note-image-wrap").forEach((w) => w.replaceWith(document.createTextNode(" ")));
    return (clone.textContent || "").replace(/\s+/g, " ").trim();
  }, []);

  const updateStats = useCallback((text, history) => {
    setWords(text.trim() ? text.trim().split(/\s+/).length : 0);
    setSnapshots(history.length);
    setLastSaved(history.length ? new Date(history[history.length - 1].t).toLocaleString() : "Never");
  }, []);

  // ── Cloud sync (Firestore) ──
  const syncToCloud = useCallback(async (notes, noteId) => {
    const u = userRef.current;
    if (u && noteId && notes[noteId]) {
      try { await pushNote(u.uid, noteId, notes[noteId]); }
      catch (err) { console.error("Cloud sync failed:", err); }
    }
  }, []);

  const save = useCallback(async (forceSnapshot) => {
    const html = serializeHtml();
    const text = getPlainText();
    if (!forceSnapshot && html === lastSavedHtml.current) { setStatus("Saved"); return; }

    const notes = { ...notesRef.current };
    const entry = notes[ctx.contextId] || { text: "", html: "", history: [] };
    entry.html = html;
    entry.text = text;
    entry.label = ctx.label;
    entry.sourceUrl = ctx.sourceUrl;
    entry.updatedAt = Date.now();

    if (forceSnapshot && text !== lastSnapText.current) {
      const history = entry.history || [];
      history.push({ t: Date.now(), text });
      entry.history = history.slice(-MAX_HISTORY);
      lastSnapText.current = text;
    }

    notes[ctx.contextId] = entry;
    notesRef.current = notes;
    lastSavedHtml.current = html;

    try {
      await chrome.storage.local.set({ [NOTES_KEY]: notes });
    } catch (err) {
      const msg = String(err?.message || "");
      if (/QUOTA|quota|MAX_WRITE|bytes/i.test(msg)) {
        for (const e of Object.values(notes)) {
          if (e?.history) e.history = e.history.slice(-3);
        }
        try { await chrome.storage.local.set({ [NOTES_KEY]: notes }); }
        catch (retry) {
          if (/QUOTA|quota|MAX_WRITE|bytes/i.test(String(retry?.message || ""))) {
            if (entry.html) entry.html = stripImages(entry.html);
            await chrome.storage.local.set({ [NOTES_KEY]: notes });
          } else throw retry;
        }
      } else throw err;
    }

    await syncToCloud(notes, ctx.contextId);
    updateStats(text, entry.history || []);
    setStatus("Saved");
  }, [ctx, serializeHtml, getPlainText, updateStats, syncToCloud]);

  const queueAutosave = useCallback((delay) => {
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      save(false).catch((e) => { console.error("Autosave failed:", e); setStatus("Storage is full."); });
    }, delay);
  }, [save]);

  // ── Section helpers ──
  const createSection = useCallback(() => {
    const s = document.createElement("div");
    s.className = "note-section";
    s.setAttribute("contenteditable", "true");
    s.setAttribute("spellcheck", "true");
    s.setAttribute("data-placeholder", "Start writing...");
    return s;
  }, []);

  const findSection = useCallback((node) => {
    let c = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    while (c && c !== editorRef.current) {
      if (c.classList?.contains("note-section")) return c;
      c = c.parentElement;
    }
    return null;
  }, []);

  const getLastSection = useCallback(() => {
    const all = editorRef.current?.querySelectorAll(".note-section");
    return all?.length ? all[all.length - 1] : null;
  }, []);

  const normalizeContent = useCallback((section) => {
    if (!section) return;
    const vis = Boolean((section.textContent || "").trim()) || Boolean(section.querySelector(".note-image-wrap, img"));
    if (!vis) section.innerHTML = "";
  }, []);

  // ── Image helpers ──
  const createImageWrap = useCallback((dataUrl, name) => {
    const wrap = document.createElement("div");
    wrap.className = "note-image-wrap align-left";
    wrap.setAttribute("contenteditable", "false");
    wrap.setAttribute("draggable", "true");
    wrap.dataset.imageId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const img = document.createElement("img");
    img.src = dataUrl;
    img.alt = name || "Screenshot";
    img.className = "note-inline-image";

    const controls = document.createElement("div");
    controls.className = "image-controls";
    for (const [label, align] of [["Left", "left"], ["Right", "right"], ["Line", "line"]]) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "image-control-btn"; b.textContent = label;
      b.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        wrap.classList.remove("align-left", "align-right", "align-line");
        wrap.classList.add(`align-${align}`);
        setStatus("Typing..."); queueAutosave(300);
      });
      controls.appendChild(b);
    }
    const del = document.createElement("button");
    del.type = "button"; del.className = "image-control-btn danger"; del.textContent = "Delete";
    del.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); wrap.remove(); setStatus("Typing..."); queueAutosave(300); });
    controls.appendChild(del);

    for (const dir of ["nw", "ne", "sw", "se"]) {
      const h = document.createElement("span");
      h.className = `resize-handle ${dir}`; h.dataset.dir = dir;
      wrap.appendChild(h);
    }
    wrap.appendChild(img);
    wrap.appendChild(controls);
    return wrap;
  }, [queueAutosave]);

  const decorateImages = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    el.querySelectorAll("img.note-inline-image, img").forEach((img) => {
      const existing = img.closest(".note-image-wrap");
      if (existing) {
        existing.setAttribute("contenteditable", "false");
        existing.setAttribute("draggable", "true");
        return;
      }
      const wrap = createImageWrap(img.src, img.alt || "Screenshot");
      img.replaceWith(wrap);
    });
  }, [createImageWrap]);

  const countImages = useCallback(() => {
    return editorRef.current?.querySelectorAll("img.note-inline-image").length || 0;
  }, []);

  const addImagesAtCursor = useCallback(async (files) => {
    const slots = MAX_IMAGES_PER_NOTE - countImages();
    if (slots <= 0) { setStatus("Image limit reached"); return; }
    for (const file of files.slice(0, slots)) {
      if (file.size > MAX_IMAGE_BYTES) continue;
      const dataUrl = await fileToDataUrl(file);
      const section = findSection(document.activeElement) || getLastSection() || createSection();
      if (!editorRef.current.contains(section)) editorRef.current.appendChild(section);
      section.focus();
      const sel = window.getSelection();
      let range = sel?.rangeCount ? sel.getRangeAt(0) : null;
      if (!range || !editorRef.current.contains(range.commonAncestorContainer)) {
        range = document.createRange(); range.selectNodeContents(section); range.collapse(false);
      }
      const wrap = createImageWrap(dataUrl, file.name || "screenshot.png");
      const spacer = document.createElement("br");
      range.deleteContents(); range.insertNode(spacer); range.insertNode(wrap);
      range.setStartAfter(spacer); range.collapse(true);
      sel.removeAllRanges(); sel.addRange(range);
    }
    setStatus("Typing..."); queueAutosave(300);
  }, [countImages, findSection, getLastSection, createSection, createImageWrap, queueAutosave]);

  // ── Init ──
  useEffect(() => {
    (async () => {
      const data = await chrome.storage.local.get([NOTES_KEY, BG_MODE_KEY]);
      const notes = data[NOTES_KEY] || {};
      notesRef.current = notes;
      const mode = normalizeBgMode(data[BG_MODE_KEY]);
      setBgMode(mode);

      const entry = notesRef.current[ctx.contextId] || { text: "", html: "", history: [] };
      const el = editorRef.current;
      if (el) {
        el.innerHTML = entry.html || textToHtml(entry.text || "");
        if (!el.querySelector(".note-section")) {
          const s = createSection();
          s.innerHTML = el.innerHTML;
          el.innerHTML = "";
          el.appendChild(s);
        }
        el.querySelectorAll(".note-section").forEach((s) => {
          s.setAttribute("contenteditable", "true");
          s.setAttribute("spellcheck", "true");
          if (!s.hasAttribute("data-placeholder")) s.setAttribute("data-placeholder", "Start writing...");
          normalizeContent(s);
        });
        const mainSec = el.querySelector(".note-section");
        for (const node of Array.from(el.childNodes)) {
          if (node.nodeType === Node.ELEMENT_NODE && node.classList.contains("note-section")) continue;
          mainSec.appendChild(node);
        }
        decorateImages();
        lastSavedHtml.current = serializeHtml();
        lastSnapText.current = (entry.history?.length ? entry.history[entry.history.length - 1].text : "") || "";
        updateStats(getPlainText(), entry.history || []);
      }
    })();

    const listener = (changes, area) => {
      if (area !== "local") return;
      if (changes[BG_MODE_KEY]) setBgMode(normalizeBgMode(changes[BG_MODE_KEY].newValue));
      if (changes[NOTES_KEY]) {
        const fresh = changes[NOTES_KEY].newValue || {};
        notesRef.current = fresh;
        if (!editorRef.current?.contains(document.activeElement)) {
          const entry = fresh[ctx.contextId] || { text: "", html: "", history: [] };
          const newHtml = normalizeHtml(entry.html || textToHtml(entry.text || ""));
          if (newHtml !== serializeHtml()) {
            editorRef.current.innerHTML = entry.html || textToHtml(entry.text || "");
          }
          updateStats(getPlainText(), entry.history || []);
        }
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Apply bg mode class ──
  useEffect(() => {
    for (const m of BG_MODES) {
      if (m === "neoClassic") continue;
      document.body.classList.remove(`bg-${m}`);
    }
    if (bgMode !== "neoClassic") document.body.classList.add(`bg-${bgMode}`);
  }, [bgMode]);

  // ── Editor event handlers ──
  const handleInput = useCallback(() => {
    setStatus("Typing...");
    queueAutosave(1200);
  }, [queueAutosave]);

  const handleKeyDown = useCallback((e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (document.queryCommandSupported?.("insertLineBreak")) {
      document.execCommand("insertLineBreak");
    } else {
      const sel = window.getSelection();
      const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
      if (!range || !editorRef.current.contains(range.commonAncestorContainer)) return;
      const br = document.createElement("br");
      range.deleteContents(); range.insertNode(br);
      range.setStartAfter(br); range.collapse(true);
      sel.removeAllRanges(); sel.addRange(range);
    }
    handleInput();
  }, [handleInput]);

  const handleBlur = useCallback(() => {
    const sel = window.getSelection();
    if (sel?.rangeCount) {
      const r = sel.getRangeAt(0);
      if (editorRef.current?.contains(r.commonAncestorContainer)) lastRange.current = r.cloneRange();
    }
    save(true).catch((e) => { console.error(e); setStatus("Storage is full."); });
  }, [save]);

  const handlePaste = useCallback((e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const files = items.filter((i) => i.type?.startsWith("image/")).map((i) => i.getAsFile()).filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    addImagesAtCursor(files);
  }, [addImagesAtCursor]);

  const handleEditorClick = useCallback((e) => {
    editorRef.current?.querySelectorAll(".note-image-wrap.selected").forEach((n) => n.classList.remove("selected"));
    const wrap = e.target.closest(".note-image-wrap");
    if (wrap) wrap.classList.add("selected");
  }, []);

  const handleDragStart = useCallback((e) => {
    const wrap = e.target.closest(".note-image-wrap");
    if (!wrap) return;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/pb-image-id", wrap.dataset.imageId || "");
  }, []);

  const handleDragOver = useCallback((e) => {
    if (e.dataTransfer?.types?.includes("text/pb-image-id")) {
      e.preventDefault(); e.dataTransfer.dropEffect = "move";
    }
  }, []);

  const moveCaretToPoint = useCallback((x, y) => {
    const sec = findSection(document.activeElement) || getLastSection() || createSection();
    if (!editorRef.current.contains(sec)) editorRef.current.appendChild(sec);
    sec.focus();
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      if (r) { const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); }
    } else if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (p) {
        const r = document.createRange(); r.setStart(p.offsetNode, p.offset); r.collapse(true);
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      }
    }
  }, [findSection, getLastSection, createSection]);

  const handleDrop = useCallback((e) => {
    if (!e.dataTransfer?.types?.includes("text/pb-image-id")) return;
    e.preventDefault();
    const imageId = e.dataTransfer.getData("text/pb-image-id");
    if (!imageId) return;
    const wrap = editorRef.current.querySelector(`.note-image-wrap[data-image-id="${CSS.escape(imageId)}"]`);
    if (!wrap) return;
    moveCaretToPoint(e.clientX, e.clientY);
    const sel = window.getSelection();
    const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
    if (!range || !editorRef.current.contains(range.commonAncestorContainer)) return;
    range.deleteContents(); range.insertNode(wrap);
    const spacer = document.createElement("br");
    range.collapse(false); range.insertNode(spacer);
    handleInput();
  }, [moveCaretToPoint, handleInput]);

  const handleSheetDrop = useCallback((e) => {
    const files = Array.from(e.dataTransfer?.files || []).filter((f) => f.type?.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    moveCaretToPoint(e.clientX, e.clientY);
    addImagesAtCursor(files);
  }, [moveCaretToPoint, addImagesAtCursor]);

  const handleResizeDown = useCallback((e) => {
    const handle = e.target.closest(".resize-handle");
    if (!handle) return;
    const wrap = handle.closest(".note-image-wrap");
    if (!wrap) return;
    e.preventDefault(); e.stopPropagation();
    resizeSession.current = { wrap, dir: handle.dataset.dir || "se", startX: e.clientX, startWidth: wrap.getBoundingClientRect().width };

    const onMove = (ev) => {
      const s = resizeSession.current;
      if (!s?.wrap?.isConnected) return;
      const dx = ev.clientX - s.startX;
      const delta = s.dir.includes("w") ? -dx : dx;
      const max = Math.max(180, editorRef.current.clientWidth - 16);
      s.wrap.style.width = `${Math.round(clamp(s.startWidth + delta, 140, max))}px`;
    };
    const onUp = () => { window.removeEventListener("pointermove", onMove); resizeSession.current = null; handleInput(); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }, [handleInput]);

  const handleVisChange = useCallback(() => {
    if (document.visibilityState !== "hidden") return;
    if (autosaveTimer.current) { clearTimeout(autosaveTimer.current); autosaveTimer.current = null; }
    save(true).catch(console.error);
  }, [save]);

  useEffect(() => {
    document.addEventListener("visibilitychange", handleVisChange);
    window.addEventListener("pagehide", () => {
      if (autosaveTimer.current) { clearTimeout(autosaveTimer.current); autosaveTimer.current = null; }
      save(true).catch(console.error);
    });
    return () => document.removeEventListener("visibilitychange", handleVisChange);
  }, [handleVisChange, save]);

  // ── Section tools ──
  const splitSection = useCallback(() => {
    const sel = window.getSelection();
    let range = sel?.rangeCount ? sel.getRangeAt(0) : null;
    let section = range ? findSection(range.commonAncestorContainer) : null;
    if (!range || !section) {
      section = getLastSection() || createSection();
      if (!editorRef.current.contains(section)) editorRef.current.appendChild(section);
      section.focus();
      range = document.createRange(); range.selectNodeContents(section); range.collapse(false);
    }
    const splitR = range.cloneRange();
    const afterR = document.createRange();
    afterR.selectNodeContents(section); afterR.setStart(splitR.startContainer, splitR.startOffset);
    const frag = afterR.extractContents();
    normalizeContent(section);
    const newSec = createSection();
    if (frag.childNodes.length) newSec.appendChild(frag); else newSec.innerHTML = "";
    section.insertAdjacentElement("afterend", newSec);
    const nr = document.createRange(); nr.selectNodeContents(newSec); nr.collapse(true);
    newSec.focus(); sel.removeAllRanges(); sel.addRange(nr);
    handleInput();
  }, [findSection, getLastSection, createSection, normalizeContent, handleInput]);

  const mergeSection = useCallback(() => {
    const sel = window.getSelection();
    const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
    const cur = range ? findSection(range.commonAncestorContainer) : null;
    if (!cur) { setStatus("Place cursor in a section first"); return; }
    const prev = cur.previousElementSibling;
    if (!prev || !prev.classList.contains("note-section")) { setStatus("No section above"); return; }
    const prevHas = Boolean((prev.textContent || "").trim()) || Boolean(prev.querySelector(".note-image-wrap, img"));
    const curHas = Boolean((cur.textContent || "").trim()) || Boolean(cur.querySelector(".note-image-wrap, img"));
    if (prevHas && curHas) { prev.appendChild(document.createElement("br")); prev.appendChild(document.createElement("br")); }
    while (cur.firstChild) prev.appendChild(cur.firstChild);
    cur.remove(); normalizeContent(prev);
    const nr = document.createRange(); nr.selectNodeContents(prev); nr.collapse(false);
    prev.focus(); sel.removeAllRanges(); sel.addRange(nr);
    handleInput();
  }, [findSection, normalizeContent, handleInput]);

  const titleSelection = useCallback(() => {
    const sel = window.getSelection();
    const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
    if (!range || range.collapsed || !editorRef.current.contains(range.commonAncestorContainer)) {
      setStatus("Select text first"); return;
    }
    const chip = document.createElement("span");
    chip.className = "note-title-chip";
    chip.appendChild(range.extractContents());
    range.insertNode(chip);
    const ar = document.createRange(); ar.setStartAfter(chip); ar.collapse(true);
    sel.removeAllRanges(); sel.addRange(ar);
    handleInput();
  }, [handleInput]);

  // ── Background mode ──
  const changeBg = useCallback(async (mode) => {
    const m = normalizeBgMode(mode);
    setBgMode(m);
    await chrome.storage.local.set({ [BG_MODE_KEY]: m });
  }, []);

  const handleOpenSource = useCallback(() => {
    if (ctx.sourceUrl) window.location.href = ctx.sourceUrl;
  }, [ctx.sourceUrl]);

  return (
    <>
      <header>
        <div className="title">
          <h1>{ctx.label}</h1>
          <p className="sub">Note</p>
        </div>
        <div className="actions">
          <button className="btn ghost" disabled={!ctx.sourceUrl} onClick={handleOpenSource}>
            Open source page
          </button>
        </div>
      </header>

      <main>
        <div
          className="sheet"
          onDragOver={(e) => { if (!e.dataTransfer?.types?.includes("text/pb-image-id")) { e.preventDefault(); } }}
          onDrop={handleSheetDrop}
        >
          <div
            ref={editorRef}
            id="editor"
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            onPaste={handlePaste}
            onClick={handleEditorClick}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onPointerDown={handleResizeDown}
          />
        </div>

        <aside>
          <div className="panel">
            <div className="stat">
              <span className="label">Status</span>
              <span className="value">{status}</span>
            </div>
            <div className="stat">
              <span className="label">Words</span>
              <span className="value">{words}</span>
            </div>
            <div className="stat">
              <span className="label">Last saved</span>
              <span className="value">{lastSaved}</span>
            </div>
            <div className="stat">
              <span className="label">Snapshots</span>
              <span className="value">{snapshots}</span>
            </div>
            <div className="section-tools">
              <button type="button" className="btn section-tool-btn" onClick={splitSection} aria-label="Split section">&#x1f528;</button>
              <button type="button" className="btn section-tool-btn" onClick={mergeSection} aria-label="Merge section">&#x1fa79;</button>
              <button type="button" className="btn section-tool-btn" onClick={titleSelection} aria-label="Title selection">&#x1f3f7;</button>
            </div>
          </div>
          <div className="scene-panel">
            <p className="label">Background scene</p>
            <div className="scene-switch">
              {[["floating", "Floating mode"], ["midnight", "Midnight"], ["fire", "Fire"], ["neoClassic", "Classic pop"]].map(([id, label]) => (
                <button
                  key={id}
                  className={`scene-pill${bgMode === id ? " active" : ""}`}
                  onClick={() => changeBg(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </aside>
      </main>
    </>
  );
}
