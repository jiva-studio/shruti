package mcpsrv

// mediaPlayerHTML is the self-contained page served at ui://corpus/media-player.html.
// It receives the flat player data on result.structuredContent and binds a
// native <video controls> to data.url, respecting the video's intrinsic aspect
// (width:100%; height:auto). The ext-apps App auto-resizes the host iframe to
// the content; we also nudge sendSizeChanged after the video's metadata loads.
const mediaPlayerHTML = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: transparent; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1a1a1a; }
  #card { max-width: 560px; margin: 0 auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
  #title { font-size: 15px; font-weight: 600; line-height: 1.3; }
  #text { font-size: 13px; line-height: 1.45; opacity: .8; white-space: pre-wrap; }
  video { width: 100%; height: auto; display: block; border-radius: 10px; background: #000; }
  @media (prefers-color-scheme: dark) { body { color: #ececec; } }
  :root[data-theme="dark"] body { color: #ececec; }
  :root[data-theme="light"] body { color: #1a1a1a; }
</style>
<div id="card">
  <div id="title"></div>
  <div id="text"></div>
  <video id="v" controls playsinline preload="metadata"></video>
</div>
<script type="module">
  import { App } from "https://esm.sh/@modelcontextprotocol/ext-apps";

  const app = new App({ name: "corpus-media-player", version: "1.0.0" });
  const titleEl = document.getElementById("title");
  const textEl = document.getElementById("text");
  const v = document.getElementById("v");

  function reportSize() {
    try {
      if (typeof app.sendSizeChanged === "function") {
        app.sendSizeChanged({
          width: document.documentElement.scrollWidth,
          height: Math.ceil(document.documentElement.scrollHeight),
        });
      }
    } catch (e) {}
  }

  function render(data) {
    data = data || {};
    titleEl.textContent = data.title || "";
    titleEl.style.display = data.title ? "" : "none";
    textEl.textContent = data.text || "";
    textEl.style.display = data.text ? "" : "none";
    if (data.url) {
      v.src = data.url;
      v.style.display = "";
    } else {
      v.style.display = "none";
    }
    reportSize();
  }

  // Once real dimensions are known the iframe should match the video's aspect.
  v.addEventListener("loadedmetadata", reportSize);
  v.addEventListener("loadeddata", reportSize);

  app.ontoolresult = (result) => { render(result && result.structuredContent); };
  app.connect();
</script>
`

// excerptPlayerHTML is the self-contained page served at
// ui://corpus/excerpt-player.html. A COMPACT wide card (title/author line +
// short transcript + play bar). On Play it mirrors the mobile chat-citation
// flow: HEAD the predicted clip; if missing, POST the share-audio endpoint,
// then HEAD-poll the predicted URL until the clip is ready. The ext-apps App
// auto-resizes the iframe to this small card's real height.
const excerptPlayerHTML = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: transparent; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1a1a1a; }
  #card { max-width: 520px; margin: 0 auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; }
  #meta { font-size: 14px; font-weight: 600; line-height: 1.3; }
  #sub { font-size: 12px; opacity: .7; }
  #text { font-size: 13px; line-height: 1.4; opacity: .85; }
  #bar { display: flex; align-items: center; gap: 10px; margin-top: 4px; }
  button#play { border: 0; border-radius: 999px; padding: 8px 16px; font-size: 14px; font-weight: 600; cursor: pointer; background: #3a7d5c; color: #fff; }
  button#play:disabled { opacity: .55; cursor: default; }
  #status { font-size: 12px; opacity: .75; }
  audio { width: 100%; margin-top: 4px; }
  @media (prefers-color-scheme: dark) { body { color: #ececec; } }
  :root[data-theme="dark"] body { color: #ececec; }
  :root[data-theme="light"] body { color: #1a1a1a; }
</style>
<div id="card">
  <div id="meta"></div>
  <div id="sub"></div>
  <div id="text"></div>
  <div id="bar">
    <button id="play" type="button">▶ Play excerpt</button>
    <span id="status"></span>
  </div>
  <audio id="au" controls preload="none" style="display:none"></audio>
</div>
<script type="module">
  import { App } from "https://esm.sh/@modelcontextprotocol/ext-apps";

  const app = new App({ name: "corpus-excerpt-player", version: "1.0.0" });
  const $ = (id) => document.getElementById(id);
  let D = null;

  function reportSize() {
    try {
      if (typeof app.sendSizeChanged === "function") {
        app.sendSizeChanged({
          width: document.documentElement.scrollWidth,
          height: Math.ceil(document.documentElement.scrollHeight),
        });
      }
    } catch (e) {}
  }
  function setStatus(s) { $("status").textContent = s || ""; reportSize(); }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function fmtMs(ms) {
    const s = Math.round(ms / 1000);
    const m = Math.floor(s / 60);
    return m + ":" + String(s % 60).padStart(2, "0");
  }

  function render(data) {
    D = data || {};
    $("meta").textContent = D.title || "Lecture excerpt";
    const sub = [];
    if (D.author) sub.push(D.author);
    if (D.date) sub.push(D.date);
    if (D.start_ms != null && D.end_ms != null) sub.push(fmtMs(D.start_ms) + "–" + fmtMs(D.end_ms));
    $("sub").textContent = sub.join(" · ");
    $("sub").style.display = sub.length ? "" : "none";
    $("text").textContent = D.text || "";
    $("text").style.display = D.text ? "" : "none";
    reportSize();
  }

  async function head(url) {
    try { const r = await fetch(url, { method: "HEAD" }); return r.ok; } catch (e) { return false; }
  }

  function start(url) {
    const au = $("au");
    au.src = url;
    au.style.display = "";
    $("play").style.display = "none";
    setStatus("");
    au.play().catch(() => {});
    reportSize();
  }

  async function play() {
    if (!D || !D.audio) return;
    const a = D.audio;
    $("play").disabled = true;
    setStatus("Checking…");

    // 1) Already generated? (cross-cache with the mobile chat citation flow.)
    if (a.predicted_url && (await head(a.predicted_url))) { start(a.predicted_url); return; }

    // 2) Request generation from the public share-audio service.
    setStatus("Preparing…");
    let url = a.predicted_url;
    try {
      const resp = await fetch(a.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_key: a.source_key,
          start_ms: a.start_ms,
          end_ms: a.end_ms,
          excerpt_id: a.excerpt_id,
        }),
      });
      if (resp.ok) {
        const j = await resp.json().catch(() => ({}));
        if (j && j.ready === true && j.url) { start(j.url); return; }
        if (j && j.url) url = j.url;
      }
    } catch (e) {}

    // 3) ready:false → HEAD-poll the predicted URL (~45s).
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      await sleep(2000);
      if (await head(url)) { start(url); return; }
    }
    setStatus("Could not prepare audio — try again.");
    $("play").disabled = false;
  }

  $("play").addEventListener("click", play);
  app.ontoolresult = (result) => { render(result && result.structuredContent); };
  app.connect();
</script>
`
