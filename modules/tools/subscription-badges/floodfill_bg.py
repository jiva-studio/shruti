#!/usr/bin/env python3
"""
floodfill_bg.py — strip a near-white / off-white background to transparency.

WHY THIS EXISTS
    Image models ignore "transparent background" instructions and paint a solid
    near-white (or cream/grey, or a fake checker pattern) behind the subject.
    The app needs the badges as transparent PNGs (FeatureSlide.vue renders them
    with a drop-shadow over the paywall background), so the background has to be
    removed before shipping. This is the DEFAULT background remover — reach for
    chroma_key.py only when you deliberately prompted a magenta background.

HOW IT WORKS
    Floodfills inward from each of the four corners, using each corner's own
    color as that fill's reference. This handles checker-pattern fake
    transparency (alternating grey/white squares) and only clears background
    pixels connected to an edge — colors INSIDE the subject that happen to be
    light are preserved. TOL is generous because the model's "white" drifts a
    few units per pixel.

WHERE THE OUTPUT GOES
    Writes <stem>.cut.png next to the input. That .cut.png is the transparent
    badge — copy it into the app, renamed to the bare slug:
        cp bookmarks.final.cut.png \
           ../../apps/mobile/public/subscription/bookmarks.png
    (the app expects slugs: newLectures sakha bookmarks smartLibrary
     autoScroll notesStudio — see ../../apps/mobile/ui/features/subscription/
     featureKeys.ts)

REQUIREMENTS
    pip install -r requirements.txt   # Pillow

USAGE
    python3 floodfill_bg.py <input.png>
    # If too much/too little is removed, tune TOL below.
"""
import sys
from PIL import Image
from collections import deque

TOL = 28  # per-channel match tolerance


def is_bg(px, ref):
    return all(abs(int(a) - int(b)) <= TOL for a, b in zip(px[:3], ref[:3]))


def floodfill_alpha(img: Image.Image) -> Image.Image:
    """Floodfill from each corner separately, using each corner's *own*
    color as the reference. Handles checker-pattern fake-transparency
    backgrounds where the model paints alternating grey/white squares."""
    img = img.convert("RGBA")
    w, h = img.size
    px = img.load()
    seeds = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]
    visited = [[False] * w for _ in range(h)]
    for seed in seeds:
        ref = px[seed][:3]
        q = deque([seed])
        if visited[seed[1]][seed[0]]:
            continue
        visited[seed[1]][seed[0]] = True
        while q:
            x, y = q.popleft()
            if not is_bg(px[x, y], ref):
                continue
            px[x, y] = (0, 0, 0, 0)
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < w and 0 <= ny < h and not visited[ny][nx]:
                    visited[ny][nx] = True
                    q.append((nx, ny))
    return img


def main():
    if len(sys.argv) < 2:
        print("usage: floodfill_bg.py <input.png>")
        sys.exit(1)
    src = sys.argv[1]
    out = src.rsplit(".", 1)[0] + ".cut.png"
    img = Image.open(src)
    print(f"{src}: mode={img.mode} size={img.size}")
    out_img = floodfill_alpha(img)
    out_img.save(out)
    # report
    a = out_img.split()[-1]
    pix = list(a.getdata())
    transparent = sum(1 for p in pix if p == 0)
    print(f"wrote {out}: {100*transparent/len(pix):.1f}% transparent pixels")


if __name__ == "__main__":
    main()
