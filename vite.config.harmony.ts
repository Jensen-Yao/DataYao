import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    "process.env": JSON.stringify({ NODE_ENV: "production" }),
  },
  build: {
    outDir: "dist-harmony",
    emptyOutDir: true,
    cssCodeSplit: false,
    modulePreload: false,
    lib: {
      entry: "src/main.tsx",
      name: "DataYaoHarmony",
      formats: ["iife"],
      fileName: () => "assets/datayao.js",
      cssFileName: "datayao",
    },
    rollupOptions: {
      output: {
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
