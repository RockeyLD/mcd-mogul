#!/usr/bin/env python3
"""真扫一遍海报上的二维码 —— 不是"应该能扫"，是真的解码出来比对。

用法:
    python tools/verify-poster.py poster/poster.png
    python tools/verify-poster.py poster/poster.jpg

做三件事：
  1. 校验图像尺寸与 3:4 比例
  2. 用 OpenCV 在整图里找二维码并解码
  3. 解码结果必须等于线上试玩地址，否则退出码 1
"""
import sys
from pathlib import Path

import cv2

EXPECT = "https://rockeyld.github.io/mcd-mogul/"
W, H = 2160, 2880   # 2 倍导出


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
        print(f"⚠ 尺寸与预期 {W}×{H} 不同（缩放版本？继续扫）")
    if abs(w / h - 3 / 4) > 0.005:
        print(f"✗ 比例不是 3:4，朋友圈会被裁：{w / h:.4f}")
        sys.exit(1)

    det = cv2.QRCodeDetector()

    # 先整图扫
    ok, pts = det.detect(img)
    data, _, _ = det.detectAndDecode(img)

    if not data:
        # 整图扫不到就把左侧二维码区裁出来再试（海报里它只占 ~9%）
        crop = img[int(1020 * 2):int(1290 * 2), int(60 * 2):int(360 * 2)]
        cv2.imwrite("/tmp/mcd-qr-crop.png", crop)
        data, _, _ = det.detectAndDecode(crop)
        print("整图没解出，已裁二维码区域重试")

    if not data:
        print("✗ 扫不出来 —— 二维码太小 / 对比度不够 / 被压缩糊了")
        sys.exit(1)

    print(f"扫码结果: {data}")
    if data.rstrip("/") != EXPECT.rstrip("/"):
        print(f"✗ 内容不对，期望 {EXPECT}")
        sys.exit(1)

    print("✓ 二维码可扫，指向正确")


if __name__ == "__main__":
    main()
