#!/usr/bin/env python3
"""Anki 덱(또는 CSV)과 블로그 크롤링 결과를 병합한다.

뜻과 품사는 덱을 따르고, 예문과 연어는 블로그에서 가져온다.
블로그는 각 DAY의 절반만 게시하므로 덱 없이는 단어의 절반이 비고,
덱에는 예문이 없으므로 블로그 없이는 예문이 전부 빈다.

덱(.apkg)이 CSV보다 낫다. 내용은 같지만 뜻 경계가 <br>로 명시되어 있어
품사 분리를 추측하지 않아도 되고, 단어마다 발음 mp3가 붙어있다.

양쪽 모두 오타가 있어 아래 표로 손으로 교정한다. 퍼지 매칭도 시도해봤지만
oversea를 overseas로, credit을 creditor로 잘못 잇는 등 위험만 컸다.

    python3 merge.py --apkg "~/Downloads/ETS TOEIC VOCA/ETS TOEIC VOCA.apkg"
"""

import argparse
import csv
import unicodedata
import json
import re
from collections import defaultdict
from datetime import date
from pathlib import Path

import apkg as apkg_reader
import crawl

ROOT = Path(__file__).parent
BLOG_JSON = ROOT / "data" / "words.json"
OUT_JSON = ROOT / "data" / "merged.json"
TIERS_JSON = ROOT / "data" / "tiers.json"
GENERATED_JSON = ROOT / "data" / "generated_examples.json"
DECK_JSON = ROOT / "data" / "deck.json"
EXTRA_JSON = ROOT / "data" / "extra-voca.json"

# 추가 등급을 몇 개의 DAY로 나눌지. 기존 DAY 크기(100~138)와 비슷하게 맞춘다.
EXTRA_DAYS = 10

DAY_RE = re.compile(r"DAY\s*(\d+)", re.I)
# 덱의 뜻 조각 맨 앞에 붙은 품사. "v. (낙엽 등을) 갈퀴로..." 처럼 괄호가 이어지면
# crawl.split_senses의 한글-선행 규칙에 걸리지 않으므로 여기서 먼저 떼어낸다.
LEAD_POS = re.compile(r"^\s*((?:n|v|a|ad|adv|adj|prep|conj|phr|pron|int)\.)\s*")

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
    (29, "casual fair"): "casual fare",
}

# 예문에서 잘려 나온 조각이 표제어로 잡힌 것들. 단어가 아니다.
BLOG_JUNK = {(14, "ppac"), (29, "sffa"), (26, "a as well as b b")}

# CSV 쪽 오타 -> 올바른 표제어.
CSV_TYPOS = {"appropriated": "appropriate"}

# 덱/CSV의 뜻 오류. (DAY, 표제어) -> [(품사, 뜻)] 로 통째로 갈아끼운다.
# 원문을 그대로 두면 학습할 때 틀린 뜻을 외우게 되므로 확인된 것만 고친다.
MEANING_FIXES = {
    (15, "aptitude"): [("n.", "적성, 소질")],       # 원문 "작성, 소질"
    (5, "crack"): [("n.", "금, 틈")],               # 원문 품사 자리가 비어 ". 금, 틈"
    # 원문 "진공청소기를 청소하다". 그러면 청소기 자체를 닦는 말이 된다.
    # 같은 단어의 예문 번역은 원문에서도 "진공청소기로"라고 옳게 쓴다.
    (1, "vacuum"): [("v.", "진공청소기로 청소하다")],
    # 원문 "mazimize" 오타
    (11, "minimize"): [("v.", "최소한도로 하다, 줄이다"),
                       (None, "(↔ maximize 최대로 하다)")],
}


def fold(text):
    """악센트를 벗겨 ASCII로 눕힌다. résumé와 resume이 다른 단어가 되면 안 된다."""
    return "".join(c for c in unicodedata.normalize("NFKD", text)
                   if not unicodedata.combining(c))


def slug(headword):
    """id로 쓸 안정적인 키. 재수집·재병합해도 같은 단어는 같은 id를 갖는다."""
    s = re.sub(r"[^a-z0-9]+", "-", fold(headword).lower()).strip("-")
    return s or "x"


