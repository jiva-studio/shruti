import { boot, el, setText, fmtMs, showErr, makeWaveform, type Waveform } from "./common";

interface Segment {
  start_ms: number;
  end_ms: number;
  text: string;
}

let D: Record<string, unknown> = {};
let au: HTMLAudioElement;
let wave: Waveform | null = null;
let prepared = false;
let loading = false;
let retries = 0;
let segments: Segment[] = [];

function playBtn(): HTMLButtonElement {
  return el("play") as HTMLButtonElement;
}

// Always an explicit display value, never "". Clearing the inline style falls
// back to the markup's `hidden` attribute, which the UA honours on the spinner's
// <span> (but not on the <svg> glyphs) — that is why the spinner never appeared.
function icon(state: "play" | "pause" | "busy"): void {
  el("i-play").style.display = state === "play" ? "block" : "none";
  el("i-pause").style.display = state === "pause" ? "block" : "none";
  el("i-spin").style.display = state === "busy" ? "block" : "none";
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

function metaLine(): string {
  const parts: string[] = [];
  if (typeof D.date === "string" && D.date) parts.push(D.date);
  if (typeof D.start_ms === "number" && typeof D.end_ms === "number") parts.push(fmtMs(D.start_ms) + "–" + fmtMs(D.end_ms));
  return parts.join(" · ");
}

function updateProgress(): void {
  const dur = isFinite(au.duration) && au.duration > 0 ? au.duration : fallbackDur();
  if (dur > 0 && wave) wave.setProgress((au.currentTime || 0) / dur);
}

function renderTranscript(): void {
  const box = el("transcript");
  box.lang = typeof D.lang === "string" ? D.lang : "";
  box.textContent = segments.map((s) => s.text).join(" ");
  box.style.display = segments.length ? "" : "none";
}

function render(d: Record<string, unknown>): void {
  D = d || {};
  segments = Array.isArray(D.transcript) ? (D.transcript as Segment[]).filter((s) => s && typeof s.text === "string") : [];
  renderTranscript();

  setText("author", D.author || "");
  setText("title", D.title || "Lecture excerpt");
  setText("sub", metaLine());

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
  } catch (e) {
    // A rejected play() usually means the clip is still encoding, and the error
    // handler retries the load. But it also fires when the user activation
    // expired while excerpt_prepare was cutting the clip — nothing retries that,
    // so hand the button back instead of spinning forever. The clip is prepared
    // by then, so the next tap plays at once.
    if ((e as Error | undefined)?.name === "NotAllowedError") {
      loading = false;
      playBtn().disabled = false;
      refreshIcon();
    }
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
