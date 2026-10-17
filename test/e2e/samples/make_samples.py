"""Draws the pictures the screenshot script serves in place of real photographs, gifs and video thumbnails.

They are committed, so nothing needs to run this. It exists so they can be changed: `python3 make_samples.py`
(needs Pillow). Everything is drawn from shapes and gradients, so there is no one else's picture in the repository.
"""
import math
import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))


def gradient(w, h, top, bottom):
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        t = y / (h - 1)
        c = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        for x in range(w):
            px[x, y] = c
    return img


def font(size):
    try:
        return ImageFont.load_default(size)
    except TypeError:
        return ImageFont.load_default()


def landscape(w=640, h=360):
    img = gradient(w, h, (255, 190, 120), (90, 120, 200))
    d = ImageDraw.Draw(img)
    d.ellipse((w * 0.66, h * 0.14, w * 0.66 + 80, h * 0.14 + 80), fill=(255, 244, 200))
    for i, (base, col) in enumerate([(0.62, (70, 90, 130)), (0.74, (45, 70, 100)), (0.88, (25, 45, 70))]):
        pts = [(0, h)]
        for x in range(0, w + 1, 8):
            y = h * base + math.sin(x / (60 + i * 25) + i) * (18 + i * 6)
            pts.append((x, y))
        pts.append((w, h))
        d.polygon(pts, fill=col)
    return img


def dashboard(w=600, h=340):
    img = Image.new("RGB", (w, h), (24, 28, 38))
    d = ImageDraw.Draw(img)
    d.rectangle((0, 0, w, 36), fill=(36, 42, 58))
    d.text((14, 8), "Release dashboard", fill=(220, 226, 240), font=font(18))
    heights = [90, 140, 110, 180, 150, 210, 170, 240]
    for i, v in enumerate(heights):
        x = 40 + i * 64
        d.rounded_rectangle((x, h - 30 - v, x + 40, h - 30), radius=5, fill=(90 + i * 14, 140, 235 - i * 10))
    d.line((30, h - 30, w - 20, h - 30), fill=(70, 78, 98), width=2)
    return img


def thumbnail(w=480, h=270):
    img = gradient(w, h, (40, 20, 70), (190, 60, 90))
    d = ImageDraw.Draw(img)
    d.ellipse((w / 2 - 38, h / 2 - 38, w / 2 + 38, h / 2 + 38), fill=(255, 255, 255))
    d.polygon([(w / 2 - 12, h / 2 - 22), (w / 2 - 12, h / 2 + 22), (w / 2 + 24, h / 2)], fill=(190, 60, 90))
    return img


def loop(w=320, h=200, frames=14):
    out = []
    for f in range(frames):
        t = f / frames
        img = gradient(w, h, (20, 30, 70), (60, 20, 90))
        d = ImageDraw.Draw(img)
        for k in range(5):
            a = (t + k / 5) * 2 * math.pi
            x = w / 2 + math.cos(a) * (w * 0.32)
            y = h / 2 + math.sin(a * 2) * (h * 0.28)
            r = 14 + 6 * math.sin(a + t * 6)
            d.ellipse((x - r, y - r, x + r, y + r), fill=(255, 120 + k * 25, 160 - k * 20))
        out.append(img)
    return out


landscape().save(os.path.join(HERE, "photo.png"), optimize=True)
dashboard().save(os.path.join(HERE, "dashboard.png"), optimize=True)
thumbnail().save(os.path.join(HERE, "thumb.png"), optimize=True)
frames = loop()
frames[0].save(os.path.join(HERE, "loop.gif"), save_all=True, append_images=frames[1:], duration=70, loop=0, optimize=True)
for name in ("photo.png", "dashboard.png", "thumb.png", "loop.gif"):
    print(name, os.path.getsize(os.path.join(HERE, name)), "bytes")
