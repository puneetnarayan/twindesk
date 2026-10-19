# TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# Usage: python make-tray.py  → tray / menu bar glyphs, drawn from the dark icon's mark
# (teindesk-dark.png: a front window, a window behind it, one cursor where they overlap).
# One colour on transparency: white and black for the Windows taskbar (dark/light), a black
# template for the macOS menu bar (macOS tints it), white for Linux panels. Needs Pillow.
import os
from PIL import Image, ImageDraw, ImageFilter

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.join(here, '..', '..')

# The mark in teindesk-dark.png's 1024 px coordinates.
FRONT = (152, 212, 632, 632)
BACK = (392, 352, 872, 772)
RADIUS = 44
CURSOR = [(443, 418), (443, 640), (497, 588), (532, 664), (572, 648), (538, 574), (610, 574)]
BOX = (140, 200, 884, 784)  # the mark's extent, with a little room for the strokes
SS = 8  # supersampling


def glyph(px, color, line):
    """The mark at px × px; line = stroke width in output pixels."""
    w, h = BOX[2] - BOX[0], BOX[3] - BOX[1]
    side = max(w, h)
    scale = (px * SS) / side
    ox = (side - w) / 2 - BOX[0]
    oy = (side - h) / 2 - BOX[1]
    T = lambda x, y: ((x + ox) * scale, (y + oy) * scale)
    R = lambda r: tuple(v for p in (T(r[0], r[1]), T(r[2], r[3])) for v in p)
    sw = max(1, round(line * SS))
    m = Image.new('L', (px * SS, px * SS), 0)
    d = ImageDraw.Draw(m)
    rad = RADIUS * scale
    d.rounded_rectangle(R(BACK), radius=rad, outline=255, width=sw)
    d.rounded_rectangle(R(FRONT), radius=rad, fill=0)  # the back window goes behind the front one
    d.rounded_rectangle(R(FRONT), radius=rad, outline=255, width=sw)
    # The cursor, with a gap around it so it reads over the outlines.
    pts = [T(x, y) for x, y in CURSOR]
    gap = Image.new('L', m.size, 0)
    ImageDraw.Draw(gap).polygon(pts, fill=255)
    gap = gap.filter(ImageFilter.MaxFilter(2 * sw + 1))
    m.paste(0, (0, 0), gap)
    d.polygon(pts, fill=255)
    m = m.resize((px, px), Image.LANCZOS)
    out = Image.new('RGBA', (px, px), color + (0,))
    out.putalpha(m)
    return out


def save(img, *parts):
    p = os.path.join(*parts)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    img.save(p)


WHITE, BLACK = (255, 255, 255), (0, 0, 0)
win = os.path.join(root, 'windows', 'assets')
lin = os.path.join(root, 'linux', 'assets')
# Windows taskbar: 16 px and 32 px (@2x); white on a dark taskbar, black on a light one.
for base, color in (('tray-white', WHITE), ('tray-black', BLACK), ('tray', WHITE)):
    save(glyph(16, color, 1.4), win, base + '.png')
    save(glyph(32, color, 2.4), win, base + '@2x.png')
# Linux panels (mostly dark).
save(glyph(16, WHITE, 1.4), lin, 'tray.png')
save(glyph(32, WHITE, 2.4), lin, 'tray@2x.png')
# macOS menu bar template, 18 pt and @2x (for the Mac app: mac/assets/trayTemplate*.png).
save(glyph(18, BLACK, 1.5), here, 'trayTemplate.png')
save(glyph(36, BLACK, 2.6), here, 'trayTemplate@2x.png')

if __name__ == '__main__' and os.environ.get('PREVIEW'):
    prev = Image.new('RGBA', (640, 200), (32, 32, 36, 255))
    x = 10
    for px, line in ((16, 1.4), (32, 2.4), (64, 4)):
        g = glyph(px, WHITE, line).resize((px * 4 if px < 64 else px * 2,) * 2, Image.NEAREST)
        prev.alpha_composite(g, (x, 10))
        x += g.size[0] + 20
    lt = Image.new('RGBA', (200, 200), (236, 236, 240, 255))
    lt.alpha_composite(glyph(36, BLACK, 2.6).resize((144, 144), Image.NEAREST), (28, 28))
    prev.paste(lt, (440, 0))
    prev.save(os.path.join(here, 'tray-preview.png'))
print('done')
