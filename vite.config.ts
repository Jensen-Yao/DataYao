import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: "./",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["datayao-mark.svg"],
      manifest: {
        name: "DataYao Offline Transfer",
        short_name: "DataYao",
        description: "Fast offline file transfer over animated QR codes.",
        theme_color: "#0b1118",
        background_color: "#0b1118",
        display: "standalone",
        icons: [
          { src: "datayao-mark.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }
        ]
      },
      workbox: {
        cleanupOutdatedCaches: true,
        navigateFallback: "index.html"
      }
    })
  ],
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts"]
  }
});
