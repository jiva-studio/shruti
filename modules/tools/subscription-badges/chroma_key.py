#!/usr/bin/env python3
"""
chroma_key.py — drop a magenta chroma-key background to transparency.

WHY THIS EXISTS
    An alternative background remover for when floodfill_bg.py struggles —
    e.g. the subject itself contains large light areas that the floodfill would
    eat, or the model painted a noisy background. The trick: prompt the model
    for a solid MAGENTA background instead of white, then key it out here.
    Magenta (high red, low green, high blue) almost never appears in the warm
    saffron/cream mascot palette, so it keys cleanly regardless of connectivity.

HOW IT WORKS
    Scans every pixel and clears any that is magenta-ish (R>180, B>180, G<80) to
    alpha=0 — a global color test, not a connected floodfill, so enclosed
    background regions are removed too. Use floodfill_bg.py as the default;
    reach for this only when you deliberately generated a magenta background.

WHERE THE OUTPUT GOES
    Writes <stem>.cut.png next to the input — the transparent badge. Copy it
    into the app, renamed to the bare slug:
        cp sakha.final.cut.png \
           ../../apps/mobile/public/subscription/sakha.png
    (slugs the app expects: newLectures sakha bookmarks smartLibrary
     autoScroll notesStudio — see ../../apps/mobile/ui/features/subscription/
     featureKeys.ts)

REQUIREMENTS
    pip install -r requirements.txt   # Pillow

USAGE
    python3 chroma_key.py <input.png>
"""
import sys
from PIL import Image


def main():
    src = sys.argv[1]
    out = src.rsplit(".", 1)[0] + ".cut.png"
    im = Image.open(src).convert("RGBA")
    px = im.load()
    w, h = im.size
    transparent = 0
    for y in range(h):
        for x in range(w):
            r, g, b, _ = px[x, y]
            # magenta: high R, low G, high B
            if r > 180 and b > 180 and g < 80:
                px[x, y] = (0, 0, 0, 0)
                transparent += 1
    im.save(out)
    print(f"wrote {out}: {100*transparent/(w*h):.1f}% transparent pixels")


if __name__ == "__main__":
    main()
