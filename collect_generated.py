#!/usr/bin/env python3
"""생성한 예문 조각들을 하나로 모으고 검증한다.

교재에 예문이 없는 단어(대부분 '토익 만점 완성' 단)를 위해 만든 예문이다.
원본이 아니므로 데이터에 generated 표시를 남기고 앱에서도 구분해 보여준다.

    python3 collect_generated.py
"""

import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).parent
GEN_DIR = ROOT / "data" / "generated"
OUT = ROOT / "data" / "generated_examples.json"

HANGUL = re.compile(r"[가-힣]")


def stem(headword):
    """표제어 검사용 어간.

    'motorcycle(=motorbike)' 같은 변형 표기는 앞쪽만 쓰고, 'be entitled to'처럼
    be로 시작하면 다음 단어를 본다. 불규칙 활용(shake->shook)까지는 못 잡으므로
    걸린 항목은 사람이 확인하는 후보 목록으로 쓴다.
    """
    head = re.split(r"[(\[=/]", headword)[0].strip().lower()
    tokens = [t for t in re.sub(r"[^a-z ]", " ", head).split() if t]
    if tokens and tokens[0] == "be" and len(tokens) > 1:
        tokens = tokens[1:]
    if not tokens:
        return ""
    first = tokens[0]
    return first[:max(4, len(first) - 2)] if len(first) >= 4 else first


def main():
    merged = json.loads((ROOT / "data" / "merged.json").read_text(encoding="utf-8"))
    words = {w["id"]: w for d in merged["days"] for w in d["words"]}
    need = {wid for wid, w in words.items() if not w["examples"]}

    collected, problems = {}, Counter()
    samples = {"missing_word": [], "no_korean": [], "too_short": [], "too_long": []}

    for path in sorted(GEN_DIR.glob("output-*.json")):
        try:
            rows = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            print(f"  ! {path.name} JSON 오류: {e}")
            problems["bad_json"] += 1
            continue

        for row in rows:
            wid, en, ko = row.get("id"), (row.get("en") or "").strip(), (row.get("ko") or "").strip()
            if wid not in words:
                problems["unknown_id"] += 1
                continue
            if not en or not ko:
                problems["empty"] += 1
                continue

            w = words[wid]
            n_words = len(en.split())
            if not HANGUL.search(ko):
                problems["no_korean"] += 1
                samples["no_korean"].append((wid, ko[:40]))
                continue
            if n_words < 5:
                problems["too_short"] += 1
                samples["too_short"].append((wid, en))
                continue
            if n_words > 24:
                problems["too_long"] += 1
                samples["too_long"].append((wid, en[:60]))

            st = stem(w["headword"])
            if st and st not in re.sub(r"[^a-z]", "", en.lower()):
                problems["missing_word"] += 1
                if len(samples["missing_word"]) < 12:
                    samples["missing_word"].append((wid, w["headword"], en[:60]))

            collected[wid] = {"en": en, "ko": ko}

    print(f"수집: {len(collected)}개 / 필요 {len(need)}개")
    missing = need - set(collected)
    print(f"아직 없는 단어: {len(missing)}개")
    if missing:
        by_day = Counter(int(m[1:3]) for m in missing)
        print("  DAY별:", dict(sorted(by_day.items())))
    extra = set(collected) - need
    if extra:
        print(f"  이미 예문이 있는데 생성된 것: {len(extra)}개 (버림)")
        for wid in extra:
            collected.pop(wid, None)

    if problems:
        print("\n점검:")
        for k, v in problems.most_common():
            print(f"  {k}: {v}")
        for key, label in [("missing_word", "표제어가 예문에 없음"),
                           ("no_korean", "한글 해석 없음"), ("too_short", "너무 짧음")]:
            if samples[key]:
                print(f"  [{label}] 예시")
                for s in samples[key][:6]:
                    print(f"    {s}")

    OUT.write_text(json.dumps(collected, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n저장: {OUT} ({len(collected)}개)")


if __name__ == "__main__":
    main()
