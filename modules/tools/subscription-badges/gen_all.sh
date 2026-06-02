#!/usr/bin/env bash
#
# gen_all.sh — regenerate the FULL set of subscription feature badges at once.
#
# WHY THIS EXISTS
#   This is the production recipe. It holds the exact prompts and the shared
#   STYLE string that produce the six paywall badges in the app's "smiling
#   sadhu" mascot style. Run it to regenerate the whole set after a style
#   tweak, or copy one gen line out to redo a single badge. It fans the six
#   requests out in parallel through gen.sh using openai/gpt-5-image.
#
# WHERE THE OUTPUT GOES
#   For each feature it writes <slug>.final.png + <slug>.final.response.json
#   in THIS directory (raw, WITH background). Each PNG still needs its
#   background stripped before it can ship — run it through floodfill_bg.py
#   (near-white bg) or chroma_key.py (magenta bg), which writes <name>.cut.png.
#   Then copy the transparent result into the app, renamed to the bare slug:
#       cp autoScroll.final.cut.png \
#          ../../apps/mobile/public/subscription/autoScroll.png
#   The six slugs the app expects (see ../../apps/mobile/ui/features/
#   subscription/featureKeys.ts):
#       newLectures  sakha  bookmarks  smartLibrary  autoScroll  notesStudio
#   NOTE: newLectures is not regenerated here (it was finalized separately);
#   add a gen line for it if you need to redo it.
#
# REQUIREMENTS
#   - OPENROUTER_API_KEY in the environment
#   - curl, jq, base64 (used via gen.sh)
#
# USAGE
#   export OPENROUTER_API_KEY=sk-or-...
#   ./gen_all.sh
#
set -euo pipefail
cd "$(dirname "$0")"

: "${OPENROUTER_API_KEY:?OPENROUTER_API_KEY not set}"

MODEL="openai/gpt-5-image"

# Shared style contract appended to every per-badge subject prompt. This is the
# single most important knob — it pins the mascot look and forces a transparent
# background. Edit here to restyle the whole set consistently.
STYLE='Style match (very important): bold uniform dark chocolate-brown ink outlines of consistent thickness, flat-shaded fills, vibrant saffron-orange color, warm peach tones, cream highlights, small soft pink cheek-blush dots, joyful friendly mood, chubby chibi proportions — exactly the same hand-drawn cartoon style as a kawaii mascot of a smiling bald Indian sadhu monk wearing headphones and saffron robes with a white Vaishnava tilaka. No text, no letters, no white frame, no badge border, no rounded background rectangle, no white background. The illustration must sit on a fully transparent background: every pixel outside the drawn subject must be alpha=0. Centered subject, square PNG.'

# Helper: build the per-badge prompt as "<subject> <STYLE>" and dispatch via gen.sh.
gen() {
  local slug="$1"
  local subject="$2"
  ./gen.sh "$slug.final" "$subject $STYLE" "$MODEL"
}

gen bookmarks   'Flat cartoon kawaii illustration. Subject: a cute friendly closed book with a long curling colorful ribbon bookmark sticking out between its pages, a tiny smiling face on the book cover, a small heart symbol floating beside it, and a few small sparkle stars around it.' &

gen smartLibrary 'Flat cartoon kawaii illustration. Subject: a small cozy bookshelf with three colorful books neatly arranged inside, a sparkly glowing download-arrow descending into the top of the shelf, and one finished old book gently floating away to the side. A few small sparkles around the shelf.' &

gen autoScroll  'Flat cartoon kawaii illustration. Subject: a friendly cute paper scroll partly unrolled, with a single glowing highlighted line of abstract text (NOT real letters — just colored horizontal lines suggesting text), a small audio waveform indicator beside it, and a soft downward motion arrow showing scrolling. A few sparkles around.' &

gen notesStudio 'Flat cartoon kawaii illustration. Subject: a cute movie clapperboard with a tiny smiling face, a small paper note with a pencil floating beside it, a glowing play-button triangle in front, a few sparkle stars around. Suggests turning notes into videos.' &

gen sakha       'Flat cartoon kawaii illustration. Subject: a friendly glowing chat speech bubble with a sparkling magic star inside it, a tiny open book and a small magnifying glass floating beside the bubble, a few small sparkle stars around. Suggests an AI helper that searches and answers.' &

wait
echo "---DONE"
ls -lh *.final.png 2>/dev/null
