package mcpsrv

import "strings"

// boot returns the shared MCP Apps handshake/message-loop JS with the app name
// substituted for this page.
func boot(appName string) string {
	return strings.Replace(mcpAppClientBoot, "__APP_NAME__", appName, 1)
}

// Both player pages are SELF-CONTAINED: they speak the MCP Apps postMessage
// protocol (SEP-1865) in vanilla JS with NO external script imports. The host
// renders them in a deny-by-default sandboxed iframe, which blocks loading any
// external module (an esm.sh import silently fails there), so the client is
// inlined. NOTE: this is a Go raw string literal (backtick-delimited) — the JS
// MUST NOT use backticks/template literals.

// mcpAppClientJS is the shared MCP Apps handshake + message loop. Each page
// defines a top-level render(structuredContent) function that this loop calls
// when the host pushes ui/notifications/tool-result. window.__reportSize()
// notifies the host of the content size so the iframe fits the content (no
// fixed square). appName is substituted per page.
const mcpAppClientHead = `
  function __reportSize() {
    try {
      window.parent.postMessage({
        jsonrpc: "2.0",
        method: "ui/notifications/size-changed",
        params: {
          width: document.documentElement.scrollWidth,
          height: Math.ceil(document.documentElement.scrollHeight)
        }
      }, "*");
    } catch (e) {}
  }
  window.__reportSize = __reportSize;
`

const mcpAppClientBoot = `
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var d = event.data;
    if (!d || typeof d !== "object" || d.jsonrpc !== "2.0") return;
    if (d.id !== undefined && d.result) {
      // Response to our ui/initialize — apply theme, ack, we're connected.
      var hc = d.result.hostContext || {};
      if (hc.theme) document.documentElement.setAttribute("data-theme", hc.theme);
      try {
        window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }, "*");
      } catch (e) {}
      __reportSize();
    } else if (d.method === "ui/notifications/tool-result") {
      try { render((d.params || {}).structuredContent); } catch (e) {}
    }
  });
  // Kick off the handshake; the host pushes the tool result after it responds.
  try {
    window.parent.postMessage({
      jsonrpc: "2.0", id: 1, method: "ui/initialize",
      params: { appInfo: { name: "__APP_NAME__", version: "1.0.0" }, appCapabilities: {} }
    }, "*");
  } catch (e) {}
  try { new ResizeObserver(function () { __reportSize(); }).observe(document.body); } catch (e) {}
  __reportSize();
`

// mediaPlayerHTML — ui://corpus/media-player.html. Binds a native
// <video controls> to structuredContent.url; width:100%/height:auto so the
// video's intrinsic aspect drives the iframe height (16:9 or 9:16).
var mediaPlayerHTML = `<meta charset="utf-8">
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
<script>
` + mcpAppClientHead + `
  function render(data) {
    data = data || {};
    var t = document.getElementById("title");
    var x = document.getElementById("text");
    var v = document.getElementById("v");
    t.textContent = data.title || "";
    t.style.display = data.title ? "" : "none";
    x.textContent = data.text || "";
    x.style.display = data.text ? "" : "none";
    if (data.url) { v.src = data.url; v.style.display = ""; } else { v.style.display = "none"; }
    __reportSize();
  }
  (function () {
    var v = document.getElementById("v");
    v.addEventListener("loadedmetadata", __reportSize);
    v.addEventListener("loadeddata", __reportSize);
  })();
` + boot("corpus-media-player") + `
</script>
`

// excerptPlayerHTML — ui://corpus/excerpt-player.html. Compact wide card. On
// Play it mirrors the mobile chat-citation flow against the public share-audio
// service: HEAD predicted -> POST -> HEAD-poll predicted -> play.
var excerptPlayerHTML = `<meta charset="utf-8">
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
    <button id="play" type="button">&#9654; Play excerpt</button>
    <span id="status"></span>
  </div>
  <audio id="au" controls preload="none" style="display:none"></audio>
</div>
<script>
` + mcpAppClientHead + `
  var D = null;
  function $(id) { return document.getElementById(id); }
  function setStatus(s) { $("status").textContent = s || ""; __reportSize(); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function fmtMs(ms) {
    var s = Math.round(ms / 1000), m = Math.floor(s / 60);
    return m + ":" + String(s % 60).padStart(2, "0");
  }
  function render(data) {
    D = data || {};
    $("meta").textContent = D.title || "Lecture excerpt";
    var sub = [];
    if (D.author) sub.push(D.author);
    if (D.date) sub.push(D.date);
    if (D.start_ms != null && D.end_ms != null) sub.push(fmtMs(D.start_ms) + "–" + fmtMs(D.end_ms));
    $("sub").textContent = sub.join(" · ");
    $("sub").style.display = sub.length ? "" : "none";
    $("text").textContent = D.text || "";
    $("text").style.display = D.text ? "" : "none";
    __reportSize();
  }
  function head(url) {
    return fetch(url, { method: "HEAD" }).then(function (r) { return r.ok; }).catch(function () { return false; });
  }
  function startPlay(url) {
    var au = $("au");
    au.src = url; au.style.display = "";
    $("play").style.display = "none";
    setStatus("");
    au.play().catch(function () {});
    __reportSize();
  }
  function play() {
    if (!D || !D.audio) return;
    var a = D.audio;
    $("play").disabled = true;
    setStatus("Checking…");
    head(a.predicted_url).then(function (ok) {
      if (ok) { startPlay(a.predicted_url); return; }
      setStatus("Preparing…");
      var url = a.predicted_url;
      fetch(a.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_key: a.source_key, start_ms: a.start_ms, end_ms: a.end_ms, excerpt_id: a.excerpt_id })
      }).then(function (resp) {
        if (!resp.ok) return null;
        return resp.json().catch(function () { return {}; });
      }).then(function (j) {
        if (j && j.ready === true && j.url) { startPlay(j.url); return; }
        if (j && j.url) url = j.url;
        var deadline = Date.now() + 45000;
        (function pollLoop() {
          if (Date.now() >= deadline) { setStatus("Could not prepare audio — try again."); $("play").disabled = false; return; }
          sleep(2000).then(function () { return head(url); }).then(function (ok2) {
            if (ok2) { startPlay(url); } else { pollLoop(); }
          });
        })();
      }).catch(function () { setStatus("Could not prepare audio — try again."); $("play").disabled = false; });
    });
  }
  (function () { $("play").addEventListener("click", play); })();
` + boot("corpus-excerpt-player") + `
</script>
`
