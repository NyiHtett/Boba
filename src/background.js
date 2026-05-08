chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get(["notesByCourse"]);
  if (!data.notesByCourse) {
    await chrome.storage.local.set({ notesByCourse: {} });
  }
});
