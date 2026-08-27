#!/usr/bin/env python3
"""서비스워커 캐시 버전을 docs/ 내용 해시로 맞춘다.

배경 재검증을 없앤 뒤로, 셸이 바뀌었는데 sw.js의 버전이 그대로면 사용자는
옛 파일에 영영 갇힌다. 캐시에 있으면 그걸 주고 끝내기 때문이다.
그래서 버전을 손으로 적지 않고 내용에서 뽑는다. 배포 전에 이걸 돌리면 된다.

발음(docs/audio)은 뺀다. 발음 캐시는 버전과 무관하게 유지되고, 24MB를
해시하느라 기다릴 이유도 없다.
"""

import hashlib
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent
DOCS = ROOT / "docs"
SW = DOCS / "sw.js"
APP = DOCS / "app.js"
VERSION = DOCS / "version.json"


def content_hash():
    h = hashlib.sha256()
    files = sorted(
        p for p in DOCS.rglob("*")
        if p.is_file()
        and p != SW                                  # 자기 자신은 뺀다 (해시가 순환한다)
        and "audio" not in p.relative_to(DOCS).parts
    )
    for p in files:
        h.update(str(p.relative_to(DOCS)).encode())
        data = p.read_bytes()
        if p == VERSION:
            continue        # 해시 결과를 담는 파일이라 넣으면 순환한다
        if p == APP:
            # BUILD 값 자체는 빼고 센다. 넣으면 해시가 자기 자신을 물어
            # 돌릴 때마다 값이 달라지고 영영 수렴하지 않는다.
            data = re.sub(rb"const BUILD = '[^']*';", b"const BUILD = '';", data)
        h.update(data)
    return h.hexdigest()[:8], len(files)


def stamp_build(digest):
    """app.js의 BUILD 상수에도 같은 값을 박는다.

    설정 화면에 이걸 띄운다. 기기가 새 버전을 받았는지 눈으로 확인할 수단이
    없으면, 고쳤는데도 그대로라는 이야기가 나올 때 원인을 가릴 수가 없다.
    """
    src = APP.read_text(encoding="utf-8")
    m = re.search(r"const BUILD = '([^']*)';", src)
    if not m:
        sys.exit("app.js에서 BUILD 상수를 찾지 못했습니다")
    if m.group(1) == digest:
        return False
    APP.write_text(src.replace(f"const BUILD = '{m.group(1)}';",
                               f"const BUILD = '{digest}';", 1), encoding="utf-8")
    return True


def main():
    digest, n = content_hash()
    stamp_build(digest)

    # 캐시를 타지 않는 버전표. 앱이 자기가 낡았는지 직접 확인하는 데 쓴다.
    VERSION.write_text(json.dumps({"build": digest}) + "\n", encoding="utf-8")

    src = SW.read_text(encoding="utf-8")
    m = re.search(r"const SHELL = '([^']+)';", src)
    if not m:
        sys.exit("sw.js에서 SHELL 상수를 찾지 못했습니다")

    old, new = m.group(1), f"toeic-voca-{digest}"
    if old == new:
        print(f"그대로 (파일 {n}개, {new})")
        return

    SW.write_text(src.replace(f"const SHELL = '{old}';",
                              f"const SHELL = '{new}';"), encoding="utf-8")
    print(f"{old} -> {new}  (파일 {n}개)")


if __name__ == "__main__":
    main()
