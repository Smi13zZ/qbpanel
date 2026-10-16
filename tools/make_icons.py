#!/usr/bin/env python3
"""Generate qbpanel application icons (rounded blue tile + download glyph)."""
import os
from PIL import Image, ImageDraw

ROOT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "qbpanel"
)

GRAD = ((34, 34, 34, 255), (44, 44, 44, 255), (10, 10, 10, 255), (18, 18, 18, 255))
WHITE = (255, 255, 255, 255)
LIGHT = (163, 163, 163, 255)


def build(size):
    s = size * 4
    grad = Image.new("RGBA", (2, 2))
    grad.putpixel((0, 0), GRAD[0])
    grad.putpixel((1, 0), GRAD[1])
    grad.putpixel((0, 1), GRAD[2])
    grad.putpixel((1, 1), GRAD[3])
    grad = grad.resize((s, s), Image.BICUBIC)

    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.235), fill=255)
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)
    u = s / 64.0
    cx = s / 2.0
    w = 5.4 * u

    d.rounded_rectangle([cx - w / 2, 12.5 * u, cx + w / 2, 35 * u], radius=w / 2, fill=WHITE)

    pts = [(21.5 * u, 27.5 * u), (32 * u, 38.5 * u), (42.5 * u, 27.5 * u)]
    d.line(pts, fill=WHITE, width=int(round(w)), joint="curve")
    r = w / 2.0
    d.ellipse([pts[0][0] - r, pts[0][1] - r, pts[0][0] + r, pts[0][1] + r], fill=WHITE)
    d.ellipse([pts[2][0] - r, pts[2][1] - r, pts[2][0] + r, pts[2][1] + r], fill=WHITE)

    d.rounded_rectangle([19 * u, 44.6 * u, 45 * u, 44.6 * u + w], radius=w / 2, fill=LIGHT)

    return img.resize((size, size), Image.LANCZOS)


def save(img, *parts):
    path = os.path.join(ROOT, *parts)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, "PNG", optimize=True)
    print("wrote", path, img.size)


def main():
    big = build(256)
    small = build(64)
    save(big, "ICON_256.PNG")
    save(small, "ICON.PNG")
    save(big, "app", "ui", "images", "ICON_256.PNG")
    save(small, "app", "ui", "images", "ICON.PNG")
    save(small, "app", "ui", "images", "ICON_64.PNG")
    save(build(128), "app", "web", "images", "icon.png")


if __name__ == "__main__":
    main()