def norm(headword):
    """비교용 정규화. 하이픈과 슬래시는 공백으로 살려둔다."""
    s = fold(headword).lower().replace("-", " ").replace("/", " ")
    return re.sub(r"\s+", " ", re.sub(r"[^a-z ]", " ", s)).strip()


def variants(headword):
    """표기가 어긋날 때 시도해볼 형태들.

    CSV는 'fill out[in]', 'depending on[upon]' 처럼 대괄호로 변형을 묶고
    블로그는 'fill out, fill in' 처럼 쉼표로 나열한다. 양쪽을 펼쳐서 만난다.
    """
    out = [norm(headword)]

    # 대괄호 안의 말은 바로 앞 단어를 대신한다. 끝에만 오는 것도 아니다.
    #   fill out[in]                            -> fill out / fill in
    #   environmentally[eco] friendly           -> environmentally friendly / eco friendly
    #   responsibilities[duties/tasks] include  -> responsibilities|duties|tasks include
    br = re.search(r"\[([^\]]+)\]", headword)
    if br:
        before, alts, after = headword[:br.start()], br.group(1), headword[br.end():]
        head_words = before.split()
        out.append(norm(before + " " + after))          # 대괄호를 통째로 뺀 형태
        for alt in (a.strip() for a in alts.split("/")):
            if not alt or not head_words:
                continue
            out.append(norm(" ".join(head_words[:-1] + [alt]) + " " + after))

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


def notes_to_entries(notes):
    """덱 노트를 (day, headword, senses, audio) 목록으로 바꾼다."""
    entries = []
    for n in notes:
        headword = CSV_TYPOS.get(n["headword"], n["headword"])
        senses = []
        for part in n["senses_raw"]:                 # <br>로 이미 나뉘어 있다
            text = re.sub(r"<[^>]+>", " ", part).strip()
            lead = LEAD_POS.match(text)
            if lead:
                rest = text[lead.end():].strip()
                senses.extend(crawl.split_senses(rest, lead.group(1))
                              or [{"pos": lead.group(1), "meaning": rest}])
            else:
                senses.extend(crawl.split_senses(text))
        if not senses:
            senses = [{"pos": None, "meaning": re.sub(r"<[^>]+>", " ", n["meaning_html"]).strip()}]
        entries.append((n["day"], headword, senses, n["audio"]))
    return entries


def read_apkg(path, audio_out=None):
    notes, written = apkg_reader.read(path, audio_out)
    return notes_to_entries(notes), written


def read_deck_json():
    """원본 덱 없이 저장해둔 노트로 재빌드한다."""
    notes = json.loads(DECK_JSON.read_text(encoding="utf-8"))
    return notes_to_entries(notes), 0


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
            entries.append((int(m.group(1)), headword, senses, None))
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


def load_generated():
    """교재에 예문이 없는 단어를 위해 만든 예문. 없으면 빈 dict."""
    if not GENERATED_JSON.exists():
        return {}
    return json.loads(GENERATED_JSON.read_text(encoding="utf-8"))


