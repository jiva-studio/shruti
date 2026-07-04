import { boot, el, setText, playMedia } from "./common";

// media-player: play an existing corpus video clip. structuredContent =
// { title, text, url }.
function render(d: Record<string, unknown>): void {
  setText("title", d.title);
  setText("text", d.text);
  const v = el("v") as HTMLVideoElement;
  const o = el("open") as HTMLAnchorElement;
  const url = typeof d.url === "string" ? d.url : "";
  if (url) {
    v.style.display = "";
    playMedia(v, url);
    o.href = url;
    o.textContent = "↗ Open video in a new tab";
    o.style.display = "";
  } else {
    v.style.display = "none";
    o.style.display = "none";
  }
}

boot("corpus-media-player", render);
