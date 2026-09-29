import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { createViteProxyPlugin } from "./server/proxyCore.mjs";

export default defineConfig({
    root: __dirname,
    plugins: [react(), createViteProxyPlugin()],
    base: "./",
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "src"),
        },
    },
    server: {
        port: 5175,
        strictPort: true,
        host: true,
    },
    build: {
        outDir: "dist",
        chunkSizeWarningLimit: 3000,
    },
});
