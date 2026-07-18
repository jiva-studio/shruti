"""Select N Daily Wisdom excerpts and, per clip, use an LLM to pick the best
<=35s window and write a provocative English question hook. Writes jobs.json.

Env: OPENROUTER_API_KEY
"""
import json
import os
import re
import sys
import urllib.request

DW = "/home/akd/Projects/jiva-studio/shruti/resources/daily-wisdom"
LAKE = "/home/akd/Projects/jiva-studio/shruti/resources/lake-out/public/tracks"
KEY = os.environ["OPENROUTER_API_KEY"]
MODEL = os.environ.get("LLM_MODEL", "google/gemini-2.5-flash")
N = int(os.environ.get("N", "20"))
MAX_MS = 35000


def llm(messages):
    body = {"model": MODEL, "messages": messages, "temperature": 0.8,
            "response_format": {"type": "json_object"}}
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    r = json.load(urllib.request.urlopen(req, timeout=90))
    return json.loads(r["choices"][0]["message"]["content"])


def excerpt_sentences(track, s0, e0):
    d = json.load(open(f"{LAKE}/{track}/transcripts/en.json"))
    out = []
    for b in d["blocks"]:
        if b.get("type") not in ("sentence", "verse:text"):
            continue
        bs, be = b.get("start"), b.get("end")
        if be < s0 or bs > e0:
            continue
        t = b.get("text")
        if isinstance(t, list):
            t = " ".join(t)
        out.append({"t_ms": max(0, bs - s0), "text": t})
    return out


def verse_ref(block):
    ref = block.get("reference") or {}
    src = {"source_dsicuBsFvinZ": "Bhagavad-gita"}.get(ref.get("sourceId"), "Srimad-Bhagavatam")
    toks = ".".join(ref.get("tokens", []))
    return f"{src} {toks}" if toks else "Bhagavad-gita"


def pick_candidates():
    recs = [json.loads(l) for l in open(f"{DW}/vk-upload/manifest.jsonl")
            if json.loads(l).get("language") == "en"]
    per_topic, out = {}, []
    for r in recs:
        tf = f"{LAKE}/{r['track_id']}/transcripts/en.json"
        if not os.path.exists(tf):
            continue
        d = json.load(open(tf))
        vb = [b for b in d["blocks"] if b.get("type") == "verse:text"
              and b.get("end", 0) >= r["start_ms"] and b.get("start", 0) <= r["end_ms"]]
        if not vb:
            continue
        topic = r["title"]
        if per_topic.get(topic, 0) >= 2:   # diversity: max 2 per topic
            continue
        per_topic[topic] = per_topic.get(topic, 0) + 1
        out.append((r, vb[0]))
        if len(out) >= N:
            break
    return out


SYS = ("You write hooks for short vertical videos of Srila Prabhupada's lectures. "
       "The hook is a PROVOKING English question that creates a curiosity gap and challenges "
       "assumptions, while staying respectful to the Vedic tradition (no clickbait lies, no disrespect). "
       "You also choose the single strongest contiguous <=35s window of the excerpt that opens with a "
       "hook and delivers a payoff (speech should start immediately, skip any ramble).")


def main():
    cands = pick_candidates()
    jobs = []
    for i, (r, vb) in enumerate(cands):
        sents = excerpt_sentences(r["track_id"], r["start_ms"], r["end_ms"])
        ref = verse_ref(vb)
        dur = r["end_ms"] - r["start_ms"]
        user = {
            "topic": r["title"], "verse": ref, "excerpt_ms": dur,
            "transcript": sents,
            "instructions": (
                f"Pick start_ms and end_ms (0..{dur}, end-start<= {MAX_MS}) for the punchiest window. "
                "Write a provoking question hook as two short lines (each <= 22 chars) and a full "
                "YouTube title question. Return JSON: "
                '{"start_ms":int,"end_ms":int,"hook_l1":str,"hook_l2":str,"title":str}')}
        try:
            g = llm([{"role": "system", "content": SYS},
                     {"role": "user", "content": json.dumps(user)}])
        except Exception as e:
            print("skip", r["id"], e, file=sys.stderr)
            continue
        s = max(0, int(g["start_ms"]))
        e = min(dur, int(g["end_ms"]))
        if e - s > MAX_MS:
            e = s + MAX_MS
        tail = r["track_id"].replace("track_", "")
        jobs.append({
            "id": r["id"], "track_id": r["track_id"], "topic": r["title"], "ref": ref,
            "abs_start_ms": r["start_ms"] + s, "abs_end_ms": r["start_ms"] + e,
            "dur_s": round((e - s) / 1000, 1),
            "hook_l1": g["hook_l1"].strip(), "hook_l2": g["hook_l2"].strip(),
            "title": g["title"].strip(),
            "deep_link": f"https://shruti.app/en/app/{tail}",
        })
        print(f"{len(jobs):2}. [{jobs[-1]['dur_s']:>4}s] {jobs[-1]['hook_l1']} / {jobs[-1]['hook_l2']}"
              f"   ({r['title']} · {ref})")

    json.dump(jobs, open(f"{os.path.dirname(__file__)}/jobs.json", "w"), ensure_ascii=False, indent=1)
    print(f"\nwrote jobs.json ({len(jobs)} clips)")


if __name__ == "__main__":
    main()
