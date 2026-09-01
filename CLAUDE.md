# CLAUDE.md

바닐라 JS PWA. 빌드 도구도 의존성도 없다. 프로젝트 전반과 데이터 파이프라인은
`README.md`에 있다. 여기에는 코드를 읽어서는 알 수 없는 것만 적는다.

## 지켜야 할 것

- **앱에 이모지를 쓰지 않는다.** UI 문구, 버튼, 토스트, 어디에도.
- 주석과 UI 문구는 한국어로 쓴다. 주변 코드의 문체를 따른다.
- 빌드 단계가 없다. 타입 표기나 JSX를 넣으면 브라우저에서 그대로 깨진다.
- DOM은 `$` / `$$`(`app.js:50`)로 잡는다. `document.querySelector`를 직접 부르지 않는다.
- 세그먼트 버튼(`data-*`로 값을 고르는 버튼 묶음)은 `bindPick` / `markPick`을 쓴다.
  같은 코드를 손으로 또 쓰면 스물여섯 번째 사본이 된다.
- 원문 데이터를 임의로 고치지 않는다. 교정은 `merge.py` 상단의 표
  (`BLOG_TYPOS`, `MEANING_FIXES`, `EXAMPLE_FIXES` 등)에 근거를 남기고 넣는다.
  퍼지 매칭은 쓰지 않는다. `oversea`를 `overseas`로 잘못 잇는다.

## 깨뜨리면 조용히 망가지는 것

셋 다 실제로 겪었다. 공통점은 화면상 멀쩡해 보였다는 것이다.

- **`Store.save()`는 `queueMicrotask`로 모은다.** `setTimeout`이나 debounce로
  미루면 안 된다. 폰은 `pagehide`·`visibilitychange`가 안 뜨는 일이 잦고 타이머는
  정지되어서, 방금 채점한 기록이 그대로 날아간다.
- **서비스워커에서 `res.clone()`은 `await caches.open()` *앞*에서 한다.** 뒤로
  가면 `body already used`로 매번 던지는데 아무 데도 안 보인다. 이것 때문에
  런타임 캐싱이, 따라서 오프라인 발음 내려받기가 통째로 동작하지 않았다.
- **발음 캐시(`toeic-voca-audio`)는 버전을 붙이지도 지우지도 않는다.**
  `sw.js`의 activate와 `app.js`의 `checkVersion()` 양쪽에 예외가 있어야 한다
  (`app.js`의 `AUDIO_CACHE`). 지우면 사용자가 받아둔 24MB를 셀룰러로 다시 받는다.

## 배포

절차는 `README.md`에 있다. **세 번째 단계(별칭)를 빼먹으면 조용히 실패한다.**
배포는 성공했다고 나오는데 실제 주소는 이전 빌드를 계속 내려준다. 끝나면 확인한다.

```bash
curl -s https://toeic-voca-study.vercel.app/version.json
```

`sw.js`의 버전은 손으로 올리지 않는다. `bump_sw.py`가 `docs/` 내용의 해시로 뽑는다.

## 확인하고 말한다

이 앱에서 나온 버그는 대부분 눌러보기 전까지 멀쩡해 보였다. 고쳤다고 하기 전에
`cd docs && python3 -m http.server 8765`로 띄워 실제로 눌러보고, 데이터를
건드렸으면 수치를 세어 본다. `file://`로 열면 `fetch`와 서비스워커가 막혀
아무것도 확인되지 않는다.
