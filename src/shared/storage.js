export const NOTES_KEY = "notesByCourse";
export const BG_MODE_KEY = "notesBackgroundMode";
export const SURFACE_MODE_KEY = "notesSurfaceMode";
export const PREVIEW_MODE_KEY = "notesPreviewMode";

export const DEFAULT_BG_MODE = "midnight";
export const BG_MODES = ["midnight", "fire", "garden", "ocean"];
export const DEFAULT_SURFACE_MODE = "dark";
export const SURFACE_MODES = ["dark", "light"];
export const MAX_HISTORY = 40;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES_PER_NOTE = 12;

export function normalizeBgMode(mode) {
  return BG_MODES.includes(mode) ? mode : DEFAULT_BG_MODE;
}

export function normalizeSurfaceMode(mode) {
  return SURFACE_MODES.includes(mode) ? mode : DEFAULT_SURFACE_MODE;
}

export function hasMeaningfulData(entry) {
  if (!entry || typeof entry !== "object") return false;
  const text = String(entry.text || "").trim();
  const versions = Array.isArray(entry.history) ? entry.history.length : 0;
  return Boolean(text) || versions > 0 || Boolean(entry.html);
}

export function deriveLabelFromId(contextId) {
  if (!contextId) return "Saved note";
  if (contextId.startsWith("web:")) {
    const parts = contextId.split(":");
    const slug = parts[2] || "";
    const host = parts[1] || "Website";
    return slug
      ? slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
      : host;
  }
  if (contextId.startsWith("custom:")) {
    const parts = contextId.split(":");
    const slug = parts[1] || "";
    return slug
      ? slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
      : "Untitled note";
  }
  return "Saved note";
}
