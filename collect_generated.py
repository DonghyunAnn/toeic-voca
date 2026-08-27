#!/usr/bin/env python3
"""생성한 예문 조각들을 하나로 모으고 검증한다.

교재에 예문이 없는 단어(대부분 '토익 만점 완성' 단)를 위해 만든 예문이다.
원본이 아니므로 데이터에 generated 표시를 남기고 앱에서도 구분해 보여준다.

    python3 collect_generated.py
"""

import json
import re
import sys
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
    # 이미 생성 예문이 붙어 있는 단어도 '필요' 목록에 남겨둔다. 그러지 않으면
    # 두 번째 실행에서 지난번 결과를 통째로 버린다.
    need = {wid for wid, w in words.items()
            if not w["examples"] or w["examples"][0].get("generated")}

    # id는 바뀔 수 있다(악센트 접기, 추가 등급의 DAY 이동). 표제어로도 찾을 수
    # 있게 해두면 그때마다 예문을 다시 만들지 않아도 된다.
    by_head = {}
    for wid in need:
        key = re.sub(r"[^a-z0-9]+", "-", words[wid]["headword"].lower()).strip("-")
        by_head.setdefault(key, wid)

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
            # 예전에 HTML 엔티티가 그대로 id에 들어간 적이 있다(one&#x27;s -> one-x27-s).
            # 그때 만든 예문을 버리지 않도록 새 id로 옮겨 붙인다.
            if wid not in words and "-x27-" in (wid or ""):
                fixed = wid.replace("-x27-", "-")
                if fixed in words:
                    wid = fixed
            if wid not in words and wid:
                # d31-patronage -> patronage 처럼 DAY를 떼고 표제어로 찾는다
                tail = re.sub(r"^[a-z]?\d*-", "", wid)
                if tail in by_head:
                    wid = by_head[tail]
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
        print(f"  교재 예문이 이미 있어 쓰지 않는 것: {len(extra)}개")
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

    if not collected:
        # 조각 파일을 옮겨두고 실행하면 기존 예문 수천 개가 통째로 날아간다
        print("\n수집된 예문이 없습니다. 기존 파일을 그대로 둡니다.")
        sys.exit(1)
    OUT.write_text(json.dumps(collected, ensure_ascii=False,
                                separators=(",", ":")), encoding="utf-8")
    print(f"\n저장: {OUT} ({len(collected)}개)")


if __name__ == "__main__":
    main()
