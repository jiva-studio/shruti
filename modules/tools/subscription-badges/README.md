# subscription-badges

Generate the illustrated feature badges shown on the app's subscription /
paywall screen. Each premium feature gets one kawaii cartoon badge in the
app's "smiling sadhu" mascot style; this tool generates them via an image model
(through OpenRouter), strips the background to transparency, and tells you
exactly where to drop the result so the app picks it up.

## The badges

Six badges, one per feature. Slugs are fixed — the app references each as
`/subscription/<slug>.png`:

| Slug | Feature |
|---|---|
| `newLectures` | New lectures |
| `sakha` | Sakha AI assistant (key `chat` in code) |
| `bookmarks` | Bookmarks |
| `smartLibrary` | Smart Library |
| `autoScroll` | Auto-scroll transcript |
| `notesStudio` | Notes-to-video studio |

## Where the badges end up in the app

The finished, transparent PNGs live in the mobile app's public assets:

```
modules/apps/mobile/public/subscription/<slug>.png   (512×512, RGBA)
```

They are wired up in
`modules/apps/mobile/ui/features/subscription/featureKeys.ts`
(the `FEATURE_SLIDES` array, `icon: "/subscription/<slug>.png"`) and rendered by
`ui/features/subscription/FeatureSlide.vue` inside `FeatureCarousel.vue`. The
`public/` path means Vite serves them at the site root, so the reference is the
literal `/subscription/<slug>.png` — no import, just drop the file in that
folder with the right name.

**To update a badge you only need to overwrite that one file.** This tool just
helps you produce a good transparent PNG to put there.

## Prerequisites

- `OPENROUTER_API_KEY` in the environment (an OpenRouter key with image-model access)
- `curl`, `jq`, `base64` on `PATH`
- Python 3.10+ with Pillow:

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

## End-to-end: regenerate the whole set

```bash
export OPENROUTER_API_KEY=sk-or-...

# 1. Generate all six (raw, WITH background) → <slug>.final.png here
./gen_all.sh

# 2. Strip the background on each → <name>.cut.png (transparent)
for f in *.final.png; do python3 floodfill_bg.py "$f"; done

# 3. Eyeball every .cut.png. Re-run a bad one with a tweaked prompt
#    (see gen_all.sh) or with a reference image (see gen_with_ref.sh).

# 4. Copy the good ones into the app, renamed to the bare slug
cp bookmarks.final.cut.png   ../../apps/mobile/public/subscription/bookmarks.png
cp smartLibrary.final.cut.png ../../apps/mobile/public/subscription/smartLibrary.png
cp autoScroll.final.cut.png  ../../apps/mobile/public/subscription/autoScroll.png
cp notesStudio.final.cut.png ../../apps/mobile/public/subscription/notesStudio.png
cp sakha.final.cut.png       ../../apps/mobile/public/subscription/sakha.png
# newLectures is not in gen_all.sh — generate it with gen.sh / gen_with_ref.sh
```

## Regenerate a single badge

```bash
# Plain text prompt (style may drift):
./gen.sh sakha "Flat cartoon kawaii ... <subject> $STYLE"

# Style-locked to an existing approved badge (recommended for one-offs):
./gen_with_ref.sh sakha "Flat cartoon kawaii ... <subject>" \
    ../../apps/mobile/public/subscription/bookmarks.png

python3 floodfill_bg.py sakha.png
cp sakha.cut.png ../../apps/mobile/public/subscription/sakha.png
```

## Scripts

| Script | What it does |
|---|---|
| `gen.sh` | Generate ONE badge from a text prompt. `./gen.sh <slug> "<prompt>" [model]` |
| `gen_all.sh` | Production recipe: regenerate the full set in parallel. Holds the per-badge prompts + the shared `STYLE` string. `openai/gpt-5-image`. |
| `gen_with_ref.sh` | Generate one badge while feeding the model reference image(s) so the style matches exactly. `./gen_with_ref.sh <slug> "<prompt>" <ref.png>...` |
| `floodfill_bg.py` | **Default** background remover — floodfills near-white/off-white/checker background from the corners to alpha=0. Writes `<stem>.cut.png`. Tune `TOL` if it eats too much / too little. |
| `chroma_key.py` | Alternative remover — keys out a magenta background globally. Use only when you deliberately prompted a magenta background and floodfill struggles. |

Each script has a header comment explaining why it exists, how to run it, and
where its output goes.

## Notes

- Image models routinely ignore "transparent background" — that's why a
  background-stripping step (`floodfill_bg.py` / `chroma_key.py`) is mandatory.
- Output is square; the app box-constrains it (`clamp(120px, 36vw, 200px)` in
  `FeatureSlide.vue`), so exact pixel size isn't critical, but keep them square
  and reasonably high-res (the shipped set is 512×512).
- `gen_all.sh` does NOT include `newLectures` (it was finalized separately);
  add a `gen` line for it there if you want it in the batch.
