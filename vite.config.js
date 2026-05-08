import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { copyFileSync } from "fs";

function copyExtensionFiles() {
  return {
    name: "copy-extension-files",
    closeBundle() {
      const dist = resolve(__dirname, "dist");
      copyFileSync(resolve(__dirname, "manifest.extension.json"), resolve(dist, "manifest.json"));
    },
  };
}

export default defineConfig({
  plugins: [react(), copyExtensionFiles()],
  base: "",
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        popup: resolve(__dirname, "src/popup/index.html"),
        notes: resolve(__dirname, "src/notes/index.html"),
        background: resolve(__dirname, "src/background.js"),
      },
      output: {
        entryFileNames: (chunk) => {
          if (chunk.name === "background") return "background.js";
          return "assets/[name]-[hash].js";
        },
      },
    },
  },
});
