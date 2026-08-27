#!/usr/bin/env python3
"""PWA 아이콘 생성. 외부 라이브러리 없이 PNG를 직접 쓴다."""

import struct
import zlib
from pathlib import Path

BG = (9, 9, 11)
FG = (250, 250, 250)
OUT = Path(__file__).parent / "docs" / "icons"


def write_png(path, size, pixels):
    raw = b"".join(b"\x00" + bytes(v for px in row for v in px) for row in pixels)

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    body = (chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + body)


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    return ((px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2) ** 0.5


def render(size, safe=1.0):
    """V 자를 두 개의 굵은 선분으로 그린다. safe는 마스커블 여백 비율."""
    half = 0.5
    thick = 0.085 * safe
    aa = 1.5 / size

    # V 꼭짓점 (0~1 정규 좌표)
    ax, ay = half - 0.20 * safe, half - 0.20 * safe
    cx, cy = half,               half + 0.21 * safe
    bx, by = half + 0.20 * safe, half - 0.20 * safe

    rows = []
    for y in range(size):
        py = (y + 0.5) / size
        row = []
        for x in range(size):
            px = (x + 0.5) / size
            d = min(seg_dist(px, py, ax, ay, cx, cy),
                    seg_dist(px, py, cx, cy, bx, by))
            # 경계에서 부드럽게 섞는다
            a = max(0.0, min(1.0, (thick - d) / aa + 0.5))
            row.append(tuple(round(BG[i] + (FG[i] - BG[i]) * a) for i in range(3)))
        rows.append(row)
    return rows


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for size, safe, name in [(192, 1.0, "icon-192.png"),
                             (512, 1.0, "icon-512.png"),
                             (512, 0.72, "icon-maskable.png")]:
        write_png(OUT / name, size, render(size, safe))
        print(f"  {name}  {(OUT / name).stat().st_size // 1024}KB")


if __name__ == "__main__":
    main()
