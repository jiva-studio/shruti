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
CREAM = (250, 245, 234)
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


CARDS = {
    "en": ("Shruti", "Lectures of A. C. Bhaktivedanta Swami Prabhupada"),
    "ru": ("Слушай Садху", "Лекции А. Ч. Бхактиведанты Свами Прабхупады"),
}


def render(lang, title, subtitle):
    img = Image.new("RGB", (W, H), CREAM)
    draw = ImageDraw.Draw(img)

    icon = Image.open(os.path.join(PUBLIC, "app-icon.png")).convert("RGBA").resize((360, 360))
    iy = (H - 360) // 2
    img.paste(icon, (96, iy), icon)

    tx = 96 + 320 + 64
    avail = W - tx - 64

    title_size = 82
    while title_size > 48:
        title_f = font(SERIF, title_size, "ExtraBold")
        if draw.textlength(title, font=title_f) <= avail:
            break
        title_size -= 1

    sub_size = 36
    while sub_size > 22:
        sub_f = font(SANS, sub_size, "Medium")
        if draw.textlength(subtitle, font=sub_f) <= avail:
            break
        sub_size -= 1

    draw.text((tx, 232), title, font=title_f, fill=INK)
    draw.rectangle([tx + 2, 340, tx + 122, 348], fill=SAFFRON)
    draw.text((tx, 372), subtitle, font=sub_f, fill=MEDIUM)

    out = os.path.join(PUBLIC, f"og-default.{lang}.jpg")
    img.save(out, "JPEG", quality=88)
    print("wrote", out, img.size)


def main():
    for lang, (title, subtitle) in CARDS.items():
        render(lang, title, subtitle)


if __name__ == "__main__":
    main()
