import { boot, el, setText } from "./common";

// media-player: play an existing corpus video clip. structuredContent =
// { title, url, poster }.
function render(d: Record<string, unknown>): void {
  setText("title", d.title);
  const v = el("v") as HTMLVideoElement;
  const url = typeof d.url === "string" ? d.url : "";
  const poster = typeof d.poster === "string" ? d.poster : "";
  if (poster) v.poster = poster;
  if (url) v.src = url;
}

boot("corpus-media-player", render);
