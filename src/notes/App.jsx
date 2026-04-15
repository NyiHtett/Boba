import { useState, useEffect, useRef, useCallback } from "react";
import {
  NOTES_KEY, BG_MODE_KEY, MAX_HISTORY, MAX_IMAGE_BYTES, MAX_IMAGES_PER_NOTE,
  BG_MODES, normalizeBgMode,
} from "../shared/storage";
import { onAuth, pushNote } from "../shared/firebase";
import { checkProStatus, openPaymentPage, openTrialPage } from "../shared/paywall";
import BobaRunner from "./BobaRunner";
import BobaMascot from "./BobaMascot";
import BobaQuiz from "./BobaQuiz";
import katex from "katex";
import "katex/dist/katex.min.css";

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
function stripInlineStyles(el) {
  const keep = new Set(["note-section", "note-image-wrap", "note-inline-image", "note-title-chip", "image-controls", "image-control-btn", "resize-handle", "note-math-chip"]);
  const unwrapTags = new Set(["B", "STRONG", "I", "EM", "U", "FONT", "MARK", "S", "STRIKE"]);
  // Unwrap formatting tags (replace with their text content)
  for (const tag of unwrapTags) {
    el.querySelectorAll(tag).forEach((node) => {
      if (node.closest(".note-image-wrap, .note-title-chip, .image-controls, .note-math-chip")) return;
      const parent = node.parentNode;
      while (node.firstChild) parent.insertBefore(node.firstChild, node);
      parent.removeChild(node);
    });
  }
  el.querySelectorAll("*").forEach((node) => {
    if (node.classList && [...node.classList].some((c) => keep.has(c))) return;
    if (node.tagName === "IMG") return;
    node.removeAttribute("style");
    node.removeAttribute("color");
    node.removeAttribute("face");
    node.removeAttribute("size");
  });
}
// ── Math equation helpers ──
function mathToLatex(input) {
  let s = input.trim();
  // sqrt() and root() → \sqrt{}
  s = s.replace(/(?:sqrt|root)\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g, (_, inner) => `\\sqrt{${mathToLatex(inner)}}`);
  // Handle fraction: (numerator)/(denominator)
  // Find balanced parens around /
  s = replaceFractions(s);
  // ^(expr) → ^{expr}  and ^single → ^{single}
  s = s.replace(/\^(\([^()]*(?:\([^()]*\)[^()]*)*\))/g, (_, group) => `^{${mathToLatex(group.slice(1, -1))}}`);
  s = s.replace(/\^([a-zA-Z0-9])/g, "^{$1}");
  // _(expr) → _{expr}
  s = s.replace(/_(\([^()]*(?:\([^()]*\)[^()]*)*\))/g, (_, group) => `_{${mathToLatex(group.slice(1, -1))}}`);
  s = s.replace(/_([a-zA-Z0-9])/g, "_{$1}");
  return s;
}

function replaceFractions(s) {
  let result = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "/" && i > 0) {
      // ── Find numerator (walk back) ──
      let nb = i - 1;
      while (nb >= 0 && s[nb] === " ") nb--;
      let numStart = -1, numInner = "";
      if (nb >= 0 && s[nb] === ")") {
        // Balanced parens group
        let depth = 0;
        for (let j = nb; j >= 0; j--) {
          if (s[j] === ")") depth++;
          else if (s[j] === "(") { depth--; if (depth === 0) { numStart = j; break; } }
        }
        if (numStart >= 0) numInner = s.slice(numStart + 1, nb);
      } else if (nb >= 0) {
        // Plain token: word chars, digits, dots (e.g. log2, x, 3.14)
        let j = nb;
        while (j >= 0 && /[a-zA-Z0-9._]/.test(s[j])) j--;
        numStart = j + 1;
        if (numStart <= nb) numInner = s.slice(numStart, nb + 1);
        else numStart = -1;
      }

      // ── Find denominator (walk forward) ──
      let da = i + 1;
      while (da < s.length && s[da] === " ") da++;
      let denEnd = -1, denInner = "";
      if (da < s.length && s[da] === "(") {
        // Balanced parens group
        let depth = 0;
        for (let j = da; j < s.length; j++) {
          if (s[j] === "(") depth++;
          else if (s[j] === ")") { depth--; if (depth === 0) { denEnd = j; break; } }
        }
        if (denEnd >= 0) denInner = s.slice(da + 1, denEnd);
      } else if (da < s.length && /[a-zA-Z0-9]/.test(s[da])) {
        // Plain token
        let j = da;
        while (j < s.length && /[a-zA-Z0-9._]/.test(s[j])) j++;
        denEnd = j - 1;
        denInner = s.slice(da, j);
      }

      if (numStart >= 0 && denEnd >= 0) {
        const charsToRemove = i - numStart;
        result = result.slice(0, result.length - charsToRemove);
        result += `\\frac{${mathToLatex(numInner)}}{${mathToLatex(denInner)}}`;
        i = denEnd + 1;
        continue;
      }
    }
    result += s[i];
    i++;
  }
  return result;
}

