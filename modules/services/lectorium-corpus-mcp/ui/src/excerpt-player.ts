import { boot, el, setText, fmtMs, showErr, makeWaveform, type Waveform } from "./common";

let D: Record<string, unknown> = {};
let au: HTMLAudioElement;
let wave: Waveform | null = null;
let prepared = false;
let loading = false;
let retries = 0;

function playBtn(): HTMLButtonElement {
  return el("play") as HTMLButtonElement;
}

function icon(state: "play" | "pause" | "busy"): void {
  // SVG elements don't reflect the `.hidden` IDL property — toggle display.
  el("i-play").style.display = state === "play" ? "" : "none";
  el("i-pause").style.display = state === "pause" ? "" : "none";
  el("i-spin").style.display = state === "busy" ? "" : "none";
}

// While loading, always show the spinner — the button's play/pause only reflects
// real playback state. This keeps the spinner up until the clip actually plays,
// not just until excerpt_prepare acks (share-audio replies before the mp3 exists).
function refreshIcon(): void {
  icon(loading ? "busy" : au.paused ? "play" : "pause");
}

function fallbackDur(): number {
  if (typeof D.start_ms === "number" && typeof D.end_ms === "number") return (D.end_ms - D.start_ms) / 1000;
  return 0;
}

function updateProgress(): void {
  const dur = isFinite(au.duration) && au.duration > 0 ? au.duration : fallbackDur();
  if (dur > 0 && wave) wave.setProgress((au.currentTime || 0) / dur);
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
  loading = false;
  retries = 0;
  au.removeAttribute("src");
  au.load();

  const seed = String(D.excerpt_id || D.track_id || D.title || "excerpt");
  el("wave").textContent = "";
  wave = makeWaveform(el("wave"), seed);
  wave.onSeek((f) => { if (isFinite(au.duration) && au.duration > 0) au.currentTime = f * au.duration; });
  playBtn().disabled = false;
  refreshIcon();
  updateProgress();
}

async function prepare(): Promise<boolean> {
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
  }
}

async function onPlay(): Promise<void> {
  if (!au.paused) {
    au.pause();
    return;
  }
  if (loading || !D.track_id) return;

  loading = true;
  retries = 0;
  playBtn().disabled = true;
  refreshIcon();

  if (!prepared && !(await prepare())) {
    loading = false;
    playBtn().disabled = false;
    refreshIcon();
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
au.addEventListener("playing", () => {
  loading = false;
  playBtn().disabled = false;
  refreshIcon();
});
au.addEventListener("pause", refreshIcon);
au.addEventListener("ended", refreshIcon);
au.addEventListener("timeupdate", updateProgress);
au.addEventListener("loadedmetadata", updateProgress);
au.addEventListener("error", () => {
  if (!loading) return;
  if (retries < 12) {
    retries++;
    setTimeout(() => {
      au.load();
      void au.play().catch(() => {});
    }, 1500);
  } else {
    loading = false;
    playBtn().disabled = false;
    refreshIcon();
    showErr("audio load failed: " + (au.currentSrc || "?"));
  }
});
