#!/usr/bin/env python3
"""生成海报用的二维码（SVG）。

用法:
    python tools/make-qr.py                     # 默认指向线上试玩页
    python tools/make-qr.py <url> <out.svg>

输出纯 path 的 SVG，不依赖字体/位图，塞进海报任意放大都不糊。
配色走海报的深墨 #2C2118，白底，留足 4 模块 quiet zone。
"""
import sys
from pathlib import Path

import qrcode
from qrcode.image.svg import SvgPathImage

URL = sys.argv[1] if len(sys.argv) > 1 else "https://rockeyld.github.io/mcd-mogul/"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "poster/qr.svg")

INK = "#2C2118"
BOX = 10   # 每个模块 10 单位
BORDER = 4  # QR 规范要求的 4 模块静区


def build(url: str) -> str:
    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=BOX,
        border=BORDER,
    )
    qr.add_data(url)
    qr.make(fit=True)
    n = qr.modules_count
    side = (n + BORDER * 2) * BOX

    # 自己拼 path：只写黑模块，白底交给 rect
    rects = []
    for y, row in enumerate(qr.modules):
        x = 0
        while x < n:
            if not row[x]:
                x += 1
                continue
            run = 1
            while x + run < n and row[x + run]:
                run += 1
            # 合并同行的连续黑块，SVG 体积能小一半
            rects.append(
                f'<rect x="{(x + BORDER) * BOX}" y="{(y + BORDER) * BOX}" '
                f'width="{run * BOX}" height="{BOX}"/>'
            )
            x += run

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{side}" height="{side}" '
        f'viewBox="0 0 {side} {side}" shape-rendering="crispEdges">'
        f'<rect width="{side}" height="{side}" fill="#fff"/>'
        f'<g fill="{INK}">{"".join(rects)}</g>'
        f"</svg>"
    )


def main() -> None:
    if not URL.startswith("https://"):
        sys.exit(f"URL 必须是 https，收到: {URL!r}")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    svg = build(URL)
    OUT.write_text(svg, encoding="utf-8")
    print(f"✓ {OUT}  ({len(svg)} bytes)")
    print(f"  指向: {URL}")


if __name__ == "__main__":
    main()
