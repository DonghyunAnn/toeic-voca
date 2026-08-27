#!/usr/bin/env python3
"""네이버 블로그 단어장 크롤러.

m.blog.naver.com 의 공개 엔드포인트에서 DAY별 단어장 포스트를 읽어
data/words.json 으로 저장한다. 파이썬 표준 라이브러리만 쓴다.

    python3 crawl.py                # 전체 수집
    python3 crawl.py --day 1 17     # 특정 DAY만 (파서 확인용)
    python3 crawl.py --dry-run      # 저장하지 않고 결과만 출력
"""

import argparse
import html
import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

BLOG_ID = "ms_carrick"
CATEGORY_NO = 28
LIST_API = "https://m.blog.naver.com/api/blogs/{blog}/post-list"
POST_URL = "https://m.blog.naver.com/PostView.naver"
UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
      "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")

OUT_PATH = Path(__file__).parent / "data" / "words.json"
REQUEST_DELAY = 1.0

# 품사 마커. 앞에 알파벳이 붙어있으면(예: "no.") 마커로 보지 않는다.
POS_PATTERN = re.compile(r"(?<![A-Za-z])(n|v|a|ad|adv|adj|prep|conj|phr|pron|int)\.")
# 영어부 끝에 붙은 품사. 점이 없는 경우도 있다: "malfunction n고장", "distribution n 배포"
POS_TRAILING = re.compile(
    r"\s*(?<![A-Za-z])(n|v|a|ad|adv|adj|prep|conj|phr|pron|int)\.?\s*$")
# 뜻 안에 끼어드는 두 번째 품사: "초과, 초과량 a. 초라한", "n고장,오작동 v제대로 작동하지않다"
# 줄 전체가 추가 뜻인 경우: "v. (언론) 보도, 취재"
POS_ONLY_LINE = re.compile(
    r"^(n|v|a|ad|adv|adj|prep|conj|phr|pron|int)\.?\s*(?=[가-힣(\[])")
POS_INLINE = re.compile(
    r"(?<![A-Za-z가-힣])(n|v|a|ad|adv|adj|prep|conj|phr|pron|int)\.?\s*(?=[가-힣])")
HANGUL = re.compile(r"[가-힣]")
# 뜻의 시작. 전치사 뜻은 "~아래에"처럼 물결로 시작한다.
MEANING_START = re.compile(r"[가-힣~]")
LATIN = re.compile(r"[A-Za-z]")

# 본문 앞뒤에 섞여 들어오는 블로그 UI 텍스트.
NOISE_LINES = {
    "이웃추가", "공유하기", "URL복사", "신고하기", "본문 기타 기능", "댓글", "공감",
    "인쇄", "스크랩", "저장", "이전", "다음", "목록", "맨위로",
}

# 본문 끝에 붙는 제휴 고지·교재 홍보. 해석 자리로 빨려 들어가지 않게 미리 제거한다.
NOISE_PATTERNS = re.compile(
    r"쿠팡\s*파트너스|수수료를\s*제공|파트너스\s*활동|구매\s*링크|"
    r"문제집.*풀어보자|교재.*추천|광고\s*포함|협찬|"
    r"\d+\s*개의?\s*단어|단어는\s*총|updated|업데이트|^ETS\b|^step\d"
)


def fetch(url, params=None):
    if params:
        url = url + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Referer": f"https://m.blog.naver.com/PostList.naver?blogId={BLOG_ID}&categoryNo={CATEGORY_NO}",
        "Accept-Language": "ko-KR,ko;q=0.9",
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", "replace")


def list_posts():
    """카테고리의 모든 포스트를 페이지가 빌 때까지 읽는다."""
    posts, page = [], 1
    while True:
        raw = fetch(LIST_API.format(blog=BLOG_ID), {
            "categoryNo": CATEGORY_NO, "itemCount": 30, "page": page,
        })
        items = json.loads(raw).get("result", {}).get("items", [])
        if not items:
            break
        posts.extend(items)
        page += 1
        time.sleep(REQUEST_DELAY)
    return posts


def extract_container(page_html):
    """se-main-container 안쪽만 잘라낸다. div 깊이를 세어 짝을 맞춘다."""
    key = '<div class="se-main-container">'
    start = page_html.find(key)
    if start < 0:
        return None
    inner_start = start + len(key)
    depth = 1
    for m in re.finditer(r"<(/?)div\b", page_html[inner_start:]):
        depth += -1 if m.group(1) else 1
        if depth == 0:
            return page_html[inner_start:inner_start + m.start()]
    return page_html[inner_start:]


