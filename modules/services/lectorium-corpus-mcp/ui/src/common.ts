import { App, applyHostStyleVariables, applyHostFonts, applyDocumentTheme } from "@modelcontextprotocol/ext-apps";
import "./style.css";

// Adopt the host's theme, CSS variables and fonts so the widget matches whatever
// agent renders it. Our brand values stay as CSS fallbacks when a host provides
// none. App doesn't apply these automatically (only autoResize is auto).
function applyHost(ctx: { theme?: unknown; styles?: { variables?: unknown; css?: { fonts?: unknown } } } | undefined): void {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme as never);
  const styles = ctx.styles;
  if (styles?.variables) applyHostStyleVariables(styles.variables as never);
  if (styles?.css?.fonts) applyHostFonts(styles.css.fonts as string);
}

export function boot(name: string, render: (data: Record<string, unknown>) => void): App {
  const app = new App({ name, version: "1.0.0" });
  app.ontoolresult = (result) => {
    try {
      render((result?.structuredContent as Record<string, unknown>) ?? {});
    } catch (e) {
      showErr("render: " + String(e));
    }
  };
  app.addEventListener("hostcontextchanged", (ctx) => applyHost(ctx as never));
  app
    .connect()
    .then(() => applyHost(app.getHostContext() as never))
    .catch((e) => showErr("connect: " + String(e)));
  return app;
}

export function el(id: string): HTMLElement {
  return document.getElementById(id)!;
}

export function setText(id: string, value: unknown): void {
  const s = value == null ? "" : String(value);
  const node = el(id);
  node.textContent = s;
  node.style.display = s ? "" : "none";
}

export function showErr(msg: string): void {
  const e = document.getElementById("err");
  if (e) {
    e.textContent += (e.textContent ? "\n" : "") + msg;
    e.style.display = "";
  }
}

export function fmtMs(ms: number): string {
  const s = Math.round(ms / 1000);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

export function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const mm = h > 0 ? String(m % 60).padStart(2, "0") : String(m);
  return (h > 0 ? h + ":" : "") + mm + ":" + String(s % 60).padStart(2, "0");
}

/* Placeholder waveform peaks — ported from the app's useWaveform.ts so widget
   and app draw the same recognisable shape, seeded by the excerpt id. */
function hash32(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function placeholderPeaks(seed: string, count: number): number[] {
  const rand = mulberry32(hash32(seed) || 1);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const r = rand();
    let h: number;
    if (r < 0.1) h = 4 + rand() * 12;
    else if (r > 0.875) h = 80 + rand() * 18;
    else h = 25 + rand() * 50;
    out.push(Math.round(h));
  }
  return out;
}

export interface Waveform {
  setProgress(fraction: number): void;
  onSeek(cb: (fraction: number) => void): void;
}

// Renders a DOM bar-chart waveform in `container` (a flex row), responsive to
// width (bar pitch 4px, clamped 24..400 bars), with click-to-seek.
export function makeWaveform(container: HTMLElement, seed: string): Waveform {
  let bars: HTMLSpanElement[] = [];
  let seekCb: ((f: number) => void) | null = null;
  let count = 0;
  let fraction = 0;

  function paint(): void {
    const cut = fraction * bars.length;
    for (let i = 0; i < bars.length; i++) bars[i].classList.toggle("played", i < cut);
  }
  function build(): void {
    const w = container.clientWidth || 0;
    const n = Math.max(24, Math.min(400, Math.round(w / 4) || 64));
    if (n === count) return;
    count = n;
    const peaks = placeholderPeaks(seed, n);
    container.textContent = "";
    bars = peaks.map((h) => {
      const b = document.createElement("span");
      b.className = "bar";
      b.style.height = h + "%";
      container.appendChild(b);
      return b;
    });
    paint();
  }

  container.addEventListener("click", (e) => {
    if (!seekCb) return;
    const rect = container.getBoundingClientRect();
    let f = (e.clientX - rect.left) / rect.width;
    f = f < 0 ? 0 : f > 1 ? 1 : f;
    seekCb(f);
  });
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => build()).observe(container);
  build();

  return {
    setProgress(f) { fraction = f < 0 ? 0 : f > 1 ? 1 : f; paint(); },
    onSeek(cb) { seekCb = cb; },
  };
}
