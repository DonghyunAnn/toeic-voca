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

# 원본 PDF가 모바일 레이아웃 폭에 맞추면서 긴 뜻을 잘라버렸다. 텍스트 레이어까지
# 잘려 있어 추출 방식을 바꿔도 복구되지 않는다(페이지를 렌더링해 눈으로 확인했다).
# 어간으로 끝나 말이 되지 않는 것만 손으로 채운다. '부지', '금지'처럼 명사로
# 끝나는 것은 멀쩡하므로 건드리지 않는다.
TRUNCATED_FIXES = {
    "(영양소나 성분을) 강화하": "(영양소나 성분을) 강화하다",
    "인상적인, 감정을 자극하": "인상적인, 감정을 자극하는",
    "가구를 비치하다, 제공하": "가구를 비치하다, 제공하다",
    "친화적인 환경을 조성하": "친화적인 환경을 조성하다",
    "가정의, 가정에서 사용하": "가정의, 가정에서 사용하는",
    "실망시키다, 경악하게 하": "실망시키다, 경악하게 하다",
    "원하지 않는, 바람직하지": "원하지 않는, 바람직하지 않은",
    "되풀이하다, 반복해서 말": "되풀이하다, 반복해서 말하다",
    "부끄러워하는, 수줍어하": "부끄러워하는, 수줍어하는",
    "청각 장애가 있는, 듣지": "청각 장애가 있는, 듣지 못하는",
    "귀를 기울이지 않는, 무시": "귀를 기울이지 않는, 무시하는",
    "매우 지친, 기운이 다 빠": "매우 지친, 기운이 다 빠진",
    "(머리카락, 수염 등을) 깎": "(머리카락, 수염 등을) 깎다",
    "권한을 부여하다, 위임하": "권한을 부여하다, 위임하다",
    "특정 요구에 맞게 조정하": "특정 요구에 맞게 조정하다",
    "현금으로 바꾸다(환전하": "현금으로 바꾸다(환전하다)",
    "시간이나 주의를 차지하": "시간이나 주의를 차지하다",
    "(사람과) 어울리다, 교제하": "(사람과) 어울리다, 교제하다",
    "(세금, 규제 등을) 부과하": "(세금, 규제 등을) 부과하다",
    "(사실이나 잘못을) 인정하": "(사실이나 잘못을) 인정하다",
    "목표로 하다, ~을 지향하": "목표로 하다, ~을 지향하다",
    "(목표, 수준 등에) 도달하": "(목표, 수준 등에) 도달하다",
    "~에 대한 백신을 접종하": "~에 대한 백신을 접종하다",
    "사업이나 활동을 중단하": "사업이나 활동을 중단하다",
    "(수준이나 양을) 증가시키": "(수준이나 양을) 증가시키다",
    "강력히 권고하다, 촉구하": "강력히 권고하다, 촉구하다",
    "(체중, 속도 등이) 증가하": "(체중, 속도 등이) 증가하다",
    "자발적으로 하다, 자원하": "자발적으로 하다, 자원하다",
}

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
            meaning = TRUNCATED_FIXES.get(meaning, meaning)
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
    fixed = sum(1 for w in words for s in w["senses"] if s["meaning"] in TRUNCATED_FIXES.values())
    print(f"  잘린 뜻 교정: {fixed}건")
    if missing:
        print(f"  ! 번호 누락 {len(missing)}건: {missing[:10]}")
    print(f"저장: {args.out}")


if __name__ == "__main__":
    main()
