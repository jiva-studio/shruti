"""Stage clean-audio windows + build the share-video render jobs from jobs.json.

For each selected clip: download the track's denoised clean.mp3 (cached),
cut the chosen [abs_start, abs_end] window, stage it as the render source,
and emit a share-video job (header=hook, karaoke transcript, watermark).
"""
import json
import os
import re
import subprocess
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
LAKE = "/home/akd/Projects/jiva-studio/lectorium/resources/lake-out/public/tracks"
CDN = "https://akds-lectorium.b-cdn.net/public/tracks"
FF = os.environ.get("FFMPEG_BIN", "ffmpeg")
BATCH = os.environ["BATCH_DIR"]

CACHE = f"{BATCH}/clean-cache"
SRCROOT = f"{BATCH}/src/public/tracks/demo"
for d in (CACHE, SRCROOT, f"{BATCH}/backgrounds", f"{BATCH}/out"):
    os.makedirs(d, exist_ok=True)
# symlink real prabhupada plates as theme
link = f"{BATCH}/backgrounds/prabhupada"
if not os.path.lexists(link):
    os.symlink("/home/akd/Projects/jiva-studio/lectorium/source/lectorium/modules/tools/share-video-backgrounds/work-720/prabhupada", link)


def clean_track(track):
    p = f"{CACHE}/{track}.mp3"
    if not os.path.exists(p) or os.path.getsize(p) < 10000:
        url = f"{CDN}/{track}/audio/clean.mp3"
        urllib.request.urlretrieve(url, p)
    return p


def clean(t):
    t = re.sub(r"\[[^\]]*\]", "", t)     # drop bracketed refs like [Bg. 8.5]
    t = re.sub(r"[*_`]+", "", t)          # strip markdown emphasis
    t = t.replace("—", "-")
    t = re.sub(r"\s+([,.;:?!])", r"\1", t)
    return re.sub(r"\s+", " ", t).strip()


# Sanskrit verse citations the speaker recites INLINE inside an English
# sentence (so blocks() can't drop them — they're not verse:text blocks).
# In a caption they read as a meaningless shloka fragment and the long
# hyphenated compound also overflows the frame. We remove the exact quoted
# phrases from the CAPTION only; the audio still plays the recitation, it just
# stays uncaptioned (force-align skips ASR words with no caller-text match).
# Single Sanskrit TERMS that are part of the English grammar — "Hare Kṛṣṇa",
# "saṅkīrtana", "the yogīs as Paramātmā", "Vedānta-sūtra", "Keśava" — are NOT
# citations and are deliberately kept. Extend this list when new clips add
# their own recited verses.
CITATIONS = [
    "Bhava-mahā-dāvāgni-nirvāpaṇam",
    "athāto brahma jijñāsā",
    "Ahaṁ brahmāsmi",
    "Sevonmukhe hi jihvādau",
    "Śravaṇaṁ kīrtanam",
    "Kalau",  # dangling recitation lead-in ("...by saṅkīrtana. Kalau...")
]


def strip_citations(t):
    for phrase in CITATIONS:
        # eat the phrase plus any trailing citation punctuation (: . , …)
        t = re.sub(re.escape(phrase) + r"[.:,…]*", " ", t)
    t = re.sub(r"\s+([,.;:?!])", r"\1", t)     # no space before punctuation
    t = re.sub(r'"\s+"', '" "', t)
    t = re.sub(r"\s{2,}", " ", t).strip(" ,;:")
    # removing a citation can leave a lower-case word opening a sentence
    # ("liberated. immediately ...") — restore sentence case.
    t = re.sub(r"([.!?]\s+)([a-z])", lambda m: m.group(1) + m.group(2).upper(), t)
    return t[:1].upper() + t[1:] if t else t


def blocks(track):
    # English SENTENCE blocks only. verse:text blocks are the recited Sanskrit
    # (IAST) — they must NOT go into the caption text, or a shloka fragment
    # hangs as gibberish. The audio still plays the recitation; it just stays
    # uncaptioned (force-align skips ASR words that have no caller-text match).
    d = json.load(open(f"{LAKE}/{track}/transcripts/en.json"))
    out = []
    for b in d["blocks"]:
        if b.get("type") != "sentence":
            continue
        t = b.get("text")
        if isinstance(t, list):
            t = " ".join(t)
        out.append((b.get("start", 0), b.get("end", 0), t))
    return sorted(out)


