// Minimal static file server with SPA fallback. Used in bundle mode (CI) to
// serve the prebuilt mobile-web-dist WITHOUT Vite — `vite preview` would load
// vite.config.ts, which imports the kit submodule that isn't checked out in the
// kit e2e job. No dependencies (Node built-ins only).
import http from "http"
import fs from "fs"
import path from "path"

const dir = process.argv[2]
const port = Number(process.argv[3] || 8080)

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".db": "application/octet-stream",
  ".mp3": "audio/mpeg",
}

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    let file = path.join(dir, decodeURIComponent(url.pathname))
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(dir, "index.html") // SPA history fallback
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404)
        res.end("not found")
        return
      }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" })
      res.end(data)
    })
  })
  .listen(port, () => console.log(`serve-dist: ${dir} on :${port}`))