def to_lines(fragment):
    """HTML 조각을 텍스트 줄 목록으로 바꾼다."""
    text = re.sub(r"<br\s*/?>", "\n", fragment)
    text = re.sub(r"</(p|div|h\d|li|tr)>", "\n", text)
    text = re.sub(r"<script\b.*?</script>", "", text, flags=re.S)
    text = re.sub(r"<style\b.*?</style>", "", text, flags=re.S)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    text = unicodedata.normalize("NFC", text)
    text = text.replace("​", "").replace("﻿", "").replace("\xa0", " ")

    lines = []
    for raw in text.split("\n"):
        line = re.sub(r"\s+", " ", raw).strip()
        if not line or line in NOISE_LINES or NOISE_PATTERNS.search(line):
            continue
        # 구분선, 이모지만 있는 줄 등
        if not HANGUL.search(line) and not LATIN.search(line):
            continue
        lines.append(line)
    return lines


def split_senses(meaning_text, first_pos=None):
    """'초과, 초과량 a. 초라한' -> [{'n.','초과, 초과량'}, {'a.','초라한'}]"""
    marks = list(POS_INLINE.finditer(meaning_text))
    senses, cursor, pos = [], 0, first_pos

    for mk in marks:
        chunk = meaning_text[cursor:mk.start()].strip(" -–—:;,")
        if chunk:
            senses.append({"pos": pos, "meaning": chunk})
        pos = mk.group(1) + "."
        cursor = mk.end()

    tail = meaning_text[cursor:].strip(" -–—:;,")
    if tail:
        senses.append({"pos": pos, "meaning": tail})
    return senses


def parse_entry(line):
    """표제어 줄이면 (headword, senses)를, 아니면 None.

    포맷 편차가 커서 '영어부 + 한글뜻'으로만 보고, 영어부 끝에 붙은
    품사 마커를 떼어낸다. 품사가 아예 없는 DAY(전치사 등)도 통과한다.
    """
    m = MEANING_START.search(line)
    if not m or m.start() == 0:
        return None                      # 뜻이 없거나 한글로 시작 -> 표제어 아님

    head_raw, meaning_raw = line[:m.start()].strip(), line[m.start():].strip()
    while head_raw.endswith(("(", "[", "<")):    # "coverage n. (보험의) 보장"
        meaning_raw = head_raw[-1] + meaning_raw
        head_raw = head_raw[:-1].strip()
    if not head_raw or not LATIN.search(head_raw):
        return None

    pos = None
    tm = POS_TRAILING.search(head_raw)
    if tm:
        pos = tm.group(1) + "."
        head_raw = head_raw[:tm.start()].strip()
    if not head_raw or not LATIN.search(head_raw):
        return None

    senses = split_senses(meaning_raw, pos)
    if not senses:
        return None
    return head_raw.strip(" -–—:;,"), senses


def stem_of(headword):
    """연어·예문 판별용 어간. 'arrange' -> 'arran', 'hold' -> 'hold'"""
    first = headword.lower().split()[0]
    return first[:max(4, len(first) - 2)]


def split_bilingual(line):
    """'hold a booklet 책자를 들다' -> ('hold a booklet', '책자를 들다')"""
    m = MEANING_START.search(line)
    return line[:m.start()].strip(" -–—:;,"), line[m.start():].strip()


def is_rich_format(lines):
    """품사 마커를 쓰는 DAY인지 판정한다.

    마커를 쓰는 DAY(대부분)에서는 마커 없는 여러 단어짜리 줄이 전부 연어다.
    마커를 안 쓰는 DAY(전치사 편 등)에서는 그런 줄도 표제어다.
    """
    marked = sum(1 for line in lines
                 if (e := parse_entry(line)) and e[1][0]["pos"])
    return marked >= 10


def looks_like_collocation(head_raw, has_pos, current, rich, next_line):
    """마커 없는 '영어 + 한글' 줄이 연어인지 새 표제어인지 가른다.

    가장 확실한 단서는 다음 줄이다. 표제어 뒤에는 영어 예문이 오고,
    연어 뒤에는 또 다른 연어나 새 표제어(둘 다 한글을 포함)가 온다.
    이것 없이 'DAY가 마커를 쓰면 다단어는 연어'로만 판정하면
    power outage 같은 다단어 표제어를 연어로 삼켜 그 예문까지 잃는다.
    """
    if current is None or has_pos:
        return False
    if len(head_raw.split()) < 2:
        return False                     # 한 단어짜리는 언제나 새 표제어
    if next_line is not None and not HANGUL.search(next_line):
        return False                     # 다음 줄이 영어 문장 = 이 줄은 표제어
    return rich


