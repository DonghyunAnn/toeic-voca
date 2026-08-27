#!/usr/bin/env python3
"""서비스워커 캐시 버전을 docs/ 내용 해시로 맞춘다.

배경 재검증을 없앤 뒤로, 셸이 바뀌었는데 sw.js의 버전이 그대로면 사용자는
옛 파일에 영영 갇힌다. 캐시에 있으면 그걸 주고 끝내기 때문이다.
그래서 버전을 손으로 적지 않고 내용에서 뽑는다. 배포 전에 이걸 돌리면 된다.

발음(docs/audio)은 뺀다. 발음 캐시는 버전과 무관하게 유지되고, 24MB를
해시하느라 기다릴 이유도 없다.
"""

import hashlib
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent
DOCS = ROOT / "docs"
SW = DOCS / "sw.js"


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
        h.update(p.read_bytes())
    return h.hexdigest()[:8], len(files)


def main():
    digest, n = content_hash()
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
