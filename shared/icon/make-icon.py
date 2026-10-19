# TeinDesk — Copyright (C) 2026 TeinDesk contributors. GPL-3.0, see LICENSE.
# Usage: python make-icon.py [out_dir]  → TeinDesk app icons, light and dark (needs Pillow).
# The mark, Liquid Glass style on a blue-violet tile: a frosted macOS window in front of
# a frosted Windows window, and one cursor where they overlap.
import os
import sys
from PIL import Image, ImageChops, ImageDraw, ImageFilter

out = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
SS = 4; S = 1024 * SS; k = SS


def P(*v): return [round(x * k) for x in v]
def hexc(h, a=255): return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5)) + (a,)
def solid(c): return Image.new('RGBA', (S, S), c)


def rounded(box, r):
    m = Image.new('L', (S, S), 0)
    ImageDraw.Draw(m).rounded_rectangle(P(*box), radius=round(r * k), fill=255)
    return m


def paint(im, mask, col):
    layer = solid(col)
    layer.putalpha(mask.point(lambda v: v * col[3] // 255))
    return Image.alpha_composite(im, layer)


def diag():
    """0 at the top-left corner, 255 at the bottom-right."""
    g = Image.linear_gradient('L').resize((S, S))
    return ImageChops.add(g.point(lambda v: v // 2), g.rotate(90).point(lambda v: (255 - v) // 2))


def gradient(stops):
    t = diag(); lut = []
    for i in range(256):
        x = i / 255
        for (a, ca), (b, cb) in zip(stops, stops[1:]):
            if x <= b:
                u = (x - a) / (b - a)
                lut.append(tuple(round(ca[j] + (cb[j] - ca[j]) * u) for j in range(3))); break
    chans = [t.point([lut[i][c] for i in range(256)]) for c in range(3)]
    return Image.merge('RGBA', chans + [Image.new('L', (S, S), 255)])


def glass(im, box, r, tint):
    m = rounded(box, r)
    backdrop = im.filter(ImageFilter.GaussianBlur(26 * k))       # before our own shadow
    sh = Image.new('L', (S, S), 0)
    ImageDraw.Draw(sh).rounded_rectangle(P(box[0], box[1] + 22, box[2], box[3] + 30), radius=r * k, fill=55)
    im = paint(im, sh.filter(ImageFilter.GaussianBlur(28 * k)), (20, 10, 70, 255))
    im = Image.composite(backdrop, im, m)
    im = paint(im, m, tint)
    sheen = Image.new('L', (S, S), 0)
    ImageDraw.Draw(sheen).ellipse(P(box[0] - 80, box[1] - 260, box[2] + 80, box[1] + 150), fill=110)
    im = paint(im, ImageChops.multiply(sheen.filter(ImageFilter.GaussianBlur(40 * k)), m), (255, 255, 255, 255))
    ring = ImageChops.subtract(m, rounded((box[0] + 6, box[1] + 6, box[2] - 6, box[3] - 6), r - 6))
    im = paint(im, ImageChops.multiply(ring, diag().point(lambda v: 255 - int(v * 0.75))), (255, 255, 255, 255))
    return im, m


def icon(dark=False):
    # Blue -> violet tile with soft cyan and pink light for the glass to blur. The dark
    # version is a plain black tile with smoked glass.
    if dark:
        im = gradient([(0, hexc('#26262c')), (1, hexc('#030304'))])
        glows = ()
    else:
        im = gradient([(0, hexc('#5ad1ff')), (0.5, hexc('#5b6cff')), (1, hexc('#a855f7'))])
        glows = (((560, 120, 980, 540), '#ff9ad5', 200), ((40, 560, 460, 980), '#7cf7e4', 170))
    for box, col, a in glows:
        blob = Image.new('L', (S, S), 0)
        ImageDraw.Draw(blob).ellipse(P(*box), fill=a)
        im = paint(im, blob.filter(ImageFilter.GaussianBlur(70 * k)), hexc(col))

    # Windows window, behind on the right.
    B = (392, 352, 872, 772)
    im, _ = glass(im, B, 64, (200, 210, 235, 70) if dark else (225, 240, 255, 105))
    d = ImageDraw.Draw(im); g = (255, 255, 255, 210) if dark else hexc('#1b1740', 200); w = round(9 * k); y = B[1] + 52
    d.line(P(B[2] - 190, y, B[2] - 160, y), fill=g, width=w)                              # minimise
    d.rectangle(P(B[2] - 128, y - 15, B[2] - 98, y + 15), outline=g, width=w)             # maximise
    d.line(P(B[2] - 66, y - 15, B[2] - 36, y + 15), fill=g, width=w)                      # close
    d.line(P(B[2] - 66, y + 15, B[2] - 36, y - 15), fill=g, width=w)

    # macOS window in front, on the left.
    A = (152, 212, 632, 632)
    im, _ = glass(im, A, 64, (255, 255, 255, 95) if dark else (255, 255, 255, 130))
    d = ImageDraw.Draw(im)
    for i, c in enumerate(('#ff5f57', '#febc2e', '#28c840')):
        cx, cy = A[0] + 58 + i * 52, A[1] + 52
        d.ellipse(P(cx - 17, cy - 17, cx + 17, cy + 17), fill=hexc(c))

    # The cursor, where the two windows overlap.
    u, ox, oy = 10, 446, 420
    arrow = [(0, 0), (0, 21), (5.2, 16.2), (8.6, 24), (12.2, 22.4), (8.9, 14.8), (15.6, 14.8)]
    pts = [(round((ox + x * u) * k), round((oy + y * u) * k)) for x, y in arrow]
    sh = Image.new('L', (S, S), 0)
    ImageDraw.Draw(sh).polygon([(x + 6 * k, y + 14 * k) for x, y in pts], fill=140)
    im = paint(im, sh.filter(ImageFilter.GaussianBlur(12 * k)), (20, 10, 60, 255))
    d = ImageDraw.Draw(im)
    d.polygon(pts, fill=(255, 255, 255, 255))
    d.line(pts + pts[:2], fill=hexc('#1b1740'), width=round(12 * k), joint='curve')
    return im


def framed(im, full):
    o = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    if full:
        o.paste(im, (0, 0), rounded((0, 0, 1023, 1023), 224))
        return o.resize((1024, 1024), Image.LANCZOS)
    sh = Image.new('L', (S, S), 0)
    ImageDraw.Draw(sh).rounded_rectangle(P(100, 112, 924, 936), radius=185 * k, fill=110)
    o = paint(o, sh.filter(ImageFilter.GaussianBlur(14 * k)), (0, 0, 0, 255))
    layer = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    layer.paste(im.resize((round(S * 824 / 1024),) * 2, Image.LANCZOS), (100 * k, 100 * k))
    o.paste(layer, (0, 0), rounded((100, 100, 924, 924), 185))
    return o.resize((1024, 1024), Image.LANCZOS)


os.makedirs(out, exist_ok=True)
for name, dark in (('teindesk', False), ('teindesk-dark', True)):
    art = icon(dark)
    full, mac = framed(art, True), framed(art, False)
    full.save(os.path.join(out, f'{name}.png'))
    mac.save(os.path.join(out, f'{name}-mac.png'))
    full.save(os.path.join(out, f'{name}.ico'),
              sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    mac.save(os.path.join(out, f'{name}.icns'))
    for n in (16, 32, 48, 64, 128, 256, 512):
        full.resize((n, n), Image.LANCZOS).save(os.path.join(out, f'{name}-{n}.png'))
print('wrote', out)
