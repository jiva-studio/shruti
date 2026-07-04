import { boot, el, setText, fmtMs, playMedia, showErr } from "./common";

let D: Record<string, unknown> = {};

function render(d: Record<string, unknown>): void {
  D = d || {};
  setText("meta", D.title || "Lecture excerpt");
  const sub: string[] = [];
  if (typeof D.author === "string" && D.author) sub.push(D.author);
  if (typeof D.date === "string" && D.date) sub.push(D.date);
  if (typeof D.start_ms === "number" && typeof D.end_ms === "number") {
    sub.push(fmtMs(D.start_ms) + "–" + fmtMs(D.end_ms));
  }
  setText("sub", sub.join(" · "));
  setText("text", D.text);

  el("au").style.display = "none";
  el("open").style.display = "none";
  const play = el("play") as HTMLButtonElement;
  play.style.display = "";
  play.disabled = false;
  setText("status", "");
}

async function onPlay(): Promise<void> {
  const args = { track_id: D.track_id, start_ms: D.start_ms, end_ms: D.end_ms };
  if (!args.track_id) return;
  const play = el("play") as HTMLButtonElement;
  play.disabled = true;
  setText("status", "Preparing…");
  try {
    const result = await app.callServerTool({ name: "excerpt_prepare", arguments: args });
    const sc = (result?.structuredContent as Record<string, unknown>) ?? {};
    const url = typeof sc.url === "string" ? sc.url : "";
    if (!url) {
      showErr("excerpt_prepare returned no url");
      play.disabled = false;
      setText("status", "");
      return;
    }
    play.style.display = "none";
    setText("status", "");
    const au = el("au") as HTMLAudioElement;
    au.style.display = "";
    au.addEventListener("canplay", () => { void au.play().catch(() => {}); }, { once: true });
    playMedia(au, url);
    const o = el("open") as HTMLAnchorElement;
    o.href = url;
    o.textContent = "↗ Open audio in a new tab";
    o.style.display = "";
  } catch (e) {
    showErr("prepare: " + String(e));
    setText("status", "Could not prepare audio");
    play.disabled = false;
  }
}

const app = boot("corpus-excerpt-player", render);
el("play").addEventListener("click", () => void onPlay());
