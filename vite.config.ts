import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";
import { readFileSync } from "fs";

const host = process.env.TAURI_DEV_HOST;
const port = parseInt(process.env.VITE_PORT ?? "1420");
const hmrPort = parseInt(process.env.VITE_HMR_PORT ?? "1421");
const packageJson = JSON.parse(
  readFileSync(resolve(__dirname, "package.json"), "utf8"),
) as {
  version?: string;
};

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  define: {
    __UTTR_APP_VERSION__: JSON.stringify(packageJson.version ?? "0.0.0"),
  },

  // Path aliases
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
      "@/bindings": resolve(__dirname, "./src/bindings.ts"),
    },
  },

  // Multiple entry points for main app and overlay
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        uxReview: resolve(__dirname, "ux-review.html"),
        overlay: resolve(__dirname, "src/overlay/index.html"),
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: hmrPort,
        }
      : undefined,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
