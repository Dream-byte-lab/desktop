import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import electron from "vite-plugin-electron/simple";
import path from "path";
import pkg from "./package.json" with { type: "json" };
import { contentSecurityPolicyPlugin } from "./vite.csp.ts";

export default defineConfig(({ command, mode }) => {
  if (command === "serve") {
    const devEnv = loadEnv(mode, process.cwd(), ["LINER_", "VITE_API_URL"]);
    for (const name of [
      "LINER_DEV_SIGNING_SECRET",
      "LINER_SIMULATE",
      "LINER_SIMULATE_COUNTRY",
      "VITE_API_URL",
    ]) {
      if (devEnv[name] && !process.env[name]) process.env[name] = devEnv[name];
    }
  }

  return {
    // The desktop build keeps the default root base. The web
    // version (GitHub Pages) builds with WEB_BASE=/desktop/ so
    // asset paths resolve under the repository's Pages subpath.
    base: process.env.WEB_BASE || "/",
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      // True only for the GitHub Pages build (WEB_BASE set): the
      // web version is intentional there, so the "should run
      // inside Electron" heads-up stays hidden.
      __LINERAVE_WEB__: JSON.stringify(Boolean(process.env.WEB_BASE)),
    },
    plugins: [
      react(),
      tailwindcss(),
      contentSecurityPolicyPlugin(),
      electron({
        main: {
          entry: "electron/main.ts",
        },
        preload: {
          input: "electron/preload.ts",
          vite: {
            build: {
              rollupOptions: {
                output: {
                  format: "cjs",
                  entryFileNames: "preload.cjs",
                },
              },
            },
          },
        },
      }),
    ],
    clearScreen: false,
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "./src"),
        "next/navigation": path.resolve(
          import.meta.dirname,
          "./src/lib/navigation.tsx",
        ),
        "next/link": path.resolve(
          import.meta.dirname,
          "./src/lib/navigation.tsx",
        ),
        "next/image": path.resolve(
          import.meta.dirname,
          "./src/components/ui/AppImage.tsx",
        ),
      },
    },
    server: {
      port: 5173,
      strictPort: true,
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      chunkSizeWarningLimit: 2048,
    },
  };
});
