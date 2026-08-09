"""Generate the source app icon (no external image libraries required).

Draws a rounded dark tile with a terminal prompt glyph (`>_`) in the accent
colour, then writes it as a PNG using only zlib + struct from the stdlib.
"""

import math
import struct
import sys
import zlib

SIZE = 1024
BG = (26, 27, 38)  # Tokyo Night background
FG = (122, 162, 247)  # accent blue
FG2 = (158, 206, 106)  # accent green
RADIUS = 200


def blend(dst, src, alpha):
    return tuple(int(d + (s - d) * alpha) for d, s in zip(dst, src))


def rounded_alpha(x, y, size, radius):
    """Anti-aliased coverage of a rounded square at pixel (x, y)."""
    cx = min(max(x, radius), size - radius)
    cy = min(max(y, radius), size - radius)
    dx, dy = x - cx, y - cy
    dist = math.hypot(dx, dy)
    return max(0.0, min(1.0, radius - dist + 0.5))


def line_alpha(px, py, x1, y1, x2, y2, width):
    """Coverage of a thick line segment, for the chevron and underscore."""
    vx, vy = x2 - x1, y2 - y1
    length_sq = vx * vx + vy * vy
    if length_sq == 0:
        dist = math.hypot(px - x1, py - y1)
    else:
        t = max(0.0, min(1.0, ((px - x1) * vx + (py - y1) * vy) / length_sq))
        dist = math.hypot(px - (x1 + t * vx), py - (y1 + t * vy))
    return max(0.0, min(1.0, width / 2 - dist + 0.5))


def build_rows():
    # Chevron ">" and underscore "_", laid out on a 1024 grid.
    cx1, cy1 = 300, 300
    cx2, cy2 = 520, 512
    cx3, cy3 = 300, 724
    ux1, uy1 = 570, 724
    ux2, uy2 = 780, 724
    stroke = 74

    rows = []
    for y in range(SIZE):
        row = bytearray()
        row.append(0)  # PNG filter type: none
        for x in range(SIZE):
            tile = rounded_alpha(x, y, SIZE, RADIUS)
            if tile <= 0:
                row.extend((0, 0, 0, 0))
                continue

            color = BG
            a = max(
                line_alpha(x, y, cx1, cy1, cx2, cy2, stroke),
                line_alpha(x, y, cx2, cy2, cx3, cy3, stroke),
            )
            if a > 0:
                color = blend(color, FG, a)
            b = line_alpha(x, y, ux1, uy1, ux2, uy2, stroke)
            if b > 0:
                color = blend(color, FG2, b)

            row.extend((color[0], color[1], color[2], int(tile * 255)))
        rows.append(bytes(row))
    return b"".join(rows)


def chunk(tag, data):
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def main(path):
    raw = build_rows()
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as fh:
        fh.write(png)
    print(f"wrote {path} ({len(png) / 1024:.1f} KiB)")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "app-icon.png")
