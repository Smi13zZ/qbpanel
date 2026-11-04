#!/usr/bin/env python3
"""Generate qbpanel application icons (rounded dark tile + download glyph).

Sizes matter: the fnOS app centre asks for a different icon size depending on
device and pixel density (system apps ship 16/24/48/64/72/96/128/256/512 - nine
steps). Shipping only 64 and 256 left the tile blank on phones, which request
72/96/128. ui/config points at "images/icon_{0}.png" and the app centre replaces
{0} with the size it wants, so every step has to exist on disk.
"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "qbpanel"
)

GRAD = ((34, 34, 34, 255), (44, 44, 44, 255), (10, 10, 10, 255), (18, 18, 18, 255))
WHITE = (255, 255, 255, 255)
LIGHT = (163, 163, 163, 255)

# 应用中心在不同设备/设备密度下会请求不同尺寸（实测系统应用提供这九档）
UI_SIZES = [16, 24, 48, 64, 72, 96, 128, 256, 512]


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
    print("  %-46s %dx%d %7d B" % (os.path.relpath(path, ROOT), img.width, img.height,
                                   os.path.getsize(path)))


def main():
    print("== qbpanel 图标 ==")
    # 外层 ICON.PNG / ICON_256.PNG 是 fnpack 要求的固定名字
    save(build(256), "ICON_256.PNG")
    save(build(64), "ICON.PNG")
    save(build(256), "app", "ui", "images", "ICON_256.PNG")
    save(build(64), "app", "ui", "images", "ICON.PNG")
    save(build(64), "app", "ui", "images", "ICON_64.PNG")

    # ui/config 里写的是 "images/icon_{0}.png"，应用中心把 {0} 换成实际尺寸
    for s in UI_SIZES:
        save(build(s), "app", "ui", "images", "icon_%d.png" % s)

    # 占位符原样留一份，兼容把 {0} 当字面量的实现
    save(build(512), "app", "ui", "images", "icon_{0}.png")

    # web favicon
    save(build(192), "app", "web", "images", "icon.png")


if __name__ == "__main__":
    main()