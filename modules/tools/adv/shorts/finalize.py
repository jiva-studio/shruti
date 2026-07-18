"""Finalize rendered Shorts into resources/ (reusable across platforms):
per clip build a cover (real photo -> Gemini restyle -> hook caption), prepend
it as the first frame, and write upload metadata.

Everything durable lands under resources/shorts/:
  photos/  source portraits (input pool, rotated)
  gemini/  Gemini-restyled brand backgrounds  (<id>.png)  — reusable
  cover/   final cover images                 (<id>.jpg)
  video/   final Shorts (cover as first frame)(<id>.mp4)  — for other platforms
  meta/    upload metadata                    (<id>.json)

Inputs: jobs.json + <BATCH>/out/<id>.mp4 (rendered reels).
Env: OPENROUTER_API_KEY, FFMPEG_BIN, BATCH_DIR, PYBIN
"""
import glob
import json
import os
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
COVER = os.path.join(HERE, "..", "covers", "cover.py")
FF = os.environ.get("FFMPEG_BIN", "ffmpeg")
BATCH = os.environ["BATCH_DIR"]
PYBIN = os.environ.get("PYBIN", "python3")

RES = "/home/akd/Projects/jiva-studio/shruti/resources/shorts"
PHOTOS = sorted(glob.glob(f"{RES}/photos/*.jpg"))

TAGS = ["Bhagavad Gita", "Krishna", "Prabhupada", "bhakti", "vedanta",
        "spirituality", "Hare Krishna", "Shruti"]

jobs = json.load(open(f"{HERE}/jobs.json"))
done = []
for i, j in enumerate(jobs):
    reel = f"{BATCH}/out/{j['id']}.mp4"
    if not os.path.exists(reel):
        print("no reel, skip", j["id"])
        continue
    gemini = f"{RES}/gemini/{j['id']}.png"
    cover = f"{RES}/cover/{j['id']}.jpg"
    photo = PHOTOS[i % len(PHOTOS)]
    # cover.py: restyle the source photo (saved to gemini/) + compose the caption.
    # Reuse an existing cover (covers don't depend on the audio window) to avoid
    # re-spending Gemini on re-renders.
    if not os.path.exists(cover):
        subprocess.run([PYBIN, COVER, photo, cover, j["hook_l1"], j["hook_l2"], j["ref"],
                        "--restyled-out", gemini], check=True)

    final = f"{RES}/video/{j['id']}.mp4"
    if os.environ.get("NO_COVER_INTRO") == "1":
        # A static cover as the FIRST FRAME spikes Shorts swipe-away (viewers
        # see a still image and swipe). The reel already opens on motion with
        # the question overlaid, so the final is just the reel. The cover still
        # serves as the upload THUMBNAIL — it's simply not baked into frame 0.
        subprocess.run([
            FF, "-hide_banner", "-loglevel", "error", "-y", "-i", reel,
            "-c", "copy", "-movflags", "+faststart", final], check=True)
    else:
        subprocess.run([
            FF, "-hide_banner", "-loglevel", "error", "-y",
            "-loop", "1", "-t", "0.6", "-i", cover,
            "-f", "lavfi", "-t", "0.6", "-i", "anullsrc=r=44100:cl=stereo",
            "-i", reel,
            "-filter_complex",
            "[0:v]scale=720:1280,setsar=1,fps=30,format=yuv420p[cv];"
            "[cv][1:a][2:v][2:a]concat=n=2:v=1:a=1[v][a]",
            "-map", "[v]", "-map", "[a]",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-ar", "44100", "-movflags", "+faststart", final], check=True)

    desc = (f"{j['hook_l1']} {j['hook_l2']}\n\n"
            f"Full lecture: {j['deep_link']}\n"
            "Shruti — recorded Vedic lectures and scripture.\n\n"
            "#BhagavadGita #Krishna #Prabhupada #bhakti #vedanta #spirituality #shorts")
    json.dump({"title": j["title"], "description": desc, "tags": TAGS,
               "categoryId": "22", "privacy": "unlisted"},
              open(f"{RES}/meta/{j['id']}.json", "w"), ensure_ascii=False, indent=1)
    done.append(j["id"])
    print("finalized", j["id"])

print(f"\ndone {len(done)}/{len(jobs)} -> {RES}")
