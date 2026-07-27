#!/usr/bin/env python3
"""크롭 전후 렌더를 비교해 **잉크가 하나도 잘리지 않았음**을 증명한다(#2603).

`render-svg.mjs --ink`가 `.out/`에 남긴 두 PNG(투명 배경·장식 숨김)를 비교한다.
검사 항목은 셋이다.

1. 크롭 창 안의 픽셀이 바이트 단위로 같은가 — viewBox 원점을 0으로 두면 래스터
   격자가 어긋나지 않아 완전 동일이 나온다(#2603 실측: 5권역 전부 동일).
2. 1픽셀 팽창 허용 비교 — 원점이 0이 아닌 크롭을 검토할 때는 안티에일리어싱
   위상이 달라져 1번이 깨질 수 있다. 그때도 서로 1픽셀 안에 들어오는지 본다.
3. 크롭 창 **밖**에 잉크가 남아 있지 않은가 — 남아 있으면 그게 잘려나간 잉크다.

경로는 인자로 받지 않고 권역 id와 ref로 `.out/` 안에서 해석한다.

사용법:
  node tools/route-map/svg-crop/render-svg.mjs gwangju --ref origin/main --ink
  node tools/route-map/svg-crop/render-svg.mjs gwangju --ink
  python3 tools/route-map/svg-crop/verify-ink-lossless.py gwangju --before-ref origin/main
"""
import argparse
import os
import re
import sys

from PIL import Image, ImageChops, ImageFilter

Image.MAX_IMAGE_PIXELS = None

_HERE = os.path.dirname(os.path.abspath(__file__))
_OUT_DIR = os.path.join(_HERE, ".out")
_REGIONS = ("seoul", "busan", "daegu", "daejeon", "gwangju")


def out_png(region: str, ref: str) -> str:
    """`.out/` 안의 렌더 산출물 경로. 저장소 밖을 가리킬 수 없다."""
    if region not in _REGIONS:
        raise ValueError("알 수 없는 권역 %r — %s" % (region, ", ".join(_REGIONS)))
    stem = "%s-%s-ink.png" % (region, re.sub(r"[^\w.-]", "_", ref))
    return os.path.join(_OUT_DIR, stem)


def alpha_mask(image):
    return image.getchannel("A").point(lambda v: 255 if v else 0)


def count(mask):
    return sum(1 for v in mask.get_flattened_data() if v)


def main():
    parser = argparse.ArgumentParser(description="크롭 전후 잉크 무손실 검증")
    parser.add_argument("region", choices=_REGIONS)
    parser.add_argument(
        "--before-ref",
        default="origin/main",
        help="크롭 전 렌더의 git ref (기본 origin/main)",
    )
    parser.add_argument(
        "--offset",
        nargs=2,
        type=int,
        default=[0, 0],
        metavar=("X", "Y"),
        help="크롭 박스 좌상단(픽셀). 우·하단만 자르면 0 0.",
    )
    args = parser.parse_args()

    before_path = out_png(args.region, args.before_ref)
    after_path = out_png(args.region, "working")
    for path in (before_path, after_path):
        if not os.path.exists(path):
            print("렌더 산출물이 없습니다: %s" % path, file=sys.stderr)
            print("먼저 render-svg.mjs를 --ink로 돌리세요.", file=sys.stderr)
            return 2

    before = Image.open(before_path).convert("RGBA")
    after = Image.open(after_path).convert("RGBA")
    left, top = args.offset

    if left + after.width > before.width or top + after.height > before.height:
        print("크롭 창이 원본 밖으로 나갑니다 — offset이나 배율을 확인하세요.", file=sys.stderr)
        return 2

    window = before.crop((left, top, left + after.width, top + after.height))
    identical = window.tobytes() == after.tobytes()

    mask_before = alpha_mask(window)
    mask_after = alpha_mask(after)

    lost = count(ImageChops.subtract(mask_before, mask_after.filter(ImageFilter.MaxFilter(3))))
    added = count(ImageChops.subtract(mask_after, mask_before.filter(ImageFilter.MaxFilter(3))))

    full = alpha_mask(before)
    full.paste(0, (left, top, left + after.width, top + after.height))
    outside = count(full)

    print("크롭 창 픽셀 완전 동일 : %s" % identical)
    print("잉크 픽셀 before/after : %s / %s" % (f"{count(mask_before):,}", f"{count(mask_after):,}"))
    print("1px 팽창 허용 손실/추가: %s / %s" % (f"{lost:,}", f"{added:,}"))
    print("크롭 창 밖 잔여 잉크    : %s" % f"{outside:,}")

    ok = lost == 0 and added == 0 and outside == 0
    print()
    print("RESULT:", "PASS — 잉크 무손실" if ok else "FAIL — 잉크가 잘렸습니다")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
