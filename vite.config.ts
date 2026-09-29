import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

const backendTarget = process.env.LOCAL_BACKEND_URL || "http://localhost:8000";
const devPort = Number(process.env.VITE_DEV_PORT || 8080);

// Bind HMR to loopback. host 0.0.0.0 makes Vite advertise a VDI/LAN IP; that
// websocket then goes through Skyhigh (also :8080) and the page full-reloads.
export default defineConfig(() => ({
  server: {
    host: "127.0.0.1",
    port: devPort,
    strictPort: true,
    // VDI/Skyhigh kills the HMR websocket about every 5 minutes (code 1006),
    // and Vite then full-reloads the tab. Keep the page stable locally.
    hmr: false,
    watch: {
      ignored: [
        "**/.git/**",
        "**/node_modules/**",
        "**/.venv/**",
        "**/backend/**",
        "**/supabase/**",
        "**/infra/**",
        "**/scripts/**",
        "**/dist/**",
        "**/__pycache__/**",
        "**/*.pyc",
        "**/tmp-*.ts",
      ],
    },
    proxy: {
      "/functions/v1": {
        target: backendTarget,
        changeOrigin: true,
        timeout: 900_000,
        proxyTimeout: 900_000,
      },
    },
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime", "@tanstack/react-query", "@tanstack/query-core"],
  },
}));
