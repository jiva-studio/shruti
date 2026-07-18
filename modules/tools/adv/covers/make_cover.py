"""Compose a 9:16 Shorts cover with Pillow (proper text rendering).
Usage: make_cover.py config.json
"""
import json
import sys

from PIL import Image, ImageDraw, ImageFont

cfg = json.load(open(sys.argv[1]))
W, H = 1080, 1920

base = Image.open(cfg["image"]).convert("RGB")
scale = max(W / base.width, H / base.height)
img = base.resize((int(base.width * scale), int(base.height * scale)))
x = (img.width - W) // 2
y = (img.height - H) // 2
img = img.crop((x, y, x + W, y + H))

# Bottom gradient: transparent at ~y=start, fading to dark espresso at the bottom.
start = cfg.get("grad_start", 1080)
strength = cfg.get("grad_strength", 210)
mask = Image.new("L", (W, H), 0)
mpix = mask.load()
for j in range(H):
    t = 0.0 if j < start else (j - start) / (H - start)
    v = int(strength * (t ** 1.15))
    for i in range(W):
        mpix[i, j] = v
dark = Image.new("RGB", (W, H), tuple(cfg.get("dark", [28, 17, 9])))
img = Image.composite(dark, img, mask)

draw = ImageDraw.Draw(img)


def load_font(path, size, axes=None):
    f = ImageFont.truetype(path, size)
    if axes:
        f.set_variation_by_axes(list(axes))  # full axis list, in fvar order
    return f


# Pre-measure the whole caption block so it can be anchored on a FIXED
# center Y (cfg["text_center"]) — keeps the text at the same height across
# every cover, so a sequence of Shorts doesn't jump. Falls back to a
# top anchor (cfg["text_top"]) when text_center isn't given.
prepared = []
total_h = 0.0
n = len(cfg["lines"])
for idx, ln in enumerate(cfg["lines"]):
    axes = ln.get("axes")
    if axes is None and ln.get("wght") is not None:
        axes = [ln["wght"]]
    f = load_font(ln["font"], ln["size"], axes)
    sw = ln.get("stroke", 6)
    # Line advance from FONT METRICS (ascent+descent) — constant for a
    # given font+size, independent of the actual text. Using the measured
    # text bbox instead makes lines with descenders (e.g. the 'p' in
    # "promise") taller and pushes the next line down inconsistently.
    asc, desc = f.getmetrics()
    lh = asc + desc
    gap = ln.get("gap", 12)
    prepared.append((ln, f, sw, lh, gap))
    total_h += lh + (gap if idx < n - 1 else 0)

if "text_center" in cfg:
    cy = cfg["text_center"] - total_h / 2
else:
    cy = cfg["text_top"]

for ln, f, sw, lh, gap in prepared:
    # anchor "ma" = horizontal-middle, vertical-ascender → the ascender top
    # sits at cy; advancing by lh keeps every line on a fixed grid.
    draw.text((W / 2, cy), ln["text"], font=f, fill=tuple(ln["color"]),
              anchor="ma", stroke_width=sw, stroke_fill=tuple(cfg.get("stroke_fill", [26, 15, 7])))
    cy += lh + gap

img.save(cfg["out"], quality=93)
print("saved", cfg["out"])
