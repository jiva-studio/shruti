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
DARK = (22, 18, 15)
CREAM = (245, 239, 227)
MEDIUM = (190, 165, 140)
HAIRLINE = (60, 50, 42)
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
    img = Image.new("RGB", (W, H), DARK)
    draw = ImageDraw.Draw(img)

    icon = Image.open(os.path.join(PUBLIC, "app-icon.png")).convert("RGBA").resize((320, 320))
    icon = rounded(icon, 72)
    iy = (H - 320) // 2
    img.paste(icon, (96, iy), icon)
    draw.rounded_rectangle([96, iy, 96 + 320, iy + 320], radius=72, outline=HAIRLINE, width=2)

    tx = 96 + 320 + 64
    avail = W - tx - 64
    title_f = font(SERIF, 82, "ExtraBold")

    subtitle = "Lectures of A. C. Bhaktivedanta Swami Prabhupada"
    sub_size = 36
    while sub_size > 22:
        sub_f = font(SANS, sub_size, "Medium")
        if draw.textlength(subtitle, font=sub_f) <= avail:
            break
        sub_size -= 1

    draw.text((tx, 232), "Shruti", font=title_f, fill=CREAM)
    draw.rectangle([tx + 2, 340, tx + 122, 348], fill=SAFFRON)
    draw.text((tx, 372), subtitle, font=sub_f, fill=MEDIUM)

    out = os.path.join(PUBLIC, "og-default.jpg")
    img.save(out, "JPEG", quality=88)
    print("wrote", out, img.size)


if __name__ == "__main__":
    main()
