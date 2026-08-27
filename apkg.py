#!/usr/bin/env python3
"""Anki 덱(.apkg)에서 단어와 발음 오디오를 꺼낸다.

CSV와 내용은 같지만 두 가지가 더 있다. 뜻 경계가 <br>로 명시되어 있어
품사 분리를 추측하지 않아도 되고, 단어마다 TTS 발음 mp3가 붙어있다.

Anki v3 포맷은 zip 안의 모든 항목이 zstd로 압축되어 있다.
  meta                프로토콜 버전
  collection.anki21b  SQLite 본체
  media               인덱스 -> 파일명 매핑 (protobuf)
  0, 1, 2, ...        미디어 파일. 이름은 media의 등장 순서로 정해진다.

    python3 apkg.py "~/Downloads/ETS TOEIC VOCA/ETS TOEIC VOCA.apkg" --audio-out docs/audio
"""

import argparse
import html
import io
import re
import sqlite3
import pathlib
import tempfile
import zipfile
from pathlib import Path

import zstandard as zstd

SOUND_RE = re.compile(r"\[sound:([^\]]+)\]")
DAY_RE = re.compile(r"DAY(\d+)", re.I)

_dctx = zstd.ZstdDecompressor()


def _unzstd(data):
    """프레임에 크기가 없는 경우가 있어 스트림 방식으로 되돌아간다."""
    try:
        return _dctx.decompress(data)
    except zstd.ZstdError:
        return _dctx.stream_reader(io.BytesIO(data)).read()


def _varint(buf, i):
    val = shift = 0
    while True:
        byte = buf[i]
        i += 1
        val |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return val, i
        shift += 7


def _protobuf_fields(buf):
    """최소한의 protobuf 파서. (필드번호, 와이어타입, 값)을 흘려보낸다."""
    i = 0
    while i < len(buf):
        key, i = _varint(buf, i)
        num, wire = key >> 3, key & 7
        if wire == 0:
            val, i = _varint(buf, i)
        elif wire == 2:
            length, i = _varint(buf, i)
            val, i = buf[i:i + length], i + length
        elif wire == 5:
            val, i = buf[i:i + 4], i + 4
        elif wire == 1:
            val, i = buf[i:i + 8], i + 8
        else:
            raise ValueError(f"알 수 없는 와이어 타입 {wire}")
        yield num, wire, val


def _media_names(blob):
    """media 항목을 인덱스 순서의 파일명 목록으로 바꾼다."""
    names = []
    for num, wire, val in _protobuf_fields(blob):
        if num != 1 or wire != 2:
            continue
        for n2, w2, v2 in _protobuf_fields(val):
            if n2 == 1 and w2 == 2:
                names.append(v2.decode("utf-8", "replace"))
                break
    return names


def read(apkg_path, audio_out=None):
    """(notes, media_written)를 돌려준다.

    notes 는 [{day, headword, meaning_html, senses_raw, audio}] 형태다.
    audio_out 을 주면 그 폴더에 mp3를 푼다.
    """
    apkg_path = Path(apkg_path).expanduser()
    notes, written = [], 0

    with zipfile.ZipFile(apkg_path) as z:
        inner = "collection.anki21b" if "collection.anki21b" in z.namelist() else "collection.anki2"
        blob = z.read(inner)
        db_bytes = _unzstd(blob) if inner.endswith("b") else blob

        with tempfile.NamedTemporaryFile(suffix=".sqlite", delete=False) as tmp:
            tmp.write(db_bytes)
            tmp_path = tmp.name
        try:
            db = sqlite3.connect(tmp_path)
            for flds, tags in db.execute("SELECT flds, tags FROM notes"):
                parts = (flds.split("\x1f") + ["", "", ""])[:3]
                day = DAY_RE.search(tags)
                if not day:
                    continue
                sound = SOUND_RE.search(parts[2])
                # 필드에 HTML 엔티티가 그대로 들어있다(one&#x27;s). 풀어두지 않으면
                # 표제어가 깨져 보이고 다른 자료와 매칭도 안 된다.
                notes.append({
                    "day": int(day.group(1)),
                    "headword": html.unescape(parts[0]).strip(),
                    "meaning_html": html.unescape(parts[1]).strip(),
                    # <br>이 뜻의 경계다. 이것 때문에 CSV보다 정확하게 나눌 수 있다.
                    "senses_raw": [s.strip() for s in
                                   re.split(r"<br\s*/?>", html.unescape(parts[1]), flags=re.I)
                                   if s.strip()],
                    "audio": sound.group(1) if sound else None,
                })
            db.close()
        finally:
            Path(tmp_path).unlink(missing_ok=True)

        if audio_out is not None:
            out = Path(audio_out)
            out.mkdir(parents=True, exist_ok=True)
            names = _media_names(_unzstd(z.read("media")))
            existing = {p.name for p in out.glob("*.mp3")}
            for idx, name in enumerate(names):
                if name in existing:
                    continue
                try:
                    data = _unzstd(z.read(str(idx)))
                except KeyError:
                    continue
                (out / name).write_bytes(data)
                written += 1

    return notes, written


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("apkg")
    ap.add_argument("--audio-out", help="mp3를 풀어놓을 폴더")
    ap.add_argument("--json-out", help="노트를 JSON으로 저장 (덱 없이 재빌드하려면 필요)")
    args = ap.parse_args()

    notes, written = read(args.apkg, args.audio_out)
    if args.json_out:
        import json
        pathlib.Path(args.json_out).write_text(
            json.dumps(notes, ensure_ascii=False, indent=0), encoding="utf-8")
    days = {n["day"] for n in notes}
    multi = sum(1 for n in notes if len(n["senses_raw"]) > 1)
    print(f"노트 {len(notes)}개 / DAY {min(days)}~{max(days)} ({len(days)}개)")
    print(f"  뜻이 둘 이상: {multi}개 (<br>로 구분됨)")
    print(f"  오디오 보유: {sum(1 for n in notes if n['audio'])}개")
    if args.audio_out:
        print(f"  mp3 기록: {written}개 -> {args.audio_out}")
    if args.json_out:
        print(f"  노트 저장: {args.json_out}")


if __name__ == "__main__":
    main()
