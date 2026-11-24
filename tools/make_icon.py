#!/usr/bin/env python3
"""Make the Windows icon (webpulse.ico) from the UI's favicon.

Usage: make_icon.py <index.html> <output.ico>

The favicon in web/index.html is an inline SVG: one stroked path of
horizontal and vertical lines (the square-wave logo). This reads that path,
its stroke colour and width, and draws it at the usual icon sizes, so the
executable always shows the same logo as the browser tab. Only the standard
library is used (no Pillow or SVG renderer on the build machines).

Supported: one <path> with M/L/H/V commands (absolute or relative) made of
axis-parallel lines, stroke-width, a #rrggbb stroke, butt caps and miter
joins (the SVG defaults), and the viewBox.
"""
import re
import struct
import sys
import urllib.parse
import zlib

SIZES = (16, 20, 24, 32, 40, 48, 64, 256)
SUPERSAMPLE = 8         # samples per pixel along each axis, for anti-aliasing


def read_favicon(html_path):
    html = open(html_path, encoding="utf-8").read()
    m = re.search(r'<link[^>]*rel="icon"[^>]*href="data:image/svg\+xml,([^"]*)"', html)
    if not m:
        sys.exit("make_icon: no inline SVG favicon in %s" % html_path)
    svg = urllib.parse.unquote(m.group(1))
    vb = [float(v) for v in re.search(r"viewBox='([^']*)'", svg).group(1).split()]
    d = re.search(r"\bd='([^']*)'", svg).group(1)
    colour = re.search(r"stroke='#([0-9a-fA-F]{6})'", svg).group(1)
    width = float(re.search(r"stroke-width='([0-9.]+)'", svg).group(1))
    rgb = tuple(int(colour[i:i + 2], 16) for i in (0, 2, 4))
    return vb, parse_path(d), rgb, width


def parse_path(d):
    """Return the path's points; every segment is horizontal or vertical."""
    pts = []
    x = y = 0.0
    for cmd, args in re.findall(r"([MmLlHhVv])([^MmLlHhVv]*)", d):
        nums = [float(n) for n in re.findall(r"-?[0-9.]+", args)]
        rel = cmd.islower()
        c = cmd.upper()
        if c in "ML":
            for i in range(0, len(nums), 2):
                x = (x if rel else 0) + nums[i]
                y = (y if rel else 0) + nums[i + 1]
                pts.append((x, y))
        elif c == "H":
            for n in nums:
                x = (x if rel else 0) + n
                pts.append((x, y))
        else:
            for n in nums:
                y = (y if rel else 0) + n
                pts.append((x, y))
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if x0 != x1 and y0 != y1:
            sys.exit("make_icon: the favicon path has a diagonal line; extend make_icon.py")
    return pts


def stroke_rects(pts, width):
    """The stroke as rectangles: each segment widened by width/2, and extended
    by width/2 at inner corners (a miter join of two right-angled lines);
    the two ends are left flat (butt caps)."""
    h = width / 2
    rects = []
    last = len(pts) - 2
    for i, ((x0, y0), (x1, y1)) in enumerate(zip(pts, pts[1:])):
        a = h if i > 0 else 0           # extend back into the previous corner
        b = h if i < last else 0        # extend forward into the next corner
        if y0 == y1:
            lo, hi = (x0 - a, x1 + b) if x1 >= x0 else (x1 - b, x0 + a)
            rects.append((lo, y0 - h, hi, y0 + h))
        else:
            lo, hi = (y0 - a, y1 + b) if y1 >= y0 else (y1 - b, y0 + a)
            rects.append((x0 - h, lo, x0 + h, hi))
    return rects


def render(size, vb, rects, rgb):
    """RGBA rows, the path scaled to fill the icon's square."""
    vx, vy, vw, vh = vb
    scale = size / max(vw, vh)
    n = SUPERSAMPLE
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            hits = 0
            for sy in range(n):
                y = vy + (py + (sy + 0.5) / n) / scale
                for sx in range(n):
                    x = vx + (px + (sx + 0.5) / n) / scale
                    for (x0, y0, x1, y1) in rects:
                        if x0 <= x < x1 and y0 <= y < y1:
                            hits += 1
                            break
            alpha = (hits * 255 + n * n // 2) // (n * n)
            row += bytes((*rgb, alpha))
        rows.append(bytes(row))
    return rows


def png(size, rows):
    def chunk(kind, data):
        return (struct.pack(">I", len(data)) + kind + data +
                struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))
    raw = b"".join(b"\x00" + r for r in rows)
    return (b"\x89PNG\r\n\x1a\n" +
            chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) +
            chunk(b"IDAT", zlib.compress(raw, 9)) +
            chunk(b"IEND", b""))


def ico(images):
    """An .ico holding PNG images (fine for Windows Vista and later)."""
    out = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    data = b""
    for size, img in images:
        dim = 0 if size >= 256 else size
        out += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(img), offset + len(data))
        data += img
    return out + data


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    vb, pts, rgb, width = read_favicon(sys.argv[1])
    rects = stroke_rects(pts, width)
    images = [(s, png(s, render(s, vb, rects, rgb))) for s in SIZES]
    with open(sys.argv[2], "wb") as f:
        f.write(ico(images))


if __name__ == "__main__":
    main()
