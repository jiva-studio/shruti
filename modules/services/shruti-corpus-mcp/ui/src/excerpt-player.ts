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
let segNodes: HTMLElement[] = [];
let activeSeg = -1;
let pendingSeek = -1;

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

function metaLine(): string {
  const parts: string[] = [];
  if (typeof D.date === "string" && D.date) parts.push(D.date);
  if (typeof D.start_ms === "number" && typeof D.end_ms === "number") parts.push(fmtMs(D.start_ms) + "–" + fmtMs(D.end_ms));
  return parts.join(" · ");
}

function clipStart(): number {
  return typeof D.start_ms === "number" ? D.start_ms : 0;
}

// Scrolls a long transcript to follow playback, adjusting our own container
// only — scrollIntoView would drag the host's chat along with it.
function revealSpoken(node: HTMLElement): void {
  const box = el("transcript");
  if (box.scrollHeight <= box.clientHeight) return;
  const top = node.offsetTop - box.offsetTop;
  const bottom = top + node.offsetHeight;
  if (top < box.scrollTop) box.scrollTop = top;
  else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight;
}

// Highlights the sentence being spoken. The clip is cut at start_ms, so the
// audio clock is relative and the absolute position is start_ms + currentTime.
function highlightSpoken(): void {
  if (!segNodes.length) return;
  const at = clipStart() + (au.currentTime || 0) * 1000;
  let i = -1;
  if (!au.paused || au.currentTime > 0) {
    for (let k = 0; k < segments.length; k++) {
      if (at >= segments[k].start_ms && at < segments[k].end_ms) {
        i = k;
        break;
      }
    }
  }
  if (i === activeSeg) return;
  if (activeSeg >= 0) segNodes[activeSeg].classList.remove("spoken");
  activeSeg = i;
  if (i >= 0) {
    segNodes[i].classList.add("spoken");
    revealSpoken(segNodes[i]);
  }
}

function updateProgress(): void {
  if (pendingSeek >= 0 && isFinite(au.duration) && au.duration > 0) {
    au.currentTime = Math.min(pendingSeek, au.duration);
    pendingSeek = -1;
  }
  const dur = isFinite(au.duration) && au.duration > 0 ? au.duration : fallbackDur();
  if (dur > 0 && wave) wave.setProgress((au.currentTime || 0) / dur);
  highlightSpoken();
}

// Jumps to an absolute track position. Before the clip exists there is nothing
// to seek on, so the offset waits for loadedmetadata.
function seekTo(absMs: number): void {
  const t = Math.max(0, (absMs - clipStart()) / 1000);
  if (isFinite(au.duration) && au.duration > 0) au.currentTime = Math.min(t, au.duration);
  else pendingSeek = t;
  if (au.paused) void onPlay();
}

function renderTranscript(): void {
  const box = el("transcript");
  box.textContent = "";
  segNodes = [];
  activeSeg = -1;
  box.style.display = segments.length ? "" : "none";
  if (!segments.length) return;
  box.lang = typeof D.lang === "string" ? D.lang : "";
  segments.forEach((s, i) => {
    const node = document.createElement("span");
    node.className = "seg";
    node.textContent = s.text;
    node.addEventListener("click", () => seekTo(segments[i].start_ms));
    box.appendChild(node);
    box.appendChild(document.createTextNode(" "));
    segNodes.push(node);
  });
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
  pendingSeek = -1;
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
