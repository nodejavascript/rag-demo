#!/usr/bin/env python3
"""Generate the icon set and the social card for rag-demo.nodejavascript.com.

The mark is a page with a folded corner and three lines of text, because the whole site is
"bring a document and ask it something". It is the same mark as the card on
nodejavascript.com, drawn from the same geometry, so the tab, the home screen, the share
card and the catalogue entry all show one thing.

🔴 THE TWO THINGS THIS SCRIPT EXISTS TO GET RIGHT, both of which the SEO audit checks and
both of which the first version of this site got wrong:

  1. **`favicon.ico` must carry 16, 32 AND 48.** It held only 16x16 — which renders as a
     blur on every modern browser tab and on a Windows taskbar.
  2. **The apple touch icon must be 180x180 with NO alpha channel.** iOS composites a
     transparent icon onto black, so a transparent one arrives on a home screen with
     black wedges through it. It is drawn onto the badge's own flat colour instead.

    ~/Documents/git/gitlab.com/datavisionstudios/docker-compose-master/.venv/bin/python3 tools/make-icons.py

Run it from the repository root; it writes into `site/`.
"""
import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(os.path.dirname(HERE), "site")

# The page's own ground and accent, so the icon matches the site it stands for.
BG = (3, 9, 11)
TEAL = (94, 234, 212)
TEAL_DEEP = (20, 184, 166)
INK = (230, 246, 248)
MUTED = (123, 161, 168)

# Geometry in a 32x32 space, shared by the SVG and the raster versions.
PAGE = [(7.0, 3.0), (19.0, 3.0), (25.0, 9.0), (25.0, 29.0), (7.0, 29.0)]
FOLD = [(19.0, 3.0), (19.0, 9.0), (25.0, 9.0)]
LINES = [((11.5, 16.0), (20.5, 16.0)), ((11.5, 21.0), (20.5, 21.0)), ((11.5, 26.0), (16.0, 26.0))]
STROKE = 1.8

SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="rag-demo">
  <rect width="32" height="32" rx="7" fill="#03090b"/>
  <g stroke="#5eead4" stroke-width="1.8" fill="none" stroke-linejoin="round" stroke-linecap="round">
    <path d="M7 3h12l6 6v20H7z"/>
    <path d="M19 3v6h6"/>
    <path d="M11.5 16h9M11.5 21h9M11.5 26h4.5"/>
  </g>
</svg>
"""


def draw_mark(img, size, inset=0.0):
    """Draw the page mark into a square image of the given pixel size."""
    draw = ImageDraw.Draw(img)
    pad = inset * size
    scale = (size - 2 * pad) / 32.0
    width = max(1, round(STROKE * scale))

    def pt(x, y):
        return (pad + x * scale, pad + y * scale)

    draw.line([pt(*p) for p in PAGE] + [pt(*PAGE[0])], fill=TEAL, width=width, joint="curve")
    draw.line([pt(*p) for p in FOLD], fill=TEAL, width=width, joint="curve")
    for start, end in LINES:
        draw.line([pt(*start), pt(*end)], fill=TEAL, width=width)
    return img


def square(size, radius_ratio=0.22, bg=BG, mark_inset=0.19):
    """A rounded badge with the mark on it, opaque."""
    # 4x supersample, then downscale — Pillow has no anti-aliased line drawing.
    big = size * 4
    img = Image.new("RGB", (big, big), bg)
    draw = ImageDraw.Draw(img)
    # The rounded corners are drawn as background, so the shape is the same colour as the
    # ground: an icon is not a sticker, and a white square in a dark tab bar is worse than
    # no icon at all.
    draw.rounded_rectangle([0, 0, big - 1, big - 1], radius=int(big * radius_ratio), fill=bg)
    draw_mark(img, big, inset=mark_inset)
    return img.resize((size, size), Image.LANCZOS)


def font(size, bold=True):
    """A real font, with a fallback so this never crashes on a machine without one."""
    names = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ]
    for name in names:
        if os.path.exists(name):
            return ImageFont.truetype(name, size)
    return ImageFont.load_default()


def social_card(width=1200, height=630):
    """The card a link unfurls into.

    🔴 This file did not exist, and its absence was invisible: the page advertised
    `og.png` in `og:image` and `twitter:image`, the URL 404'd, and every share on every
    platform rendered with no image at all. Nothing on the site looked wrong. It was found
    by asking the deployed host for the file the page names — which is now a check in
    `~/.seo_audit.py`, because the alternative is finding it again the same way.
    """
    img = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(img)

    # A soft teal wash in the corner, so the card is not a flat black rectangle in a feed.
    for y in range(height):
        t = y / height
        blend = tuple(round(BG[i] + (TEAL_DEEP[i] - BG[i]) * (1 - t) * 0.16) for i in range(3))
        draw.line([(0, y), (width, y)], fill=blend)

    mark = Image.new("RGB", (144, 144), BG)
    draw_mark(mark, 144, inset=0.06)
    img.paste(mark, ((width - 144) // 2, 96))

    title = "rag-demo"
    subtitle = "nodejavascript.com"
    line = "Paste a document, then ask it questions."
    line2 = "Grounded answers — and what the document does not say."

    def centred(text, y, f, fill):
        left, top, right, bottom = draw.textbbox((0, 0), text, font=f)
        draw.text(((width - (right - left)) // 2, y), text, font=f, fill=fill)

    centred(title, 288, font(76), INK)
    centred(subtitle, 382, font(32, bold=False), TEAL)
    centred(line, 462, font(30, bold=False), MUTED)
    centred(line2, 504, font(30, bold=False), MUTED)
    return img


def main():
    os.makedirs(SITE, exist_ok=True)

    with open(os.path.join(SITE, "favicon.svg"), "w", encoding="utf-8") as handle:
        handle.write(SVG)

    square(32).save(os.path.join(SITE, "favicon-32.png"))
    square(192).save(os.path.join(SITE, "android-chrome-192.png"))
    square(512).save(os.path.join(SITE, "android-chrome-512.png"))

    # 180x180 and OPAQUE — converted to RGB so there is no alpha channel to composite.
    square(180, radius_ratio=0.0, mark_inset=0.17).convert("RGB").save(
        os.path.join(SITE, "apple-touch-icon.png")
    )

    # The one that was wrong: an .ico carrying only 16x16.
    square(48).save(
        os.path.join(SITE, "favicon.ico"),
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48)],
    )

    social_card().save(os.path.join(SITE, "og.png"), optimize=True)

    for name in ("favicon.svg", "favicon-32.png", "favicon.ico", "apple-touch-icon.png", "og.png"):
        path = os.path.join(SITE, name)
        print(f"  {name:24} {os.path.getsize(path):>8,} bytes")


if __name__ == "__main__":
    main()
