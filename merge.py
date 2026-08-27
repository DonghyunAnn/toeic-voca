#!/usr/bin/env python3
"""CSV 원본과 블로그 크롤링 결과를 병합한다.

뜻과 품사는 CSV를 따르고, 예문과 연어는 블로그에서 가져온다.
블로그는 각 DAY의 절반만 게시하므로 CSV 없이는 단어의 절반이 비고,
CSV에는 예문이 없으므로 블로그 없이는 예문이 전부 빈다.

양쪽 모두 오타가 있어 아래 표로 손으로 교정한다. 퍼지 매칭도 시도해봤지만
oversea를 overseas로, credit을 creditor로 잘못 잇는 등 위험만 컸다.

    python3 merge.py --csv "~/Downloads/ETS TOEIC VOCA/ETS TOEIC VOCA.csv"
"""

import argparse
import csv
import json
import re
from collections import defaultdict
from datetime import date
from pathlib import Path

import crawl

ROOT = Path(__file__).parent
BLOG_JSON = ROOT / "data" / "words.json"
OUT_JSON = ROOT / "data" / "merged.json"

DAY_RE = re.compile(r"DAY\s*(\d+)", re.I)

# 블로그 표제어의 오타 -> CSV의 올바른 표제어. (DAY, 표기) 단위로 지정한다.
# access와 perspective는 다른 DAY에 진짜 단어로도 나오므로 DAY를 함께 본다.
BLOG_TYPOS = {
    (5, "plummer"): "plumber",
    (6, "inconveniencet"): "inconvenience",
    (6, "handout"): "hand out",
    (9, "complementary"): "complimentary",
    (14, "oversea"): "oversee",
    (17, "ingredients"): "ingredient",
    (17, "access"): "excess",          # 뜻이 "초과, 초과량" -> excess의 오기
    (21, "sizeable"): "sizable",
    (22, "perspective"): "prospective",  # 뜻이 "장래의" -> prospective의 오기
    (27, "crank"): "crack",            # 예문이 "several small cracks"
    (29, "round trip"): "round-trip",
}

# 예문에서 잘려 나온 조각이 표제어로 잡힌 것들. 단어가 아니다.
BLOG_JUNK = {(14, "ppac"), (29, "sffa"), (26, "a as well as b b")}

# CSV 쪽 오타 -> 올바른 표제어.
CSV_TYPOS = {"appropriated": "appropriate"}


def slug(headword):
    """id로 쓸 안정적인 키. 재수집·재병합해도 같은 단어는 같은 id를 갖는다."""
    s = re.sub(r"[^a-z0-9]+", "-", headword.lower()).strip("-")
    return s or "x"


def norm(headword):
    """비교용 정규화. 하이픈과 슬래시는 공백으로 살려둔다."""
    s = headword.lower().replace("-", " ").replace("/", " ")
    return re.sub(r"\s+", " ", re.sub(r"[^a-z ]", " ", s)).strip()


def variants(headword):
    """표기가 어긋날 때 시도해볼 형태들.

    CSV는 'fill out[in]', 'depending on[upon]' 처럼 대괄호로 변형을 묶고
    블로그는 'fill out, fill in' 처럼 쉼표로 나열한다. 양쪽을 펼쳐서 만난다.
    """
    out = [norm(headword)]

    br = re.match(r"^(.*?)\s*\[([^\]]+)\]\s*$", headword.strip())
    if br:
        head, alt = br.group(1).strip(), br.group(2).strip()
        out.append(norm(head))
        out.append(norm(alt))
        parts = head.split()
        if parts:                                  # "fill out[in]" -> "fill in"
            out.append(norm(" ".join(parts[:-1] + [alt])))

    if "," in headword:
        for piece in headword.split(","):
            out.append(norm(piece))

    base = out[0]
    if base.endswith("es") and len(base) > 4:
        out.append(base[:-2])
    if base.endswith("s") and len(base) > 3:
        out.append(base[:-1])

    seen, uniq = set(), []
    for v in out:
        if v and v not in seen:
            seen.add(v)
            uniq.append(v)
    return uniq


def read_csv(path):
    """[(day, headword, senses)] 를 CSV 등장 순서대로."""
    entries = []
    with open(path, encoding="utf-8-sig", newline="") as f:
        for row in csv.reader(f):
            if len(row) < 3:
                continue
            headword, meaning, tag = (c.strip() for c in row[:3])
            m = DAY_RE.search(tag)
            if not m or not headword:
                continue
            headword = CSV_TYPOS.get(headword, headword)
            senses = crawl.split_senses(meaning.replace("\n", " ").strip())
            entries.append((int(m.group(1)), headword, senses))
    return entries