def load_extra(known_keys):
    """모바일 단어장에서 아직 없는 단어만 '추가' 등급으로 돌려준다.

    PDF는 대략 빈도순이라 번호가 낮을수록 자주 나온다. 그 순서를 지켜
    DAY로 나누면 중요한 것부터 공부하게 된다. 예문도 발음도 없다.
    """
    if not EXTRA_JSON.exists():
        return []
    words = json.loads(EXTRA_JSON.read_text(encoding="utf-8"))
    fresh = [w for w in sorted(words, key=lambda x: x["no"])
             if norm(w["headword"]) not in known_keys]
    if not fresh:
        return []

    per_day = -(-len(fresh) // EXTRA_DAYS)          # 올림
    out = []
    for i, w in enumerate(fresh):
        out.append({
            "day": 31 + i // per_day,
            "headword": w["headword"],
            "senses": w["senses"],
            "rank": w["no"],
        })
    return out


def load_tiers():
    """엑셀 교재의 티어(필수 / 토익 만점 완성). 없으면 빈 dict."""
    if not TIERS_JSON.exists():
        return {}
    raw = json.loads(TIERS_JSON.read_text(encoding="utf-8"))
    out = {}
    for key, tier in raw.items():
        day, _, word = key.partition("|")
        out[(int(day), word)] = tier
    return out


def tier_key(day, headword):
    s = headword.lower().replace("-", " ").replace("/", " ").replace("'", " ").replace("\u2019", " ")
    return (day, re.sub(r"\s+", " ", re.sub(r"[^a-z ]", " ", s)).strip())


def merge(source, kind, audio_out=None):
    blog_data, blog_index, blog_entries = read_blog()
    tiers = load_tiers()
    generated = load_generated()
    if kind == "apkg":
        csv_entries, audio_written = read_apkg(source, audio_out)
    elif kind == "deck":
        csv_entries, audio_written = read_deck_json()
    else:
        csv_entries, audio_written = read_csv(source), 0

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
    picks = [take(day, hw, True) for day, hw, _, _ in csv_entries]
    for i, (day, hw, _, _) in enumerate(csv_entries):
        if picks[i] is None:
            picks[i] = take(day, hw, False)

    days = defaultdict(list)
    seen_ids = set()
    stats = {"dup_id": 0}

    for (day, headword, senses, audio), pick in zip(csv_entries, picks):
        wid = f"d{day:02d}-{slug(headword)}"
        if wid in seen_ids:
            stats["dup_id"] += 1
            continue
        seen_ids.add(wid)
        word = {
            "id": wid,
            "headword": headword,
            "senses": senses,
            "examples": pick["examples"] if pick else [],
            "collocations": pick["collocations"] if pick else [],
            "source": "both" if pick else "deck",
        }
        if audio:
            word["audio"] = audio
        fix = MEANING_FIXES.get((day, headword.lower()))
        if fix:
            word["senses"] = [{"pos": p, "meaning": m} for p, m in fix]
        # 등급을 못 찾아도 비워두지 않는다. 비면 등급 필터에서 통째로 사라진다.
        word["tier"] = tiers.get(tier_key(day, headword), "core")
        gen = generated.get(wid)
        if gen and not word["examples"]:
            word["examples"] = [{"en": gen["en"], "ko": gen["ko"], "generated": True}]
        days[day].append(word)

    # CSV에 대응이 없는 블로그 단어는 버리지 않고 그 DAY에 덧붙인다
    extras = []
    for e in blog_entries:
        if e["matched"]:
            continue
        wid = f"d{e['day']:02d}-{slug(e['headword'])}"
        if wid in seen_ids:
            continue
        seen_ids.add(wid)
        gen = generated.get(wid)
        days[e["day"]].append({
            "id": wid,
            "headword": e["headword"],
            "senses": e["senses"],
            # 블로그에도 예문이 없으면 만들어 둔 것을 쓴다
            "examples": e["examples"] or ([{"en": gen["en"], "ko": gen["ko"], "generated": True}]
                                          if gen else []),
            "collocations": e["collocations"],
            "source": "blog",
            "tier": tiers.get(tier_key(e["day"], e["headword"]), "core"),
        })
        extras.append(f"DAY{e['day']:02d} {e['headword']}")

    # 모바일 단어장에서 겹치지 않는 것만 '추가' 등급으로 붙인다.
    # 발음이 없으므로 기존 DAY에 섞지 않고 DAY 31부터 따로 둔다.
    known = {norm(w["headword"]) for v in days.values() for w in v}
    extra_titles = {}
    for e in load_extra(known):
        # DAY를 id에 넣지 않는다. 추가 등급의 DAY는 목록 내 위치로 정해지므로
        # 한 단어만 늘거나 줄어도 뒤가 전부 밀려 id가 통째로 바뀐다.
        wid = f"x-{slug(e['headword'])}"
        if wid in seen_ids:
            continue
        seen_ids.add(wid)
        gen = generated.get(wid)
        days[e["day"]].append({
            "id": wid,
            "headword": e["headword"],
            "senses": e["senses"],
            # 이 단어장에는 예문이 없어서 만들어 넣는다
            "examples": ([{"en": gen["en"], "ko": gen["ko"], "generated": True}]
                         if gen else []),
            "collocations": [],
            "source": "extra",
            "tier": "extra",
            "rank": e["rank"],
        })
        extra_titles[e["day"]] = True

    blog_titles = {d["day"]: d["title"] for d in blog_data["days"]}
    blog_titles.update({d: f"독종반 추가 어휘 ({d - 30})" for d in extra_titles})
    blog_urls = {d["day"]: d["url"] for d in blog_data["days"]}
    total = sum(len(v) for v in days.values())
    with_ex = sum(1 for v in days.values() for w in v if w["examples"])
    with_audio = sum(1 for v in days.values() for w in v if w.get("audio"))
    core = sum(1 for v in days.values() for w in v if w.get("tier") == "core")
    extra = sum(1 for v in days.values() for w in v if w.get("tier") == "extra")
    gen_used = sum(1 for v in days.values() for w in v
                   if w["examples"] and w["examples"][0].get("generated"))

    payload = {
        "meta": {
            "title": "ETS 토익 VOCA",
            "sourceUrl": blog_data["meta"]["sourceUrl"],
            "deckSource": Path(source).name,
            "crawledAt": blog_data["meta"]["crawledAt"],
            "mergedAt": date.today().isoformat(),
            "dayCount": len(days),
            "wordCount": total,
            "withExample": with_ex,
            "withAudio": with_audio,
            "coreCount": core,
            "extraCount": extra,
            "sources": {
                "core": "ETS 토익 기출 보카 (공식 교재)",
                "bonus": "ETS 토익 기출 보카 (공식 교재)",
                "extra": "독종반 모바일 단어장",
            },
            "generatedExamples": gen_used,
        },
        "days": [{
            "day": d,
            "title": blog_titles.get(d, f"DAY {d}"),
            "url": blog_urls.get(d),
            "words": days[d],
        } for d in sorted(days)],
    }
    stats["extras"] = extras
    stats["audio_written"] = audio_written
    return payload, stats


def main():
    ap = argparse.ArgumentParser()
    src = ap.add_mutually_exclusive_group()
    src.add_argument("--apkg", help="ETS TOEIC VOCA.apkg 경로 (권장)")
    src.add_argument("--csv", help="ETS TOEIC VOCA.csv 경로")
    ap.add_argument("--audio-out", default=str(ROOT / "docs" / "audio"),
                    help="발음 mp3를 풀어놓을 폴더 (--apkg 일 때만)")
    ap.add_argument("--no-audio", action="store_true", help="mp3를 풀지 않음")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--quiet", action="store_true", help="DAY별 표를 생략")
    args = ap.parse_args()

    if args.apkg:
        kind, source = "apkg", Path(args.apkg).expanduser()
    elif args.csv:
        kind, source = "csv", Path(args.csv).expanduser()
    elif DECK_JSON.exists():
        # 원본을 옮겨두어도 저장소만으로 재빌드된다
        kind, source = "deck", DECK_JSON
    else:
        ap.error("--apkg 나 --csv 를 주거나 data/deck.json 이 있어야 합니다")
    audio_out = None if (args.no_audio or args.dry_run or kind != "apkg") else args.audio_out
    payload, stats = merge(source, kind, audio_out)
    m = payload["meta"]

    print(f"병합 결과: DAY {m['dayCount']}개 / 단어 {m['wordCount']}개")
    print(f"  예문 있음: {m['withExample']} ({m['withExample'] / m['wordCount'] * 100:.1f}%)")
    print(f"  예문 없음: {m['wordCount'] - m['withExample']}")
    if m.get("withAudio"):
        print(f"  발음 오디오: {m['withAudio']}")
    if m.get("coreCount"):
        bonus = m["wordCount"] - m["coreCount"] - m.get("extraCount", 0)
        print(f"  필수 {m['coreCount']} / 만점 완성 {bonus} / 추가 {m.get('extraCount', 0)}")
    if m.get("generatedExamples"):
        print(f"  그중 생성한 예문: {m['generatedExamples']}")
    if stats["audio_written"]:
        print(f"  mp3 기록: {stats['audio_written']}개 -> {audio_out}")
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
    # 앱이 받는 파일이다. 들여쓰기를 넣으면 그것만 660KB고, 압축 후에도 23KB를
    # 더 쓴다. 사람이 읽을 일이 있으면 python3 -m json.tool로 보면 된다.
    OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False,
                                   separators=(",", ":")), encoding="utf-8")
    print(f"\n저장: {OUT_JSON}  ({OUT_JSON.stat().st_size // 1024}KB)")


if __name__ == "__main__":
    main()
