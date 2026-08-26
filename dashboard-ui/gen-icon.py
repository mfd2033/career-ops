#!/usr/bin/env python3
"""Generate the career-dashboard-ui.exe application icon.

Draws a flat, brand-consistent dashboard glyph on the career-ops orange
(#D5742E) rounded-square: three white rising bars joined by an upward trend
line with a terminal dot. Rendered with Pillow (offline, no SVG rasteriser)
and saved as a multi-resolution .ico plus per-size PNGs.
"""

from PIL import Image, ImageDraw

S = 256
ORANGE = (213, 116, 46, 255)  # career-ops brand #D5742E
WHITE = (255, 255, 255, 255)
CORNER = 50


def draw_canvas() -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Rounded-square background
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=CORNER, fill=ORANGE)

    # Three rising bars (dashboard volume), bottom-aligned in the lower half.
    bar_w = 26
    gap = 17
    heights = [56, 86, 120]
    y_base = 192
    total = 3 * bar_w + 2 * gap
    x0 = (S - total) // 2
    tops = []
    for i, h in enumerate(heights):
        x = x0 + i * (bar_w + gap)
        d.rounded_rectangle([x, y_base - h, x + bar_w, y_base], radius=9, fill=WHITE)
        tops.append((x + bar_w / 2, y_base - h))

    # Upward trend line across the bar tops with a terminal dot.
    d.line(tops, fill=WHITE, width=7, joint="curve")
    for p in tops:
        d.ellipse([p[0] - 8, p[1] - 8, p[0] + 8, p[1] + 8], fill=WHITE)

    return img


def make_ico(sizes=(16, 24, 32, 48, 64, 128, 256)) -> tuple[Image.Image, list[tuple[int, int]]]:
    base = draw_canvas()
    # Pillow's ICO save wants an RGBA base image; it generates the resized
    # entries itself from the sizes list when passed as a single image.
    return base, [(s, s) for s in sizes]


def main() -> None:
    base = draw_canvas()
    sizes = [16, 24, 32, 48, 64, 128, 256]

    # Individual PNGs (useful for previews / non-Windows packaging).
    for s in sizes:
        resized = base.resize((s, s), Image.LANCZOS)
        resized.save(f"icon-{s}.png")

    # Multi-resolution ICO (Windows embeds the closest match to the display).
    base.save("icon.ico", sizes=[(s, s) for s in sizes])

    print("wrote icon.ico + icon-{16,24,32,48,64,128,256}.png")


if __name__ == "__main__":
    main()
