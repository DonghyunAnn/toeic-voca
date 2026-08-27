# ETS 토익 VOCA

네이버 블로그에 DAY별로 정리된 ETS 토익 보카를 수집해, 모바일에서 오프라인으로
쓰는 개인 학습 앱. 서버도 빌드 도구도 의존성도 없다.

**3,159단어 / 30 DAY**, 그중 **1,585개에 예문**.

데이터는 두 곳에서 온다. 뜻과 품사는 CSV 원본, 예문과 연어는 블로그다.
블로그는 각 DAY의 절반만 게시하고 CSV에는 예문이 없어서, 한쪽만으로는 부족하다.
대조 과정과 양쪽에서 찾은 오류는 `docs-spec/2026-08-27-csv-cross-check.md`에 있다.

## 구조

```
crawl.py              블로그 수집 (파이썬 표준 라이브러리만)
merge.py              CSV 원본과 블로그 결과 병합
make_icons.py         PWA 아이콘 생성 (외부 라이브러리 없이 PNG 직접 작성)
data/words.json       블로그 수집 원본
data/merged.json      CSV와 병합한 최종 데이터
docs/                 GitHub Pages 서빙 루트
  index.html  style.css  app.js
  words.json          data/words.json 사본
  manifest.json  sw.js  icons/
docs-spec/            설계 문서와 구현 계획
```

## 데이터 수집

```bash
python3 crawl.py                # 전체
python3 crawl.py --day 1 17     # 특정 DAY만 (파서 확인용)
python3 crawl.py --dry-run      # 저장하지 않고 결과만 출력
```

## 병합

```bash
python3 merge.py --csv "~/Downloads/ETS TOEIC VOCA/ETS TOEIC VOCA.csv"
cp data/merged.json docs/words.json     # 앱에 반영
```

뜻과 품사는 CSV를 따르고 예문은 블로그에서 가져온다. 양쪽 모두 오타가 있어
`merge.py` 상단의 `BLOG_TYPOS` / `CSV_TYPOS` 표로 손수 교정한다. 퍼지 매칭은
`oversea`를 `overseas`로 잘못 잇는 등 위험이 커서 쓰지 않는다.

데이터를 다시 만들면 `sw.js`의 `CACHE` 값을 올린다.

수집이 끝나면 이상 항목 리포트가 출력된다. 예문 없는 단어, 미지의 품사, 빈 뜻,
분류하지 못한 줄. 파싱이 휴리스틱이라 원문 포맷이 바뀌면 여기서 먼저 드러난다.

블로그 원문에 오타가 있다(`access`↔`excess`, `기어`↔`기여`, `perfrom`). 크롤러는
원문을 그대로 보존한다.

## 로컬 실행

```bash
cd docs && python3 -m http.server 8765
# http://localhost:8765
```

`file://`로 직접 열면 `fetch`와 서비스워커가 막혀서 동작하지 않는다. 반드시 서버로 띄운다.

## GitHub Pages 배포

1. GitHub에 저장소를 만들고 push
2. Settings → Pages → Source를 `main` 브랜치 `/docs` 폴더로 지정
3. 1~2분 뒤 `https://<사용자>.github.io/<저장소>/` 로 열림
4. 폰에서 그 주소를 열고 공유 → **홈 화면에 추가**

홈 화면에서 실행하면 주소창 없이 뜨고, 비행기 모드에서도 열린다.

`docs/` 안의 파일을 고쳐서 배포할 때는 `sw.js`의 `CACHE` 값을 올리면
(`toeic-voca-v1` → `v2`) 기기에서 즉시 갱신된다. 올리지 않아도 다음번 실행 때
자동으로 갱신되지만 한 박자 늦다.

## 학습 방식

**Leitner 5박스.** 맞히면 다음 박스, 틀리면 1번 박스로 되돌아간다.

| 박스 | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| 다음 복습 | 1일 후 | 2일 후 | 4일 후 | 7일 후 | 15일 후 |

화면은 다섯 개다. 홈(오늘 복습·진도), 학습(플래시카드), 목록(검색·뜻 가리기),
퀴즈(4지선다), 설정.

단어의 절반에는 예문이 없다(CSV에서만 온 것들). 설정의 **출제 범위**에서
"예문 있는 것만"을 고르면 1,585단어로 좁혀진다. 출제 방향(영→한 / 한→영 / 혼합)은 플래시카드와 퀴즈에
함께 적용된다. 혼합 모드에서는 단어마다 방향이 고정되어 매번 흔들리지 않는다.

데스크톱 단축키: `Space` 뒤집기, `1` 모름, `2` 애매, `3` 안다.

## 학습 기록

`localStorage`에 저장된다. 브라우저별·기기별로 격리되므로 폰에서 외운 기록이
PC에는 보이지 않는다. 옮길 때는 설정 → 진도 내보내기 / 불러오기를 쓴다.
백업 용도로도 같다.

브라우저 데이터를 "쿠키 및 사이트 데이터 포함"으로 지우거나 시크릿 모드로 열지
않는 한 지워지지 않는다.

## 출처

<https://m.blog.naver.com/PostList.naver?blogId=ms_carrick&categoryNo=28>

개인 학습용으로만 쓴다.
