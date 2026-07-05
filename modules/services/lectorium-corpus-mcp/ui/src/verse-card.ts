import { boot, el, showErr } from "./common";

/* Verse card: renders the shloka the tool already assembled — original script,
   transliteration (already in the requested language's script, derived at
   import), word-by-word ("Synonyms"), and the translation. Pure display; no
   transliteration or business logic here. Adopts the host theme/fonts via boot(). */

interface Syn { word: string; meaning: string }

function lines(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function fillLines(id: string, arr: string[]): void {
  const host = el(id);
  host.textContent = "";
  for (const line of arr) {
    const span = document.createElement("span");
    span.className = "line";
    span.textContent = line;
    host.appendChild(span);
  }
  host.style.display = arr.length ? "" : "none";
}

function render(d: Record<string, unknown>): void {
  const source = (d.source as { name?: string } | undefined)?.name ?? "";
  const tokens = typeof d.tokens === "string" ? d.tokens : "";

  const refEl = el("ref");
  refEl.textContent = "";
  if (source) refEl.append(source + " ");
  if (tokens) {
    const n = document.createElement("span");
    n.className = "num";
    n.textContent = tokens;
    refEl.appendChild(n);
  }
  refEl.style.display = source || tokens ? "" : "none";

  fillLines("original", lines(d.original));
  fillLines("translit", lines(d.transliteration));

  const syn = Array.isArray(d.synonyms) ? (d.synonyms as Syn[]) : [];
  const synEl = el("synonyms");
  synEl.textContent = "";
  for (const s of syn) {
    if (!s || typeof s.word !== "string") continue;
    const pair = document.createElement("span");
    pair.className = "pair";
    const w = document.createElement("span"); w.className = "w"; w.textContent = s.word;
    const dash = document.createElement("span"); dash.className = "dash"; dash.textContent = "—";
    const g = document.createElement("span"); g.className = "g"; g.textContent = s.meaning ?? "";
    pair.append(w, dash, g);
    synEl.appendChild(pair);
  }
  el("synonyms-block").style.display = syn.length ? "" : "none";

  const tr = typeof d.translation === "string" ? d.translation : "";
  const trEl = el("translation");
  trEl.textContent = tr;
  trEl.style.display = tr ? "" : "none";
}

try {
  boot("corpus-verse-card", render);
} catch (e) {
  showErr("boot: " + String(e));
}
