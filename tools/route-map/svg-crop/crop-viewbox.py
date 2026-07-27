#!/usr/bin/env python3
"""오너 SVG 루트 `<svg>`의 viewBox/width/height만 바꾼다(#2603).

그 밖의 바이트가 한 바이트라도 달라지면 쓰지 않고 던진다 — 크롭이 좌표를
건드리지 않았다는 주장을 도구 차원에서 강제하기 위해서다.

경로는 인자로 받지 않고 권역 id로만 해석한다(regions.mjs 주석 참조).

사용법:
  python3 tools/route-map/svg-crop/crop-viewbox.py <region> <x> <y> <w> <h> [--dry]
"""
import math
import os
import re
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_SVG_DIR = os.path.join(_HERE, "..", "route-map-defs", "svg-sources")

REGIONS = {
    "seoul": "easy-subway-sma-v4.svg",
    "busan": "easy-subway-busan-v3.svg",
    "daegu": "easy-subway-daegu-v3.svg",
    "daejeon": "easy-subway-daejeon-v3.svg",
    "gwangju": "easy-subway-gwangju-v3.svg",
}


def svg_path_for(region: str) -> str:
    """권역 id → 오너 SVG 절대경로. 모르는 id는 던진다."""
    if region not in REGIONS:
        raise ValueError(
            "알 수 없는 권역 %r — %s 중 하나여야 합니다."
            % (region, ", ".join(sorted(REGIONS)))
        )
    return os.path.normpath(os.path.join(_SVG_DIR, REGIONS[region]))


def root_tag_span(text: str):
    """루트 `<svg …>` 여는 태그의 [시작, 끝) 인덱스."""
    start = text.index("<svg")
    cursor = start
    quote = None
    while cursor < len(text):
        ch = text[cursor]
        if quote:
            if ch == quote:
                quote = None
        elif ch in "\"'":
            quote = ch
        elif ch == ">":
            return start, cursor + 1
        cursor += 1
    raise ValueError("루트 <svg> 여는 태그가 닫히지 않았습니다.")


def fmt(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else repr(value)


def crop(region: str, x, y, w, h, dry: bool = False) -> str:
    if not all(math.isfinite(value) for value in (x, y, w, h)):
        raise ValueError("viewBox 값은 모두 유한수여야 합니다.")
    if w <= 0 or h <= 0:
        raise ValueError("viewBox width/height는 0보다 커야 합니다.")
    path = svg_path_for(region)
    with open(path, "r", encoding="utf-8") as handle:
        text = handle.read()

    start, end = root_tag_span(text)
    head, tag, tail = text[:start], text[start:end], text[end:]

    new_tag, n_vb = re.subn(
        r'viewBox\s*=\s*"[^"]*"',
        'viewBox="%s %s %s %s"' % (fmt(x), fmt(y), fmt(w), fmt(h)),
        tag,
        count=1,
    )
    if n_vb != 1:
        raise ValueError("%s: 루트 태그에 viewBox가 없습니다." % region)

    new_tag, n_w = re.subn(r'\bwidth\s*=\s*"[^"]*"', 'width="%s"' % fmt(w), new_tag, count=1)
    new_tag, n_h = re.subn(r'\bheight\s*=\s*"[^"]*"', 'height="%s"' % fmt(h), new_tag, count=1)
    if n_w != 1 or n_h != 1:
        raise ValueError(
            "%s: 루트 태그에 width/height가 없습니다(w=%d h=%d)." % (region, n_w, n_h)
        )

    out = head + new_tag + tail
    # 불변식: 루트 여는 태그 밖은 한 바이트도 바뀌지 않는다.
    if out[:start] != head or out[start + len(new_tag):] != tail:
        raise AssertionError("%s: 루트 태그 밖 바이트가 바뀌었습니다 — 쓰지 않습니다." % region)

    if not dry:
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(out)
    return new_tag


def main(argv):
    if len(argv) < 6:
        print(__doc__, file=sys.stderr)
        return 2
    region = argv[1]
    x, y, w, h = (float(v) for v in argv[2:6])
    print(crop(region, x, y, w, h, dry="--dry" in argv))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
