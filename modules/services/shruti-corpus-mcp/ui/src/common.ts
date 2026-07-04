import { App } from "@modelcontextprotocol/ext-apps";
import "./style.css";

export function boot(name: string, render: (data: Record<string, unknown>) => void): App {
  const app = new App({ name, version: "1.0.0" });
  app.ontoolresult = (result) => {
    try {
      render((result?.structuredContent as Record<string, unknown>) ?? {});
    } catch (e) {
      showErr("render: " + String(e));
    }
  };
  app.connect().catch((e) => showErr("connect: " + String(e)));
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
  const m = Math.floor(s / 60);
  return m + ":" + String(s % 60).padStart(2, "0");
}

// playMedia points a media element at a GET-able URL, retrying on error since
// the clip may still be encoding server-side (~4s).
export function playMedia(elm: HTMLMediaElement, url: string, tries = 8): void {
  let n = 0;
  let done = false;
  const attempt = () => {
    elm.src = url;
    elm.load();
  };
  elm.addEventListener("canplay", () => { done = true; });
  elm.addEventListener("error", () => {
    if (done) return;
    n++;
    if (n < tries) {
      setTimeout(attempt, 1500);
    } else {
      showErr("media not ready after " + tries + " tries: " + url);
    }
  });
  attempt();
}
