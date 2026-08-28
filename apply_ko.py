#!/usr/bin/env python3
"""번역한 해석을 예문에 채워 넣는다.

블로그 원문에 해석이 안 딸려온 예문이 1,440개 있었다. 영어 문장은 원문
그대로이고 해석만 우리가 붙인 것이라, koGen 표시를 남겨 구분할 수 있게 한다.
"""

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent
KO = ROOT / "data" / "ko"


def load_pairs():
    pairs, dupes = {}, 0
    for f in sorted(KO.glob("out-*.json")):
        rows = json.loads(f.read_text(encoding="utf-8"))
        for r in rows:
            k, ko = r.get("k"), (r.get("ko") or "").strip()
            if not k or not ko:
                sys.exit(f"{f.name}: 비어 있는 항목 {r!r}")
            if k in pairs:
                dupes += 1
            pairs[k] = ko
    if dupes:
        print(f"  경고: 키 중복 {dupes}건 (뒤엣것으로 덮음)")
    return pairs


def main():
    pairs = load_pairs()
    print(f"번역 {len(pairs)}개 읽음")

    for name, mini in [("docs/words.json", True), ("data/merged.json", False)]:
        p = ROOT / name
        d = json.loads(p.read_text(encoding="utf-8"))
        filled = missed = 0
        for day in d["days"]:
            for w in day["words"]:
                for i, e in enumerate(w["examples"]):
                    if e.get("ko"):
                        continue
                    ko = pairs.get(f"{w['id']}#{i}")
                    if ko:
                        e["ko"] = ko
                        e["koGen"] = True      # 영어는 원문, 해석만 우리 것
                        filled += 1
                    else:
                        missed += 1
        kw = (dict(ensure_ascii=False, separators=(",", ":")) if mini
              else dict(ensure_ascii=False, indent=1))
        p.write_text(json.dumps(d, **kw), encoding="utf-8")
        print(f"  {name}: 채움 {filled}, 남음 {missed}")


if __name__ == "__main__":
    main()
