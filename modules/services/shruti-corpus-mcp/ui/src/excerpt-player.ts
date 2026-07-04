import { boot, el, setText, fmtMs, fmtTime, showErr, makeWaveform, type Waveform } from "./common";

let D: Record<string, unknown> = {};
let au: HTMLAudioElement;
let wave: Waveform | null = null;
let prepared = false;
let preparing = false;
let retries = 0;

function icon(state: "play" | "pause" | "busy"): void {
  el("i-play").hidden = state !== "play";
  el("i-pause").hidden = state !== "pause";
  el("i-spin").hidden = state !== "busy";
}

function fallbackDur(): number {
  if (typeof D.start_ms === "number" && typeof D.end_ms === "number") return (D.end_ms - D.start_ms) / 1000;
  return 0;
}

function updateTime(): void {
  const cur = au.currentTime || 0;
  const dur = isFinite(au.duration) && au.duration > 0 ? au.duration : fallbackDur();
  setText("time", fmtTime(cur) + " / " + fmtTime(dur));
  if (dur > 0 && wave) wave.setProgress(cur / dur);
}

function render(d: Record<string, unknown>): void {
  D = d || {};
  setText("title", D.title || "Lecture excerpt");
  const sub: string[] = [];
  if (typeof D.author === "string" && D.author) sub.push(D.author);
  if (typeof D.date === "string" && D.date) sub.push(D.date);
  if (typeof D.start_ms === "number" && typeof D.end_ms === "number") sub.push(fmtMs(D.start_ms) + "–" + fmtMs(D.end_ms));
  setText("sub", sub.join(" · "));

  prepared = false;
  preparing = false;
  retries = 0;
  au.removeAttribute("src");
  au.load();

  const seed = String(D.excerpt_id || D.track_id || D.title || "excerpt");
  el("wave").textContent = "";
  wave = makeWaveform(el("wave"), seed);
  wave.onSeek((f) => { if (isFinite(au.duration) && au.duration > 0) au.currentTime = f * au.duration; });
  icon("play");
  updateTime();
}

async function ensurePrepared(): Promise<boolean> {
  if (prepared) return true;
  if (preparing) return false;
  preparing = true;
  icon("busy");
  (el("play") as HTMLButtonElement).disabled = true;
  try {
    const res = await app.callServerTool({
      name: "excerpt_prepare",
      arguments: { track_id: D.track_id, start_ms: D.start_ms, end_ms: D.end_ms },
    });
    const sc = (res?.structuredContent as Record<string, unknown>) ?? {};
    const url = typeof sc.url === "string" ? sc.url : "";
    if (!url) {
      showErr("excerpt_prepare returned no url");
      return false;
    }
    au.src = url;
    prepared = true;
    return true;
  } catch (e) {
    showErr("prepare: " + String(e));
    return false;
  } finally {
    preparing = false;
    (el("play") as HTMLButtonElement).disabled = false;
  }
}

async function onPlay(): Promise<void> {
  if (!au.paused) {
    au.pause();
    return;
  }
  if (!D.track_id) return;
  if (!(await ensurePrepared())) {
    icon("play");
    return;
  }
  try {
    await au.play();
  } catch {
    /* clip may still be encoding — the error handler retries the load */
  }
}

const app = boot("corpus-excerpt-player", render);
au = el("au") as HTMLAudioElement;

el("play").addEventListener("click", () => void onPlay());
au.addEventListener("play", () => icon("pause"));
au.addEventListener("pause", () => { if (!preparing) icon("play"); });
au.addEventListener("ended", () => icon("play"));
au.addEventListener("timeupdate", updateTime);
au.addEventListener("loadedmetadata", updateTime);
au.addEventListener("error", () => {
  // share-audio clip may still be encoding (~4s) — retry the GET a few times.
  if (prepared && retries < 8) {
    retries++;
    icon("busy");
    setTimeout(() => {
      au.load();
      void au.play().catch(() => {});
    }, 1500);
  } else if (prepared) {
    showErr("audio load failed: " + (au.currentSrc || "?"));
    icon("play");
  }
});