def read_blog():
    """블로그 항목을 표제어 변형까지 펼쳐 색인한다."""
    data = json.loads(BLOG_JSON.read_text(encoding="utf-8"))
    index = defaultdict(list)
    entries = []
    for day in data["days"]:
        for w in day["words"]:
            key = norm(w["headword"])
            if (day["day"], key) in BLOG_JUNK:
                continue
            entry = {
                "day": day["day"],
                "headword": w["headword"],
                "senses": w["senses"],
                "examples": w["examples"],
                "collocations": w["collocations"],
                "matched": False,
            }
            entries.append(entry)
            fixed = BLOG_TYPOS.get((day["day"], key))
            for v in ([norm(fixed)] if fixed else variants(w["headword"])):
                index[v].append(entry)
    return data, index, entries


def merge(csv_path):
    blog_data, blog_index, blog_entries = read_blog()
    csv_entries = read_csv(csv_path)

    def take(day, headword, same_day_only):
        """블로그 항목을 하나 집어 소진 처리한다."""
        for key in variants(headword):
            cands = blog_index.get(key, [])
            pick = next((c for c in cands
                         if not c["matched"] and (not same_day_only or c["day"] == day)), None)
            if pick is not None:
                pick["matched"] = True
                return pick
        return None

    # DAY가 같은 짝을 전부 먼저 맺고, 남은 것끼리 DAY를 넘어 이어준다.
    # 한 단어가 여러 DAY에 나올 때(crack: DAY5, DAY27) 순서 때문에
    # 엉뚱한 DAY가 예문을 가져가는 것을 막는다.
    picks = [take(day, hw, True) for day, hw, _ in csv_entries]
    for i, (day, hw, _) in enumerate(csv_entries):
        if picks[i] is None:
            picks[i] = take(day, hw, False)

    days = defaultdict(list)
    seen_ids = set()
    stats = {"dup_id": 0}

    for (day, headword, senses), pick in zip(csv_entries, picks):
        wid = f"d{day:02d}-{slug(headword)}"
        if wid in seen_ids:
            stats["dup_id"] += 1
            continue
        seen_ids.add(wid)
        days[day].append({
            "id": wid,
            "headword": headword,
            "senses": senses,
            "examples": pick["examples"] if pick else [],
            "collocations": pick["collocations"] if pick else [],
            "source": "both" if pick else "csv",
        })

    # CSV에 대응이 없는 블로그 단어는 버리지 않고 그 DAY에 덧붙인다
    extras = []
    for e in blog_entries:
        if e["matched"]:
            continue
        wid = f"d{e['day']:02d}-{slug(e['headword'])}"
        if wid in seen_ids:
            continue
        seen_ids.add(wid)
        days[e["day"]].append({
            "id": wid,
            "headword": e["headword"],
            "senses": e["senses"],
            "examples": e["examples"],
            "collocations": e["collocations"],
            "source": "blog",
        })
        extras.append(f"DAY{e['day']:02d} {e['headword']}")

    blog_titles = {d["day"]: d["title"] for d in blog_data["days"]}
    blog_urls = {d["day"]: d["url"] for d in blog_data["days"]}
    total = sum(len(v) for v in days.values())
    with_ex = sum(1 for v in days.values() for w in v if w["examples"])

    payload = {
        "meta": {
            "title": "ETS 토익 VOCA",
            "sourceUrl": blog_data["meta"]["sourceUrl"],
            "csvSource": Path(csv_path).name,
            "crawledAt": blog_data["meta"]["crawledAt"],
            "mergedAt": date.today().isoformat(),
            "dayCount": len(days),
            "wordCount": total,
            "withExample": with_ex,
        },
        "days": [{
            "day": d,
            "title": blog_titles.get(d, f"DAY {d}"),
            "url": blog_urls.get(d),
            "words": days[d],
        } for d in sorted(days)],
    }
    stats["extras"] = extras
    return payload, stats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True, help="ETS TOEIC VOCA.csv 경로")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--quiet", action="store_true", help="DAY별 표를 생략")
    args = ap.parse_args()

    payload, stats = merge(Path(args.csv).expanduser())
    m = payload["meta"]

    print(f"병합 결과: DAY {m['dayCount']}개 / 단어 {m['wordCount']}개")
    print(f"  예문 있음: {m['withExample']} ({m['withExample'] / m['wordCount'] * 100:.1f}%)")
    print(f"  예문 없음: {m['wordCount'] - m['withExample']}")
    if stats["dup_id"]:
        print(f"  CSV 내 중복 표제어 건너뜀: {stats['dup_id']}")
    if stats["extras"]:
        print(f"  CSV에 없어 블로그에서 추가: {len(stats['extras'])}건 -> {stats['extras']}")

    if not args.quiet:
        print()
        for d in payload["days"]:
            ex = sum(1 for w in d["words"] if w["examples"])
            print(f"  DAY{d['day']:02d} {d['title'][:24]:<24} {len(d['words']):>4}단어  예문 {ex:>3}")

    if args.dry_run:
        print("\n--dry-run: 저장하지 않음")
        return
    OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n저장: {OUT_JSON}  ({OUT_JSON.stat().st_size // 1024}KB)")


if __name__ == "__main__":
    main()
