#!/usr/bin/env python3
"""真扫一遍海报上的两个二维码 —— 不是"应该能扫"，是真的解码出来比对。

用法:
    python tools/verify-poster.py poster/poster.png
    python tools/verify-poster.py poster/poster.jpg

海报上两个码用途不同，两个都得能扫：
    大码 → https://github.com/RockeyLD/mcd-mogul   去点 Star（决定排名）
    小码 → https://rockeyld.github.io/mcd-mogul/   先玩一局

做法：按已知坐标把两块各自裁出来单独解码。
不用 detectAndDecodeMulti —— cv2 5.0 上它在整图里只吐一个码，
剩下的靠猜，比逐个裁要不可靠得多。
"""
import sys
from pathlib import Path

import cv2

W, H = 2160, 2880   # 2 倍导出

# 标签 -> (期望地址, 裁切框 x1,y1,x2,y2)
# 坐标按 2160×2880 实际渲染结果量的，码边缘留了 ~20px 余量
REGIONS = {
    "大码 · 点 Star": ("https://github.com/RockeyLD/mcd-mogul", (200, 2140, 580, 2540)),
    "小码 · 试玩": ("https://rockeyld.github.io/mcd-mogul/", (1748, 2204, 1968, 2424)),
}


def norm(u: str) -> str:
    return u.strip().rstrip("/")


def main() -> None:
    src = Path(sys.argv[1] if len(sys.argv) > 1 else "poster/poster.png")
    if not src.exists():
        sys.exit(f"✗ 找不到 {src}")

    img = cv2.imread(str(src))
    if img is None:
        sys.exit(f"✗ 读不了 {src}")
    h, w = img.shape[:2]
    print(f"图像 {w}×{h}  ({src.stat().st_size / 1024:.0f} KB)")

    if (w, h) != (W, H):
        print(f"✗ 尺寸 {w}×{h} 不是 {W}×{H}，坐标会全部错位")
        sys.exit(1)
    if abs(w / h - 3 / 4) > 0.005:
        print(f"✗ 比例不是 3:4，朋友圈会被裁：{w / h:.4f}")
        sys.exit(1)

    det = cv2.QRCodeDetector()
    bad = 0

    for label, (want, (x1, y1, x2, y2)) in REGIONS.items():
        crop = img[y1:y2, x1:x2]
        if crop.size == 0:
            print(f"  ✗ {label}: 裁切框超出图像")
            bad += 1
            continue
        got, _, _ = det.detectAndDecode(crop)
        if not got:
            print(f"  ✗ {label}: 扫不出来（框内 {crop.shape[1]}×{crop.shape[0]}）")
            bad += 1
        elif norm(got) != norm(want):
            print(f"  ✗ {label}: 扫出 {got}，但不是 {want}")
            bad += 1
        else:
            print(f"  ✓ {label}: {got}")

    if bad:
        print(f"✗ {bad} 个二维码没通过")
        sys.exit(1)
    print("✓ 两个码都能扫，指向正确")


if __name__ == "__main__":
    main()
