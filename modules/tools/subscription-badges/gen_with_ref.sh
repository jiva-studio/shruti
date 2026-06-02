#!/usr/bin/env bash
#
# gen_with_ref.sh — generate a badge while feeding the model REFERENCE images.
#
# WHY THIS EXISTS
#   Plain text prompts (gen.sh / gen_all.sh) drift in style from badge to badge.
#   When you need a new badge to match an EXISTING one exactly — same outline
#   weight, palette, mascot feel — attach already-approved badge(s) as visual
#   references. The model then conditions on the picture, not just words, so the
#   new badge lands in the same style. Use it to add a badge to the set later or
#   to redo one that came out off-style.
#
# WHERE THE OUTPUT GOES
#   <slug>.png + <slug>.response.json in THIS directory (raw, WITH background).
#   Strip the background (floodfill_bg.py / chroma_key.py) then copy the
#   transparent PNG, renamed to the bare slug, into the app:
#       modules/apps/mobile/public/subscription/<slug>.png
#   (referenced as "/subscription/<slug>.png" — see ../../apps/mobile/
#   ui/features/subscription/featureKeys.ts)
#
# REQUIREMENTS
#   - OPENROUTER_API_KEY in the environment
#   - curl, jq, base64
#
# USAGE
#   ./gen_with_ref.sh <slug> "<prompt>" <ref_image.png> [more_refs.png...]
#
# EXAMPLE  (match the approved sakha badge style for a new one)
#   ./gen_with_ref.sh newBadge "Flat cartoon kawaii ... <subject>" \
#       ../../apps/mobile/public/subscription/sakha.png
#
set -euo pipefail

SLUG="${1:?need slug}"
PROMPT="${2:?need prompt}"
shift 2
OUT_DIR="$(dirname "$0")"

: "${OPENROUTER_API_KEY:?OPENROUTER_API_KEY not set}"

# Build the message content array: the text prompt first, then each reference
# image inlined as a base64 data URI (the model reads them as visual context).
CONTENT=$(jq -n --arg p "$PROMPT" '[{ type: "text", text: $p }]')
for ref in "$@"; do
  B64=$(base64 -w0 < "$ref")
  CONTENT=$(jq --arg uri "data:image/png;base64,$B64" '. + [{ type: "image_url", image_url: { url: $uri } }]' <<< "$CONTENT")
done

JSON_PATH="$OUT_DIR/$SLUG.response.json"
PNG_PATH="$OUT_DIR/$SLUG.png"

jq -n --argjson c "$CONTENT" '{
  model: "openai/gpt-5-image",
  modalities: ["image", "text"],
  messages: [{ role: "user", content: $c }]
}' | curl -sS -X POST https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @- > "$JSON_PATH"

B64=$(jq -r '
  (.choices[0].message.images[0].image_url.url // empty) as $u
  | if $u != "" then ($u | sub("^data:image/[^;]+;base64,"; "")) else empty end
' "$JSON_PATH")

if [ -z "$B64" ]; then
  echo "no image bytes — full response in $JSON_PATH" >&2
  jq '.' "$JSON_PATH" | head -50 >&2
  exit 1
fi

echo "$B64" | base64 -d > "$PNG_PATH"
echo "wrote $PNG_PATH ($(wc -c < "$PNG_PATH") bytes)"
