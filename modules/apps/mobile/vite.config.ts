import vue from "@vitejs/plugin-vue"
import path from "node:path"
import { readFileSync } from "node:fs"
import { defineConfig } from "vite"

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"))
const dbScheme = JSON.parse(readFileSync(new URL("../../db-scheme.json", import.meta.url), "utf-8"))

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __BUILD_ID__: JSON.stringify(process.env.BUILD_ID ?? "dev"),
    __DB_SCHEME__: JSON.stringify(dbScheme.scheme),
  },
  build: {
    minify: true,
    sourcemap: true,
    rollupOptions: { treeshake: true },
  },
  server: {
    host: "0.0.0.0",
    port: 11001,
    strictPort: true,
    allowedHosts: ["mobile.lectorium.dev"],
  },
  plugins: [vue()],
  resolve: {
    preserveSymlinks: true,
    // `@lectorium` is also the npm scope for our audio-player plugin
    // (`@lectorium/audio-player`). A bare string alias of `@lectorium`
    // would prefix-match that too and hijack the npm resolution, so we
    // use a regex that explicitly excludes the npm subpath.
    alias: [
      { find: "@ports", replacement: path.resolve(__dirname, "./ports") },
      { find: "@infra", replacement: path.resolve(__dirname, "./infra") },
      { find: "@ui", replacement: path.resolve(__dirname, "./ui") },
      { find: "@lib/domain", replacement: path.resolve(__dirname, "./submodules/domain") },
      {
        find: "@lib/application",
        replacement: path.resolve(__dirname, "./submodules/application"),
      },
      {
        find: "@lib/persistence/main",
        replacement: path.resolve(__dirname, "./submodules/persistence-main"),
      },
      {
        find: "@lib/persistence/user",
        replacement: path.resolve(__dirname, "./submodules/persistence-user"),
      },
      {
        find: /^@lectorium\/(?!audio-player)(.*)$/,
        replacement: path.resolve(__dirname, "./lectorium") + "/$1",
      },
    ],
  },
})