def example_fits(headword, sentence):
    """이 문장이 이 표제어의 예문으로 보이는가.

    다섯 자 이상인 단어만 따진다. lie/wave/take 같은 짧은 단어는 lying, waving,
    taking처럼 활용이 심해서 어간으로 걸러내면 멀쩡한 예문을 버리게 된다.
    긴 단어는 활용해도 앞부분이 남으므로 어간 포함 여부로 판별할 수 있다.
    """
    base = re.sub(r"\[.*?\]|\(.*?\)", " ", headword.lower())
    tokens = [t for t in re.split(r"[^a-z]+", base) if len(t) >= 5]
    if not tokens:
        return True                       # 판단이 어려우면 남긴다

    flat = re.sub(r"[^a-z]", "", sentence.lower())
    for t in tokens:
        stems = {t, t[:-1] if t.endswith("e") else t}
        if t.endswith("y"):
            stems.add(t[:-1])
        if len(t) > 5 and t[-1] == t[-2]:      # running -> run
            stems.add(t[:-1])
        if any(st[:max(4, len(st) - 1)] in flat for st in stems):
            return True
    return False


def tidy_examples(word):
    """쪼개진 문장을 잇고 표제어와 무관한 줄을 버린다.

    블로그 본문은 긴 문장을 줄바꿈으로 접어 놓아서 한 문장이 두세 조각으로
    들어온다("the old iron pipes will be" + "replaced with durable plastic pipes").
    소문자로 시작하는 조각은 앞줄의 이어짐으로 본다.

    질의응답 DAY는 문답이 두 줄로 오는데, 답변 줄에는 표제어가 없다.
    그런 줄은 그 단어의 예문이 아니므로 버린다.
    """
    exs = word["examples"]
    if not exs:
        return

    merged = []
    for e in exs:
        if merged and re.match(r"^[a-z]", e["en"]) and not re.match(r"^[AB]\s*:", e["en"]):
            prev = merged[-1]
            prev["en"] = prev["en"].rstrip() + " " + e["en"].lstrip()
            if e["ko"] and not prev["ko"]:
                prev["ko"] = e["ko"]
        else:
            merged.append(e)

    keep = [e for e in merged if example_fits(word["headword"], e["en"])]
    # 하나도 안 남으면 원래 첫 줄이라도 남긴다
    word["examples"] = keep or merged[:1]


def parse_words(lines, day):
    """줄 목록을 단어 배열로 접는다. 분류 못한 줄은 orphans로 돌려준다."""
    words, orphans = [], []
    current = None
    rich = is_rich_format(lines)

    for idx, line in enumerate(lines):
        has_ko = bool(HANGUL.search(line))
        next_line = lines[idx + 1] if idx + 1 < len(lines) else None

        if not has_ko:
            if current is None:
                orphans.append(line)
            else:
                current["examples"].append({"en": line, "ko": None})
            continue

        if HANGUL.match(line):           # 한글로 시작 -> 직전 항목의 해석
            if current and current["examples"] and current["examples"][-1]["ko"] is None:
                current["examples"][-1]["ko"] = line
            elif current and current["collocations"] and current["collocations"][-1]["ko"] is None:
                current["collocations"][-1]["ko"] = line
            else:
                orphans.append(line)
            continue

        cont = POS_ONLY_LINE.match(line)
        if cont and current:             # 직전 표제어의 추가 뜻
            current["senses"].extend(
                split_senses(line[cont.end():].strip(), cont.group(1) + "."))
            continue

        entry = parse_entry(line)
        if entry is None:
            orphans.append(line)
            continue

        head_raw, senses = entry
        if looks_like_collocation(head_raw, senses[0]["pos"], current, rich, next_line):
            en, ko = split_bilingual(line)
            current["collocations"].append({"en": en, "ko": ko})
            continue

        current = {
            "id": f"d{day:02d}-{len(words) + 1:03d}",
            "headword": head_raw,
            "senses": senses,
            "examples": [],
            "collocations": [],
        }
        words.append(current)

    for w in words:
        tidy_examples(w)
    return words, orphans


def parse_title(title):
    """'DAY01 ETS 토익 VOCA 예문 사진묘사 필수 어휘 (1) + 뜻 있음' -> (1, '사진묘사 필수 어휘 (1)')"""
    clean = html.unescape(title)
    m = re.search(r"DAY\s*(\d+)", clean, re.I)
    day = int(m.group(1)) if m else None
    subtitle = clean
    if m:
        subtitle = clean[m.end():]
    subtitle = re.sub(r"^\s*ETS\s*(토익)?\s*VOCA\s*(예문)?", "", subtitle)
    subtitle = re.sub(r"\+?\s*(뜻\s*있음|예문해석|뜻있음)\s*", "", subtitle)
    return day, re.sub(r"\s+", " ", subtitle).strip(" +-")


