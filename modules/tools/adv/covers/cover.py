"""One-shot Shorts cover: any Prabhupada photo -> brand cover.

    cover.py PHOTO OUT "Line one" "Line two" "Bhagavad-gita X.Y" [--no-gemini]

Steps:
  1. (unless --no-gemini) restyle PHOTO through OpenRouter's Gemini image
     model into the brand look — isolates the subject on a warm
     saffron->espresso gradient, keeps his exact face. Needs OPENROUTER_API_KEY.
  2. compose the 9:16 cover with Pillow: the image + the question caption in
     Manrope ExtraBold, anchored on a FIXED vertical center with line advance
     from font metrics, so the caption sits at the same height on every cover.

Everything (prompt, palette, font, layout) is baked in so the batch just
passes a photo + the question lines.
"""
import argparse
import base64
import json
import os
import sys
import tempfile
import urllib.request

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
FONT = os.path.join(HERE, "fonts", "Manrope-var.ttf")

W, H = 1080, 1920

# Brand — "Saffron & Coffee" (from the web tokens).
CREAM = (250, 245, 234)
SAFFRON = (233, 160, 90)   # lifted for contrast on the dark gradient
STROKE = (26, 15, 7)
DARK = (28, 17, 9)

# Caption layout — the finalized, consistent grid.
TEXT_CENTER = 1650
GRAD_START = 1180
GRAD_STRENGTH = 225
LINES_SPEC = [
    dict(wght=800, size=76, color=CREAM, stroke=7, gap=-22),   # question, part 1
    dict(wght=800, size=122, color=SAFFRON, stroke=8, gap=12),  # question, part 2 (accent)
    dict(wght=700, size=48, color=CREAM, stroke=4, gap=0),      # verse reference
]

GEMINI_MODEL = os.environ.get("IMG_MODEL", "google/gemini-2.5-flash-image")
BRAND_PROMPT = """Cinematic vertical 9:16 portrait for a video cover.

Use the reference photo of the elderly Indian spiritual teacher (Srila Prabhupada) — KEEP HIS EXACT FACE, IDENTITY AND EXPRESSION. Do not alter his face.

Make him the sole subject: softly de-emphasize / blur away any other people and busy background, replacing it with a warm glowing gradient — burnt saffron #cc7a3d into deep espresso/coffee #6f4e37, a soft cream #faf5ea halo behind his head, gentle incense smoke and bokeh. Restore and enhance the vintage 1970s film: sharper, richer, cinematic warm key light.

Keep the BOTTOM third darker and clean for a caption. Photorealistic, high contrast. No text, no words, no letters anywhere."""


def gemini_restyle(photo, out):
    key = os.environ["OPENROUTER_API_KEY"]
    b = base64.b64encode(open(photo, "rb").read()).decode()
    ext = "png" if photo.lower().endswith("png") else "jpeg"
    body = {
        "model": GEMINI_MODEL,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": BRAND_PROMPT},
            {"type": "image_url", "image_url": {"url": f"data:image/{ext};base64,{b}"}},
        ]}],
        "modalities": ["image", "text"],
    }
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    resp = json.load(urllib.request.urlopen(req, timeout=120))
    msg = resp["choices"][0]["message"]
    imgs = msg.get("images") or []
    if not imgs and isinstance(msg.get("content"), list):
        imgs = [p for p in msg["content"] if p.get("type") == "image_url"]
    if not imgs:
        raise SystemExit("gemini returned no image: " + str(msg.get("content"))[:300])
    data = imgs[0]["image_url"]["url"].split(",", 1)[1]
    open(out, "wb").write(base64.b64decode(data))


def compose(image, out, lines):
    base = Image.open(image).convert("RGB")
    scale = max(W / base.width, H / base.height)
    img = base.resize((int(base.width * scale), int(base.height * scale)))
    x = (img.width - W) // 2
    y = (img.height - H) // 2
    img = img.crop((x, y, x + W, y + H))

    # Bottom gradient for caption contrast.
    mask = Image.new("L", (W, H), 0)
    mpix = mask.load()
    for j in range(H):
        t = 0.0 if j < GRAD_START else (j - GRAD_START) / (H - GRAD_START)
        v = int(GRAD_STRENGTH * (t ** 1.15))
        for i in range(W):
            mpix[i, j] = v
    img = Image.composite(Image.new("RGB", (W, H), DARK), img, mask)

    draw = ImageDraw.Draw(img)
    prepared, total = [], 0.0
    for idx, (text, spec) in enumerate(zip(lines, LINES_SPEC)):
        # ONE fixed size per line across every cover — line 1 always SIZE[0],
        # line 2 always SIZE[1]. No per-cover auto-shrink: shrinking made the
        # visual size (and perceived baseline) jump between covers. Headlines
        # are written to fit; a line that still overflows is a copy bug, so we
        # shout instead of silently rescaling.
        f = ImageFont.truetype(FONT, spec["size"])
        f.set_variation_by_axes([spec["wght"]])
        asc, desc = f.getmetrics()
        lh = asc + desc
        avail = W * 0.88 - 2 * spec["stroke"]
        if f.getlength(text) > avail:
            print(f"WARN overflow line {idx} ({f.getlength(text):.0f}>{avail:.0f}px): {text!r}",
                  file=sys.stderr)
        prepared.append((text, f, spec, lh))
        total += lh + (spec["gap"] if idx < len(lines) - 1 else 0)

    cy = TEXT_CENTER - total / 2
    for text, f, spec, lh in prepared:
        draw.text((W / 2, cy), text, font=f, fill=spec["color"], anchor="ma",
                  stroke_width=spec["stroke"], stroke_fill=STROKE)
        cy += lh + spec["gap"]

    img.save(out, quality=93)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("photo")
    ap.add_argument("out")
    ap.add_argument("line1")
    ap.add_argument("line2")
    ap.add_argument("ref")
    ap.add_argument("--no-gemini", action="store_true",
                    help="skip the Gemini restyle; compose on PHOTO as-is")
    ap.add_argument("--restyled-out", default=None,
                    help="save the Gemini-restyled background here (reusable) instead of a temp file")
    a = ap.parse_args()

    image = a.photo
    if not a.no_gemini:
        out = a.restyled_out or tempfile.mktemp(suffix=".png")
        gemini_restyle(a.photo, out)
        image = out
        print("restyled ->", out, file=sys.stderr)

    compose(image, a.out, [a.line1, a.line2, a.ref])
    print("saved", a.out)


if __name__ == "__main__":
    main()
