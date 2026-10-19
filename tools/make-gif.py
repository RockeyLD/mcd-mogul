#!/usr/bin/env python3
"""把 tools/shoot-gif.js 采到的帧合成 GIF。

用法:
  python tools/make-gif.py [-o out.gif] [-s shots] [-w 640] [-c 128] [-f 10] [-n 45]
                           [--top 0] [--bot 0] [--all]

  -n / --len   只保留状态最好的一段连续帧（默认 45 帧，0 表示全用）
               打分依据是采集时探到的现场状态（票架张数 / 切了几个工位 / 出餐架有没有货）,
               避免 GIF 里出现"空店"或只在同一个工位打转的片段。

图像处理三条，都是为了不糊:
  1. 从所有帧里统计一张全局调色板，逐帧复用 —— 不然每帧各自量化，切换时会闪
  2. 关掉抖动（dither）—— 扁平色块的 UI 加抖动只会长麻点
  3. 先缩放再量化 —— 顺序反了会把抗锯齿边缘压成杂色
"""
import sys, os, json, glob, argparse
from PIL import Image


def score_window(meta, start, length):
    seg = meta[start:start + length]
    if len(seg) < length:
        return -1
    tickets = sum(min(m.get('tk') or 0, 3) for m in seg)
    empty = sum(1 for m in seg if not (m.get('tk') or 0))
    tabs = len({m.get('tab') for m in seg if m.get('tab')})
    shelf = sum(1 for m in seg if (m.get('shelf') or 0) > 0)
    # 空店帧是硬伤（一个扣 10 分）；切过的工位每种 +8（这是"手忙脚乱"的证据）；
    # 出餐架有货 +2/帧，说明产线真的在运转
    return tickets * 2 + tabs * 8 + shelf * 2 - empty * 10


def pick_window(meta, length):
    if not meta or length <= 0 or length >= len(meta):
        return 0, len(meta)
    best, best_s = 0, -1e9
    for s in range(0, len(meta) - length + 1):
        sc = score_window(meta, s, length)
        if sc > best_s:
            best_s, best = sc, s
    return best, best + length


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('-o', '--out', default='docs/demo.gif')
    ap.add_argument('-s', '--src', default='shots')
    ap.add_argument('-w', '--width', type=int, default=640)
    ap.add_argument('-c', '--colors', type=int, default=128)
    ap.add_argument('-f', '--fps', type=int, default=10)
    ap.add_argument('-n', '--len', type=int, default=45)
    ap.add_argument('--top', type=int, default=0)
    ap.add_argument('--bot', type=int, default=0)
    ap.add_argument('--all', action='store_true')
    ap.add_argument('--start', type=int, default=-1,
                    help='手动指定起始帧（-1 = 自动挑窗口）。自动挑可能选中一段全是同一个工位的画面')
    a = ap.parse_args()

    files = sorted(glob.glob(os.path.join(a.src, 'f_*.png')))
    if not files:
        print('✗ %s 里没有帧' % a.src)
        return 1

    meta = []
    mf = os.path.join(a.src, 'meta.json')
    if os.path.exists(mf):
        try:
            meta = json.load(open(mf))
        except Exception:
            meta = []

    if a.start >= 0:
        lo, hi = a.start, min(a.start + a.len, len(files))
    else:
        lo, hi = (0, len(files)) if a.all else pick_window(meta, a.len)
    if not a.all and meta:
        print('  选中第 %d~%d 帧（共 %d 帧）：%s' % (
            lo, hi - 1, len(files),
            ' '.join('票%d/%s' % ((m.get('tk') or 0), m.get('tab') or '-') for m in meta[lo:hi][::6])))
    files = files[lo:hi]

    frames = []
    for f in files:
        im = Image.open(f).convert('RGB')
        if a.top or a.bot:
            im = im.crop((0, a.top, im.width, im.height - a.bot))
        w = a.width
        h = round(im.height * w / im.width)
        frames.append(im.resize((w, h), Image.LANCZOS))
    H = frames[0].height

    # 全局调色板：所有帧拼成一张图再统计颜色
    cols = 6
    rows = (len(frames) + cols - 1) // cols
    sheet = Image.new('RGB', (w * cols, H * rows), (255, 255, 255))
    for i, im in enumerate(frames):
        sheet.paste(im, ((i % cols) * w, (i // cols) * H))
    palette = sheet.quantize(colors=a.colors, method=Image.MEDIANCUT)

    pframes = [im.quantize(palette=palette, dither=Image.NONE) for im in frames]

    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    pframes[0].save(
        a.out, save_all=True, append_images=pframes[1:],
        duration=int(1000 / a.fps), loop=0, optimize=True, disposal=2,
    )

    kb = os.path.getsize(a.out) / 1024
    print('✓ %s  %d 帧  %dx%d  %d 色  %.1ffps  %.1fs  %.0f KB (%.2f MB)' % (
        a.out, len(pframes), w, H, a.colors, a.fps, len(pframes) / a.fps, kb, kb / 1024))
    return 0


if __name__ == '__main__':
    sys.exit(main())
