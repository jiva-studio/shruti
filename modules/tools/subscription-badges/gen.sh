#!/usr/bin/env bash
#
# gen.sh — generate ONE subscription feature badge via OpenRouter.
#
# WHY THIS EXISTS
#   The subscription / paywall screen (FeatureCarousel) shows one illustrated
#   badge per premium feature. These badges are AI-generated kawaii cartoon
#   illustrations in the app's "smiling sadhu" mascot style. This script is the
#   single-badge generator — give it a slug and a prompt and it calls an
#   image model, then saves the PNG + the raw API response next to itself.
#
# WHERE THE OUTPUT GOES
#   <slug>.png           — the generated image (raw, with background)
#   <slug>.response.json — the full API response (kept for debugging)
#   Both land in THIS directory. The PNG almost always needs its background
#   stripped before use — pipe it through floodfill_bg.py or chroma_key.py
#   (see README.md), then copy the resulting transparent PNG into the app at:
#       modules/apps/mobile/public/subscription/<slug>.png
#   The app references it as "/subscription/<slug>.png" — see
#       modules/apps/mobile/ui/features/subscription/featureKeys.ts
#   Canonical slugs the app expects:
#       newLectures  sakha  bookmarks  smartLibrary  autoScroll  notesStudio
#
# REQUIREMENTS
#   - OPENROUTER_API_KEY in the environment
#   - curl, jq, base64
#
# USAGE
#   ./gen.sh <slug> "<prompt>" [model]
#   # model defaults to google/gemini-2.5-flash-image; gen_all.sh uses
#   # openai/gpt-5-image for the production badges.
#
# EXAMPLE
#   export OPENROUTER_API_KEY=sk-or-...
#   ./gen.sh bookmarks "Flat cartoon kawaii closed book with a ribbon bookmark..."
#
set -euo pipefail

SLUG="${1:?need slug}"
PROMPT="${2:?need prompt}"
MODEL="${3:-google/gemini-2.5-flash-image}"
OUT_DIR="$(dirname "$0")"

: "${OPENROUTER_API_KEY:?OPENROUTER_API_KEY not set}"

JSON_PATH="$OUT_DIR/$SLUG.response.json"
PNG_PATH="$OUT_DIR/$SLUG.png"

curl -sS -X POST https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg p "$PROMPT" --arg m "$MODEL" '{
    model: $m,
    modalities: ["image", "text"],
    messages: [{ role: "user", content: [{ type: "text", text: $p }] }]
  }')" > "$JSON_PATH"

# Image models return base64 in choices[0].message.images[0].image_url.url
# as a data URI. Strip the "data:image/...;base64," prefix to get raw bytes.
# Fall back gracefully if the response shape differs (e.g. a refusal).
B64="$(jq -r '
  (.choices[0].message.images[0].image_url.url // empty) as $u
  | if $u != "" then ($u | sub("^data:image/[^;]+;base64,"; "")) else empty end
' "$JSON_PATH")"

if [ -z "$B64" ]; then
  echo "no image bytes found — full response in $JSON_PATH" >&2
  jq '.' "$JSON_PATH" | head -60 >&2
  exit 1
fi

echo "$B64" | base64 -d > "$PNG_PATH"
echo "wrote $PNG_PATH ($(wc -c < "$PNG_PATH") bytes)"