function createMathChip(src) {
  const chip = document.createElement("span");
  chip.className = "note-math-chip";
  chip.contentEditable = "false";
  chip.setAttribute("data-math", src);
  try {
    katex.render(mathToLatex(src), chip, { throwOnError: false, displayMode: false });
  } catch {
    chip.textContent = src;
  }
  return chip;
}

function hydrateMathChip(chip) {
  const src = chip.getAttribute("data-math") || "";
  chip.contentEditable = "false";
  try {
    katex.render(mathToLatex(src), chip, { throwOnError: false, displayMode: false });
  } catch {
    chip.textContent = src;
  }
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
  const [label, setLabel] = useState(ctx.label);
  const labelRef = useRef(ctx.label);
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
  const [bgMode, setBgMode] = useState("midnight");
  const [showGame, setShowGame] = useState(false);
  const [agentAwake, setAgentAwake] = useState(false);
  const [quizPhase, setQuizPhase] = useState("idle");
  const [quizSection, setQuizSection] = useState(null);
  const [isPro, setIsPro] = useState(null);
  const [proUser, setProUser] = useState(null);
  const isProRef = useRef(false);
  const sheetRef = useRef(null);

  // Track signed-in user so we can sync to Firestore on save
  const userRef = useRef(null);
  useEffect(() => {
    return onAuth((u) => { userRef.current = u; });
  }, []);

  // Check paywall status
  useEffect(() => {
    checkProStatus().then(({ isPro: pro, user }) => {
      setIsPro(pro);
      setProUser(user);
      isProRef.current = pro;
    }).catch(() => { setIsPro(false); isProRef.current = false; });
  }, []);

  const showUpgradePrompt = useCallback(() => {
    if (!proUser?.trialStartedAt) {
      if (confirm("This is a Pro feature. Start your free 3-day trial?")) openTrialPage();
    } else {
      if (confirm("Your trial has ended. Upgrade to Boba Pro for $4.99/month?")) openPaymentPage();
    }
  }, [proUser]);

  const notesRef = useRef({});

  // ── Serialization ──
  const serializeHtml = useCallback(() => {
    const el = editorRef.current;
    if (!el) return "";
    const clone = el.cloneNode(true);
    clone.querySelectorAll(".image-controls").forEach((n) => n.remove());
    clone.querySelectorAll(".note-math-chip").forEach((c) => c.removeAttribute("contenteditable"));
    clone.querySelectorAll(".note-section").forEach((s) => s.classList.remove("quiz-active"));
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
    clone.querySelectorAll(".note-math-chip").forEach((c) => c.replaceWith(document.createTextNode(c.getAttribute("data-math") || "")));
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
    if (!isProRef.current) return;
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
    entry.label = labelRef.current;
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
    del.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      wrap.remove();
      setStatus("Saving...");
      save(true).catch((err) => { console.error("Delete-image save failed:", err); setStatus("Storage is full."); });
    });
    controls.appendChild(del);

    for (const dir of ["nw", "ne", "sw", "se"]) {
      const h = document.createElement("span");
      h.className = `resize-handle ${dir}`; h.dataset.dir = dir;
      wrap.appendChild(h);
    }
    wrap.appendChild(img);
    wrap.appendChild(controls);
    return wrap;
  }, [queueAutosave, save]);

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
          s.classList.remove("quiz-active");
          if (!s.hasAttribute("data-placeholder")) s.setAttribute("data-placeholder", "Start writing...");
          normalizeContent(s);
        });
        // Remove empty trailing sections (except the first one)
        const allSections = el.querySelectorAll(".note-section");
        for (let i = allSections.length - 1; i > 0; i--) {
          const sec = allSections[i];
          const hasText = (sec.textContent || "").trim();
          const hasImage = sec.querySelector(".note-image-wrap, img");
          if (!hasText && !hasImage) sec.remove();
          else break;
        }
        const mainSec = el.querySelector(".note-section");
        for (const node of Array.from(el.childNodes)) {
          if (node.nodeType === Node.ELEMENT_NODE && node.classList.contains("note-section")) continue;
          mainSec.appendChild(node);
        }
        decorateImages();
        hydrateMathChips(el);
        stripInlineStyles(el);
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
            hydrateMathChips(editorRef.current);
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
    for (const m of BG_MODES) document.body.classList.remove(`bg-${m}`);
    document.body.classList.add(`bg-${bgMode}`);
  }, [bgMode]);

  // ── Auto-format $...$ math ──
  const tryAutoMath = useCallback(() => {
    const sel = window.getSelection();
    if (!sel?.rangeCount) return;
    const node = sel.anchorNode;
    if (!node || node.nodeType !== Node.TEXT_NODE) return;
    const text = node.textContent || "";
    const cursor = sel.anchorOffset;
    // Just typed closing $? Find matching opening $
    if (cursor < 1 || text[cursor - 1] !== "$") return;
    const before = text.slice(0, cursor - 1);
    const openIdx = before.lastIndexOf("$");
    if (openIdx < 0) return;
    const mathSrc = text.slice(openIdx + 1, cursor - 1).trim();
    if (!mathSrc) return;
    // Split text node: [before $] [math chip] [after $]
    const afterText = text.slice(cursor);
    const beforeText = text.slice(0, openIdx);
    const chip = createMathChip(mathSrc);
    const parent = node.parentNode;
    const afterNode = document.createTextNode(afterText || "\u200B");
    node.textContent = beforeText;
    parent.insertBefore(chip, node.nextSibling);
    parent.insertBefore(afterNode, chip.nextSibling);
    // Place cursor after chip
    const r = document.createRange();
    r.setStart(afterNode, afterText ? 0 : 1);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }, []);

  // ── Editor event handlers ──
  const handleInput = useCallback(() => {
    setStatus("Typing...");
    tryAutoMath();
    queueAutosave(600);
  }, [queueAutosave, tryAutoMath]);

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
    if (autosaveTimer.current) { clearTimeout(autosaveTimer.current); autosaveTimer.current = null; }
    save(true).catch((e) => { console.error(e); setStatus("Storage is full."); });
  }, [save]);

  const handlePaste = useCallback((e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const files = items.filter((i) => i.type?.startsWith("image/")).map((i) => i.getAsFile()).filter(Boolean);
    if (files.length) {
      e.preventDefault();
      addImagesAtCursor(files);
      return;
    }
    // Strip formatting: paste as plain text only
    const text = e.clipboardData?.getData("text/plain");
    if (text != null) {
      e.preventDefault();
      document.execCommand("insertText", false, text);
    }
  }, [addImagesAtCursor]);

  const handleEditorClick = useCallback((e) => {
    editorRef.current?.querySelectorAll(".note-image-wrap.selected").forEach((n) => n.classList.remove("selected"));
    const wrap = e.target.closest(".note-image-wrap");
    if (wrap) wrap.classList.add("selected");
    // Double-click a math chip to revert to editable text
    if (e.detail === 2) {
      const chip = e.target.closest(".note-math-chip");
      if (chip) {
        e.preventDefault();
        const src = chip.getAttribute("data-math") || "";
        const textNode = document.createTextNode(src);
        chip.replaceWith(textNode);
        const sel = window.getSelection();
        const r = document.createRange(); r.selectNode(textNode);
        sel.removeAllRanges(); sel.addRange(r);
        handleInput();
      }
    }
  }, [handleInput]);

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

  const syncSaveNow = useCallback(() => {
    const html = serializeHtml();
    const text = getPlainText();
    if (html === lastSavedHtml.current) return;
    const notes = { ...notesRef.current };
    const entry = notes[ctx.contextId] || { text: "", html: "", history: [] };
    entry.html = html;
    entry.text = text;
    entry.label = labelRef.current;
    entry.sourceUrl = ctx.sourceUrl;
    entry.updatedAt = Date.now();
    notes[ctx.contextId] = entry;
    notesRef.current = notes;
    lastSavedHtml.current = html;
    chrome.storage.local.set({ [NOTES_KEY]: notes });
  }, [ctx, serializeHtml, getPlainText]);

  useEffect(() => {
    const onBeforeUnload = (e) => {
      if (autosaveTimer.current) { clearTimeout(autosaveTimer.current); autosaveTimer.current = null; }
      syncSaveNow();
    };
    document.addEventListener("visibilitychange", handleVisChange);
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("pagehide", () => {
      if (autosaveTimer.current) { clearTimeout(autosaveTimer.current); autosaveTimer.current = null; }
      syncSaveNow();
    });
    return () => {
      document.removeEventListener("visibilitychange", handleVisChange);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [handleVisChange, save, syncSaveNow]);

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

  const formatMathSelection = useCallback(() => {
    const sel = window.getSelection();
    const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
    if (!range || range.collapsed || !editorRef.current.contains(range.commonAncestorContainer)) {
      setStatus("Select equation text first"); return;
    }
    // If selection is inside a math chip, un-format it back to text
    const existingChip = range.commonAncestorContainer.closest?.(".note-math-chip")
      || range.startContainer.parentElement?.closest?.(".note-math-chip");
    if (existingChip) {
      const src = existingChip.getAttribute("data-math") || "";
      const textNode = document.createTextNode(src);
      existingChip.replaceWith(textNode);
      const r = document.createRange(); r.selectNode(textNode);
      sel.removeAllRanges(); sel.addRange(r);
      handleInput();
      return;
    }
    const src = range.toString().trim();
    if (!src) { setStatus("Select equation text first"); return; }
    const chip = createMathChip(src);
    range.deleteContents();
    range.insertNode(chip);
    const ar = document.createRange(); ar.setStartAfter(chip); ar.collapse(true);
    sel.removeAllRanges(); sel.addRange(ar);
    handleInput();
  }, [handleInput]);

  // Re-hydrate math chips after loading HTML from storage
  const hydrateMathChips = useCallback((container) => {
    container.querySelectorAll(".note-math-chip").forEach((chip) => hydrateMathChip(chip));
  }, []);

  const exportPdf = useCallback(() => {
    const el = editorRef.current;
    if (!el || !(el.textContent || "").trim()) { setStatus("Nothing to export"); return; }
    const clone = el.cloneNode(true);
    clone.querySelectorAll(".note-image-wrap, img, .image-controls").forEach((n) => n.remove());
    // Replace math chips with their source text for PDF
    clone.querySelectorAll(".note-math-chip").forEach((c) => c.replaceWith(document.createTextNode(c.getAttribute("data-math") || "")));
    // Convert sections and <br> into paragraphs
    const paragraphs = [];
    clone.querySelectorAll(".note-section").forEach((sec) => {
      const html = sec.innerHTML.replace(/<div><br><\/div>/g, "<br>").replace(/<div>/g, "<br>").replace(/<\/div>/g, "");
      const lines = html.split(/<br\s*\/?>/i);
      for (const line of lines) {
        const txt = line.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
        paragraphs.push(txt);
      }
      paragraphs.push("");
    });
    const body = paragraphs.map((l) => l ? `<p>${escapeHtml(l)}</p>` : `<br>`).join("");
    const win = window.open("", "_blank");
    const title = labelRef.current;
    win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;max-width:680px;margin:40px auto;padding:0 24px;color:#222;font-size:15px;line-height:1.8}h1{font-size:22px;margin-bottom:24px}p{margin:0}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`);
    win.document.close();
    win.print();
  }, []);

  // ── Quiz ──
  const getSectionText = useCallback((sectionEl) => {
    if (!sectionEl) return "";
    const clone = sectionEl.cloneNode(true);
    clone.querySelectorAll(".image-controls").forEach((n) => n.remove());
    clone.querySelectorAll(".note-math-chip").forEach((c) => c.replaceWith(document.createTextNode(c.getAttribute("data-math") || "")));
    clone.querySelectorAll(".note-image-wrap").forEach((w) => w.replaceWith(document.createTextNode(" ")));
    return (clone.textContent || "").replace(/\s+/g, " ").trim();
  }, []);

  const handleQuizSelect = useCallback((sectionEl) => {
    setQuizSection(sectionEl);
    setQuizPhase("loading");
  }, []);

  const handleQuizComplete = useCallback(() => {
    setQuizPhase("restoring");
    setTimeout(() => {
      setQuizPhase("idle");
      setQuizSection(null);
      setAgentAwake(false);
    }, 1500);
  }, []);

  const handleQuizClose = useCallback(() => {
    editorRef.current?.querySelectorAll(".note-section.quiz-active").forEach((s) => s.classList.remove("quiz-active"));
    setQuizPhase("idle");
    setQuizSection(null);
    setAgentAwake(false);
  }, []);

  // ── Background mode ──
  const changeBg = useCallback(async (mode) => {
    const m = normalizeBgMode(mode);
    setBgMode(m);
    await chrome.storage.local.set({ [BG_MODE_KEY]: m });
  }, []);

  const handleLabelChange = useCallback((e) => {
    const val = e.target.value;
    setLabel(val);
    labelRef.current = val;
    queueAutosave(800);
  }, [queueAutosave]);

  const handleOpenSource = useCallback(() => {
    if (ctx.sourceUrl) window.location.href = ctx.sourceUrl;
  }, [ctx.sourceUrl]);

  return (
    <>
      <header>
        <div className="title">
          <input
            className="title-input"
            value={label}
            onChange={handleLabelChange}
            onBlur={() => save(false).catch(console.error)}
            spellCheck={false}
          />
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
          ref={sheetRef}
          onDragOver={(e) => { if (!e.dataTransfer?.types?.includes("text/pb-image-id")) { e.preventDefault(); } }}
          onDrop={handleSheetDrop}
        >
          <BobaRunner visible={showGame} onClose={() => setShowGame(false)} />
          <BobaQuiz
            phase={quizPhase}
            sectionEl={quizSection}
            editorEl={editorRef.current}
            sheetEl={sheetRef.current}
            onSelectSection={handleQuizSelect}
            getSectionText={getSectionText}
            onPhaseChange={setQuizPhase}
            onComplete={handleQuizComplete}
            onClose={handleQuizClose}
          />
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
              <button type="button" className="btn section-tool-btn" onClick={splitSection} aria-label="Split section">
                <span className="tool-icon">&#x1f528;</span><span className="tool-label">Break</span>
              </button>
              <button type="button" className="btn section-tool-btn" onClick={mergeSection} aria-label="Merge section">
                <span className="tool-icon">&#x1fa79;</span><span className="tool-label">Patch</span>
              </button>
              <button type="button" className="btn section-tool-btn" onClick={titleSelection} aria-label="Title selection">
                <span className="tool-icon">&#x1f3f7;</span><span className="tool-label">Highlight</span>
              </button>
              <button type="button" className="btn section-tool-btn" onClick={formatMathSelection} aria-label="Format math equation">
                <span className="tool-icon math-tool-icon">&#x1d453;</span><span className="tool-label">Math</span>
              </button>
              <button type="button" className="btn section-tool-btn" onClick={exportPdf} aria-label="Export PDF">
                <span className="tool-icon">&#x1f4c4;</span><span className="tool-label">Export</span>
              </button>
            </div>
            <button type="button" className="btn section-tool-btn game-btn" onClick={() => setShowGame((v) => !v)} aria-label="Boba Run">
              <span className="tool-icon">&#x1f9cb;</span><span className="tool-label">{showGame ? "Close game" : "Boba Run"}</span>
            </button>
          </div>
          <div className={`mascot-area${agentAwake ? " agent-active" : ""}`}>
            {quizPhase === "selecting" && (
              <div className="speech-bubble">Tap a dot to pick a block!</div>
            )}
            <BobaMascot awake={agentAwake} onClick={() => {
              if (quizPhase !== "idle") { handleQuizClose(); return; }
              if (!isPro) { showUpgradePrompt(); return; }
              setAgentAwake(true); setQuizPhase("selecting");
            }} />
            <p className="mascot-hint">
              {quizPhase === "loading" ? "Brewing..." :
               quizPhase !== "idle" ? "Quizzing..." :
               "Tap to wake"}
            </p>
          </div>
          <div className="scene-panel">
            <p className="label">Background scene</p>
            <div className="scene-switch">
              {[["midnight", "Midnight"], ["fire", "Fire"]].map(([id, label]) => (
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