def snap_window(track, s0, e0, max_ms=35000):
    """Snap the LLM window to whole sentence boundaries (no mid-phrase starts),
    cap at max_ms, and return (abs_start, abs_end, clean_text)."""
    bl = blocks(track)
    chosen = [b for b in bl if b[1] > s0 and b[0] < e0]  # sentences overlapping the window
    if not chosen:
        chosen = [b for b in bl if b[0] <= s0 <= b[1]] or bl[:1]
    ss = chosen[0][0]
    # keep adding whole sentences until we'd exceed max_ms
    kept = []
    for b in chosen:
        if b[1] - ss > max_ms and kept:
            break
        kept.append(b)
    ee = kept[-1][1]
    return ss, ee, clean(" ".join(b[2] for b in kept))


# Lead-in kept before the first word so the clip doesn't slap in at full
# volume. The render no longer trims leading silence, and fades this in.
LEAD_MS = 220


def word_onset(track, ss_ms):
    """Find the first word's true onset near the sentence-start timestamp.

    The sentence-boundary timestamp sometimes lands in continuous speech (or a
    hair late, into the word). We look for a silent gap near ss; the gap's END
    is the real speech onset. If a gap is found we return that onset, else ss.
    """
    src = f"{CACHE}/{track}.mp3"
    reg0 = max(0, ss_ms - 1500) / 1000
    reg_dur = (ss_ms + 600) / 1000 - reg0
    p = subprocess.run(
        [FF, "-hide_banner", "-nostats", "-ss", f"{reg0:.3f}", "-t", f"{reg_dur:.3f}",
         "-i", src, "-af", "silencedetect=n=-35dB:d=0.15", "-f", "null", "-"],
        capture_output=True, text=True)
    ends = [reg0 * 1000 + float(m.group(1)) * 1000
            for m in re.finditer(r"silence_end:\s*([0-9.]+)", p.stderr)]
    # a silence END is a speech ONSET; pick the one closest to ss (+-400ms).
    near = [e for e in ends if ss_ms - 400 <= e <= ss_ms + 400]
    return min(near, key=lambda e: abs(e - ss_ms)) if near else ss_ms


jobs = json.load(open(f"{HERE}/jobs.json"))
sv = []
for j in jobs:
    src = clean_track(j["track_id"])
    ss, ee, text = snap_window(j["track_id"], j["abs_start_ms"], j["abs_end_ms"])
    text = strip_citations(text)               # drop inline recited shlokas
    onset = word_onset(j["track_id"], ss)       # true first-word onset
    cs = int(max(0, onset - LEAD_MS))           # keep a small lead-in before it
    s = cs / 1000
    dur = (ee - cs) / 1000
    snap = f" (onset {onset - ss:+.0f}ms, lead {onset - cs:.0f}ms)"
    out = f"{SRCROOT}/{j['id']}.mp3"
    subprocess.run([FF, "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{s:.3f}",
                    "-i", src, "-t", f"{dur:.3f}", "-c:a", "libmp3lame", "-q:a", "2", out], check=True)
    sv.append({
        "video_id": j["id"], "out_name": j["id"] + ".mp4",
        "source_key": f"public/tracks/demo/{j['id']}.mp3", "theme": "prabhupada",
        "end_ms": ee - cs,
        "header": (j["hook_l1"] + " " + j["hook_l2"]).replace("/", " ").strip(),
        "sub": j["ref"], "shloka_iast": "", "shloka_translation": "",
        "text": text, "words": [], "normalize": True, "trim_silence": True,
    })
    print(f"staged {j['id']} {dur:.1f}s{snap} | {text[:66]}...")

json.dump(sv, open(f"{BATCH}/svjobs.json", "w"), ensure_ascii=False, indent=1)
print(f"\nwrote svjobs.json ({len(sv)} jobs)")
