#!/usr/bin/env python3
"""모바일 단어장 PDF에서 단어를 뽑는다.

번호만 매겨진 단일 목록이고 대략 빈도순이다. 예문도 발음도 없다.
ETS 교재와 절반쯤 겹치므로 겹치지 않는 것만 '추가' 등급으로 쓴다.

    python3 pdf_deck.py "~/Downloads/토익-단어장-PDF-for-Mobile-All.pdf"

pdftotext(poppler)가 필요하다. 결과를 data/extra-voca.json으로 저장해두면
그 뒤로는 PDF 없이 merge.py가 돈다.
"""

import argparse
import json
import re
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).parent
OUT_JSON = ROOT / "data" / "extra-voca.json"

# 한글 품사 표기를 나머지 데이터와 같은 형태로 맞춘다
POS_MAP = {"명": "n.", "동": "v.", "형": "a.", "부": "ad.",
           "전": "prep.", "접": "conj.", "구": "phr.", "숙": "phr."}

SENSE_RE = re.compile(r"\((명|동|형|부|전|접|구|숙)\)\s*(.+)")
NUM_RE = re.compile(r"^\d{1,4}$")
NOISE = re.compile(r"^\d+/\d+$|dokjongban|토익 단어장 앱")


def extract_text(pdf_path):
    with tempfile.NamedTemporaryFile(suffix=".txt", delete=False) as tmp:
        out = tmp.name
    try:
        subprocess.run(["pdftotext", "-layout", str(pdf_path), out],
                       check=True, capture_output=True)
        return Path(out).read_text(encoding="utf-8")
    except FileNotFoundError:
        raise SystemExit("pdftotext가 없습니다. brew install poppler 로 설치하세요.")
    finally:
        Path(out).unlink(missing_ok=True)


def parse(text):
    """[{no, headword, senses}] 를 번호 순서대로."""
    words, cur = [], None
    for raw in text.split("\n"):
        line = raw.strip()
        if not line or NOISE.search(line):
            continue

        if NUM_RE.fullmatch(line):
            cur = {"no": int(line), "headword": None, "senses": []}
            words.append(cur)
            continue
        if cur is None:
            continue

        m = SENSE_RE.search(line)
        if m:
            head = line[:m.start()].strip()
            if head and not cur["headword"]:
                cur["headword"] = head
            meaning = m.group(2).strip()
            if meaning:
                cur["senses"].append({"pos": POS_MAP[m.group(1)], "meaning": meaning})
        elif not cur["headword"] and re.search(r"[A-Za-z]", line):
            cur["headword"] = line

    return [w for w in words if w["headword"] and w["senses"]]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--out", default=str(OUT_JSON))
    args = ap.parse_args()

    words = parse(extract_text(Path(args.pdf).expanduser()))
    nums = [w["no"] for w in words]
    missing = sorted(set(range(1, max(nums) + 1)) - set(nums)) if nums else []

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(words, ensure_ascii=False, indent=0), encoding="utf-8")

    print(f"단어 {len(words)}개 (번호 {min(nums)}~{max(nums)})")
    print(f"  뜻이 둘 이상: {sum(1 for w in words if len(w['senses']) > 1)}개")
    if missing:
        print(f"  ! 번호 누락 {len(missing)}건: {missing[:10]}")
    print(f"저장: {args.out}")


if __name__ == "__main__":
    main()
