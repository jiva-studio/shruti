#!/usr/bin/env python3
"""Generate the default social-card image (public/og-default.jpg, 1200x630).

Branded fallback used by BaseLayout when a page has no cover of its own
(home, /lectures, /topics, /library hubs). Per-collection/topic/lecture pages
override it with their real cover.
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(HERE, "..", "public")

W, H = 1200, 630
CREAM = (245, 239, 227)
INK = (61, 43, 31)
MEDIUM = (128, 103, 82)
SAFFRON = (204, 122, 61)

SERIF = "/nix/store/wlkw8grs68czgilvbrjjp88ggcspdfgl-noto-fonts-2026.05.01/share/fonts/noto/NotoSerif.ttf"
SANS = "/nix/store/wlkw8grs68czgilvbrjjp88ggcspdfgl-noto-fonts-2026.05.01/share/fonts/noto/NotoSans.ttf"


def font(path, size, variation):
    f = ImageFont.truetype(path, size)
    try:
        f.set_variation_by_name(variation)
    except Exception:
        pass
    return f


def rounded(im, radius):
    mask = Image.new("L", im.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, im.size[0], im.size[1]], radius=radius, fill=255)
    im.putalpha(mask)
    return im


def main():
    img = Image.new("RGB", (W, H), CREAM)
    draw = ImageDraw.Draw(img)

    icon = Image.open(os.path.join(PUBLIC, "app-icon.png")).convert("RGBA").resize((320, 320))
    icon = rounded(icon, 72)
    iy = (H - 320) // 2
    img.paste(icon, (96, iy), icon)

    tx = 96 + 320 + 64
    title_f = font(SERIF, 82, "ExtraBold")
    sub_f = font(SANS, 36, "Medium")

    draw.text((tx, 232), "Shruti", font=title_f, fill=INK)
    draw.rectangle([tx + 2, 340, tx + 122, 348], fill=SAFFRON)
    draw.text((tx, 372), "Lectures of Srila Prabhupada", font=sub_f, fill=MEDIUM)

    out = os.path.join(PUBLIC, "og-default.jpg")
    img.save(out, "JPEG", quality=88)
    print("wrote", out, img.size)


if __name__ == "__main__":
    main()