def crawl(only_days=None):
    print(f"목록 조회: blogId={BLOG_ID} categoryNo={CATEGORY_NO}")
    posts = list_posts()
    print(f"  포스트 {len(posts)}개")

    entries = []
    for p in posts:
        day, subtitle = parse_title(p["titleWithInspectMessage"])
        if day is None:
            print(f"  ! DAY 번호 없음, 건너뜀: {p['titleWithInspectMessage']}")
            continue
        entries.append((day, subtitle, p["logNo"]))
    entries.sort(key=lambda e: e[0])

    if only_days:
        entries = [e for e in entries if e[0] in only_days]

    days, report = [], {"orphans": [], "no_example": [], "odd_pos": [], "empty": []}
    known_pos = {"n.", "v.", "a.", "ad.", "adv.", "adj.", "prep.", "conj.", "phr.", "pron.", "int."}

    for day, subtitle, log_no in entries:
        try:
            page = fetch(POST_URL, {"blogId": BLOG_ID, "logNo": log_no})
        except urllib.error.URLError as e:
            print(f"  ! DAY{day:02d} 요청 실패: {e}")
            continue

        fragment = extract_container(page)
        if fragment is None:
            print(f"  ! DAY{day:02d} 본문 컨테이너 없음 (logNo={log_no})")
            continue

        words, orphans = parse_words(to_lines(fragment), day)
        days.append({
            "day": day,
            "title": subtitle,
            "logNo": log_no,
            "url": f"https://m.blog.naver.com/{BLOG_ID}/{log_no}",
            "words": words,
        })

        for o in orphans:
            report["orphans"].append((day, o))
        for w in words:
            if not w["examples"]:
                report["no_example"].append((day, w["headword"]))
            for s in w["senses"]:
                if s["pos"] is not None and s["pos"] not in known_pos:
                    report["odd_pos"].append((day, w["headword"], s["pos"]))
                if not s["meaning"]:
                    report["empty"].append((day, w["headword"]))

        print(f"  DAY{day:02d} {subtitle[:28]:<28} 단어 {len(words):3d}개"
              f"{'  orphan ' + str(len(orphans)) if orphans else ''}")
        time.sleep(REQUEST_DELAY)

    return days, report


def print_report(days, report):
    total = sum(len(d["words"]) for d in days)
    print(f"\n{'=' * 60}\n수집 결과: DAY {len(days)}개 / 단어 {total}개")

    counts = [len(d["words"]) for d in days]
    if counts:
        avg = sum(counts) / len(counts)
        outliers = [d for d in days if abs(len(d["words"]) - avg) > avg * 0.6]
        print(f"DAY당 평균 {avg:.1f}개 (최소 {min(counts)} / 최대 {max(counts)})")
        for d in outliers:
            print(f"  ? DAY{d['day']:02d} 단어 수 {len(d['words'])}개 — 평균에서 벗어남")

    def show(key, label, limit=15):
        items = report[key]
        if not items:
            return
        print(f"\n[{label}] {len(items)}건")
        for it in items[:limit]:
            print(f"  - {it}")
        if len(items) > limit:
            print(f"  ... 외 {len(items) - limit}건")

    show("no_example", "예문 없는 단어")
    show("odd_pos", "미지의 품사")
    show("empty", "뜻이 비어있음")
    show("orphans", "분류 실패한 줄")

    if not any(report.values()):
        print("\n이상 항목 없음.")
    print("=" * 60)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--day", type=int, nargs="*", help="특정 DAY만 수집")
    ap.add_argument("--dry-run", action="store_true", help="저장하지 않음")
    args = ap.parse_args()

    days, report = crawl(set(args.day) if args.day else None)
    print_report(days, report)

    if args.dry_run:
        print("\n--dry-run: 저장하지 않음")
        if days:
            print(json.dumps(days[0]["words"][:3], ensure_ascii=False, indent=2))
        return

    if not days:
        print("수집된 데이터 없음. 저장하지 않음.")
        sys.exit(1)

    # 일부 DAY만 수집한 결과로 전체 파일을 덮으면 나머지 DAY가 통째로 사라진다.
    # 기존 파일이 더 많은 DAY를 갖고 있으면 그쪽을 살려 합친다.
    if OUT_PATH.exists():
        old = json.loads(OUT_PATH.read_text(encoding="utf-8")).get("days", [])
        fresh = {d["day"] for d in days}
        kept = [d for d in old if d["day"] not in fresh]
        if kept:
            print(f"기존 파일의 DAY {len(kept)}개를 유지하고 합칩니다.")
            days = sorted(days + kept, key=lambda d: d["day"])

    payload = {
        "meta": {
            "title": "ETS 토익 VOCA",
            "sourceUrl": f"https://m.blog.naver.com/PostList.naver?blogId={BLOG_ID}&categoryNo={CATEGORY_NO}",
            "crawledAt": date.today().isoformat(),
            "dayCount": len(days),
            "wordCount": sum(len(d["words"]) for d in days),
        },
        "days": days,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n저장: {OUT_PATH}  ({OUT_PATH.stat().st_size // 1024}KB)")


if __name__ == "__main__":
    main()
