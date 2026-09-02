'use strict';

/* ── 상수 ─────────────────────────────────────────── */

// 배포할 때 bump_sw.py가 docs/ 내용 해시로 채운다. 설정에서 보여 주기 위한 것으로,
// 기기가 새 버전을 받았는지 눈으로 확인할 수 있다.
const BUILD = 'bd2fcbd7';

const STORAGE_KEY = 'toeic-voca-progress';
const SESSION_KEY = 'toeic-voca-session';
const THEME_KEY = 'toeic-voca-theme';
// sw.js의 AUDIO와 같은 이름이어야 한다. 사용자가 직접 내려받은 24MB라
// 앱을 갈아엎을 때도 이것만은 남긴다.
const AUDIO_CACHE = 'toeic-voca-audio';
// 상자별 복습 간격(일). 원본 Leitner는 칸 너비(1·2·5·8·14cm)로 정했고,
// 널리 쓰이는 변형은 1·2·4·7·14다. 그 사이값을 쓴다.
const BOX_INTERVALS = { 1: 1, 2: 2, 3: 4, 4: 9, 5: 14 };
const MAX_BOX = 5;
const LIST_PAGE = 80;
// 세션 안에서 다시 낼 때의 간격.
// 모름은 아예 몰랐으니 곧 다시 봐야 재학습이 된다.
// 애매는 곧 보면 단기기억으로 그냥 맞혀버려서 확인이 안 되므로 더 뒤에 낸다.
const RELEARN_GAP = { again: 5, hard: 15 };
// 한 세션에서 같은 단어를 다시 낼 최대 횟수. 없으면 모름을 계속 누를 때
// 큐가 끝없이 늘어나 세션이 끝나지 않는다. 한 세션에서 세 번을 틀렸다면
// 더 반복하는 것보다 내일 다시 보는 편이 낫다.
const RELEARN_MAX = { again: 3, hard: 1 };
const AUDIO_DIR = 'audio/';
// 발음 파일명은 해시 앞 16자리만 쓴다. 원래 이름(69자)을 3,155개 단어에
// 그대로 실으면 압축해도 84KB인데, 해시는 난수라 압축이 먹지 않는다.
const audioURL = f => AUDIO_DIR + f + '.mp3';

const DEFAULTS = {
  version: 1,
  // 처음 켰을 때의 값. 영->한으로 시작하고 등급은 교재(필수·만점)까지만 켠다.
  // 추가 어휘는 교재를 뗀 뒤에 켜는 것이라 기본으로 섞지 않는다.
  settings: { direction: 'en2ko', newPerDay: -1, onlyWithExample: false, autoplay: false,
              tiers: ['core', 'bonus'], theme: 'system', quizAffectsBox: false,
              quizType: 'meaning', examDate: '', targetPasses: 4, voiceMode: 'file',
              studyMode: 'card' },
  words: {},
  days: {},
  // 날짜별 학습량. {"2026-08-31": {n: 채점 수, f: 처음 본 단어 수}}
  // 계획이 '하루 127개'라고 말해도 실제로 몇 개 했는지 알 수가 없었다.
  log: {},
  session: null,
};

/* ── 유틸 ─────────────────────────────────────────── */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const todayISO = () => new Date().toLocaleDateString('sv-SE');  // YYYY-MM-DD (로컬)

/** 저장된 박스 값을 1~5 정수로 강제한다. 손상된 값이 스케줄을 망가뜨리지 않게. */
/** 목표 회독을 채우려면 마지막 새 단어를 시험 며칠 전에 시작해야 하나.
 *
 *  이 앱에서 회독은 계획에 넣는 숫자가 아니라 박스가 오른 결과다.
 *  '안다'만 눌러 올라간다고 보면 이렇게 된다:
 *
 *      1회 D+0  -> 박스 2      3회 D+6  -> 박스 4
 *      2회 D+2  -> 박스 3      4회 D+15 -> 박스 5
 *
 *  그래서 4회독이 목표면 시험 15일 전까지는 그 단어를 처음 봐야 한다.
 *  간격(BOX_INTERVALS)이 바뀌면 이 표도 따라 바뀌도록 계산해 둔다.
 */
const PASS_LEAD = (() => {
  const out = {};
  let day = 0, box = 1;
  for (let pass = 1; pass <= 6; pass++) {
    out[pass] = day;
    box = Math.min(MAX_BOX, box + 1);
    day += BOX_INTERVALS[box];
  }
  return out;
})();

/** 시험까지 남은 날. 시험일이 없으면 null. */
function daysToExam() {
  const iso = Store.settings.examDate;
  if (!iso) return null;
  const exam = new Date(iso + 'T00:00:00');
  const today = new Date(todayISO() + 'T00:00:00');
  if (isNaN(exam)) return null;
  return Math.round((exam - today) / 86400000);
}

/** 시험일과 목표 회독으로 하루 새 단어 수를 역산한다. */
function examPlan(freshLeft) {
  const left = daysToExam();
  if (left === null) return null;
  const passes = clampPasses(Store.settings.targetPasses);
  const lead = PASS_LEAD[passes];
  const usable = left - lead;
  return { left, passes, lead, usable, freshLeft,
           perDay: usable > 0 ? Math.ceil(freshLeft / usable) : null };
}

/** 저장소에서 온 값이 진짜 평범한 객체일 때만 쓴다.
 *  배열이나 null이 들어오면 기록이 배열인 채로 살아남아 조용히 어긋난다. */
const plainObject = v =>
  (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};

/** 목표 회독. 숫자가 아니면 Math.max가 NaN을 내고 PASS_LEAD[NaN]이
 *  undefined가 되어 '몇 일이 필요해'가 undefined로 찍힌다. clampBox와 같은 자리다. */
const clampPasses = v => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(6, Math.max(1, n)) : 4;
};

const clampBox = v => Math.min(MAX_BOX, Math.max(1, Math.round(Number(v)) || 1));

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('sv-SE');
}

/** 연달아 들어오는 입력은 마지막 것만 처리한다.
 *  한글은 자모마다 input이 튀어 '관리'만 쳐도 대여섯 번 들어온다. */
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** data-속성 이름을 dataset 키로. theme-opt → themeOpt */
const dataKey = a => a.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/** 세그먼트 버튼 묶음을 배선한다. 눌린 버튼의 data 값을 넘겨 준다. */
function bindPick(sel, attr, fn) {
  const key = dataKey(attr);
  $(sel).onclick = e => {
    const b = e.target.closest(`[data-${attr}]`);
    if (b && !b.disabled) fn(b.dataset[key], b);
  };
}

/** 세그먼트 버튼 묶음에서 지금 값에 해당하는 것만 켠다. */
function markPick(sel, attr, on) {
  const key = dataKey(attr);
  for (const b of $$(`${sel} button`)) b.classList.toggle('on', !!on(b.dataset[key], b));
}

/** 등급 하나를 켜고 끈다. 전부 끄는 것은 막는다 — 하나는 남겨둔다. */
function toggleTier(cur, tier) {
  const next = cur.includes(tier) ? cur.filter(t => t !== tier) : [...cur, tier];
  return next.length ? next : null;
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

/* ── 테마 ─────────────────────────────────────────── */

const Theme = {
  apply(mode) {
    const root = document.documentElement;
    if (mode === 'light' || mode === 'dark') root.dataset.theme = mode;
    else delete root.dataset.theme;
    // 테마만 따로 적어 둔다. 첫 화면을 그리기 전에 읽어야 깜빡임이 없는데,
    // 진도 뭉치(400KB) 안에 들어 있으면 그걸 통째로 파싱해야 한다.
    try { localStorage.setItem(THEME_KEY, mode); } catch (e) {}

    // 주소창 색도 맞춘다. standalone으로 띄웠을 때 상단 띠에 보인다.
    const dark = mode === 'dark' ||
      (mode !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    for (const el of $$('meta[name="theme-color"]')) el.remove();
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = dark ? '#09090b' : '#ffffff';
    document.head.appendChild(meta);
  },
};

/* ── 발음 재생 ────────────────────────────────────── */

const Audio_ = {
  el: null,
  primed: null,      // 미리 받아둔 파일
  warned: false,     // '발음을 받아야 한다'는 안내는 한 번만

  _audio() {
    if (!this.el) this.el = new Audio();
    return this.el;
  },

  /** 지금 보고 있는 카드의 발음을 미리 받아 둔다.
   *  안 받아두면 누른 뒤에야 통신이 시작돼 한참 조용하다. 8KB짜리라 부담도 없다. */
  prime(file) {
    if (!file || this.primed === file) return;
    this.primed = file;
    const el = this._audio();
    el.src = audioURL(file);
    el.load();
  },

  /** 누른 버튼에 상태를 입혀 준다. 눌렸는지, 받는 중인지, 실패했는지가 보여야 한다. */
  play(file, btn, word) {
    // 설정이 '내장 음성만'이거나 녹음이 없으면 기기 음성으로 읽는다
    if ((Store.settings.voiceMode === 'tts' || !file) && word && Speech.supported()) {
      return Speech.speak(word, btn);
    }
    if (!file) return;
    const el = this._audio();
    if (this.primed !== file) { this.primed = file; el.src = audioURL(file); }

    const mark = cls => {
      if (!btn) return;
      btn.classList.remove('loading', 'playing', 'failed');
      if (cls) btn.classList.add(cls);
    };
    const clear = () => mark(null);

    // 곧바로 나올 만큼 받아졌으면 로딩 표시를 띄우지 않는다 (깜빡임 방지)
    if (el.readyState < 3) mark('loading');

    el.onplaying = () => mark('playing');
    el.onended = clear;
    el.onerror = () => {
      mark('failed');
      setTimeout(clear, 1200);
      if (!this.warned) {
        this.warned = true;
        toast('발음을 재생하지 못했습니다. 설정에서 내려받아 두세요');
      }
    };

    el.currentTime = 0;
    el.play().then(() => { if (el.readyState >= 3) mark('playing'); })
             .catch(() => { mark('failed'); setTimeout(clear, 1200); });
  },

  /** 발음 버튼. 녹음이 없으면 내장 음성으로 읽을 수 있게 단어를 넘긴다.
   *  추가 어휘 1,033개는 녹음이 아예 없어 지금까지 버튼조차 없었다. */
  speakerHTML(file, cls = 'speak', word = '') {
    if (!file && !(word && Speech.supported())) return '';
    if (!file) {
      return `<button class="${cls} tts" type="button" data-say="${escapeHTML(word)}" aria-label="발음 듣기">`
        + `<svg viewBox="0 0 24 24" class="ico"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>`
        + `</button>`;
    }
    return `<button class="${cls}" type="button" data-audio="${escapeHTML(file)}" data-word="${escapeHTML(word)}" aria-label="발음 듣기">`
      + `<svg viewBox="0 0 24 24" class="ico"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>`
      + `</button>`;
  },

  /** 모든 발음을 서비스워커 캐시에 넣어 비행기 모드에서도 들리게 한다. */
  async prefetch(onProgress) {
    const files = [...new Set(State.words.map(w => w.audio).filter(Boolean))];
    let done = 0, failed = 0;
    const CONCURRENCY = 8;
    const queue = files.slice();

    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) {
        const f = queue.pop();
        try {
          const res = await fetch(audioURL(f), { cache: 'force-cache' });
          if (!res.ok) failed++;
        } catch { failed++; }
        onProgress(++done, files.length);
      }
    }));
    return { total: files.length, failed };
  },
};

/** 예문을 기기 내장 음성으로 읽어 준다.
 *
 *  단어 발음은 mp3로 받아 뒀지만 예문은 없다. 4,305문장을 녹음해 실으면
 *  수백 MB다. 토익은 절반이 듣기라 눈으로만 보는 것보다는 읽어 주는 편이
 *  낫고, 내장 음성은 파일도 통신도 0이다. 오프라인에서도 된다.
 */
const Speech = {
  voice: undefined,

  /* macOS·iOS에는 Albert, Bad News, Bubbles 같은 효과음 목소리가 en-US로
     등록돼 있다. 알파벳순 첫 번째를 집으면 Albert가 걸려 단어를 로봇처럼
     읽는다. 실제로 그랬다. 그래서 순서를 정해 고른다. */
  /** 목소리 목록은 늦게 채워진다. 한 번 비었을 때의 결과를 캐시해 두면
   *  나중에 목록이 와도 영영 '없음'으로 남는다. 목록이 바뀌면 다시 고른다. */
  watch() {
    if (this._watching || !this.supported()) return;
    this._watching = true;
    speechSynthesis.addEventListener('voiceschanged', () => { this.voice = undefined; });
  },

  pick() {
    this.watch();
    const all = speechSynthesis.getVoices();
    if (!all.length) { this.voice = undefined; return undefined; }   // 아직 안 왔다
    if (this.voice !== undefined) return this.voice;
    const en = all.filter(v => v.lang && v.lang.toLowerCase().startsWith('en'));
    // 영어가 하나도 없으면 목록이 덜 온 것일 수 있다. 캐시하지 않고 다음에 다시 본다.
    if (!en.length) return null;

    // 플랫폼마다 이름이 다르다. 기본 읽기 음성으로 쓰이는 것들.
    const GOOD = /^(samantha|alex|google us english|google uk english|microsoft (zira|aria|david|guy)|karen|daniel|moira|tessa|siri)/i;
    // macOS 효과음 목소리. 이름이 곧 정체다.
    const JOKE = /^(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|junior|kathy|princess|ralph|fred|hysterical|pipe organ|bruce|agnes|vicki|victoria)$/i;

    const usable = en.filter(v => !JOKE.test(v.name.trim()));
    const pool = usable.length ? usable : en;
    this.voice =
      pool.find(v => v.default)                                        // 시스템 기본
      || pool.find(v => GOOD.test(v.name) && v.lang === 'en-US')       // 이름으로 아는 것
      || pool.find(v => GOOD.test(v.name))
      || pool.find(v => v.lang === 'en-US')
      || pool[0]
      || null;
    return this.voice;
  },

  supported() {
    return typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
  },

  warned: false,

  /** iOS는 첫 발화가 반드시 사용자 손짓 안에서 일어나야 한다. 그 전에
   *  아무것도 안 시켜 두면 나중에 눌러도 조용하다.
   *
   *  소리 없는 mp3를 한 번 틀어 오디오 세션도 함께 깨운다. 단어 발음(mp3)은
   *  나는데 내장 음성만 안 나는 기기가 있어서다 - 둘이 다른 통로를 쓴다. */
  prime() {
    if (this.primed || !this.supported()) return;
    this.primed = true;
    try {
      // 44바이트짜리 무음 wav. 오디오 세션을 여는 용도로만 쓴다.
      const a = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=');
      a.volume = 0;
      a.play().catch(() => {});
    } catch (e) {}
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    } catch (e) {}
  },

  /** 왜 조용한지 알아야 고칠 수 있다. 설정에서 이걸 보여 준다. */

  speak(text, btn) {
    if (!this.supported() || !text) return;
    this.prime();
    // cancel()을 무조건 부르면 iOS에서 큐가 멎는다. 정말 말하는 중일 때만.
    if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
    if (speechSynthesis.paused) speechSynthesis.resume();

    const u = new SpeechSynthesisUtterance(text);
    const v = this.pick();
    if (v) u.voice = v;
    u.lang = (v && v.lang) || 'en-US';
    u.rate = 0.95;                          // 토익 성우보다 아주 조금 느리게

    const clear = () => btn && btn.classList.remove('playing');
    if (btn) btn.classList.add('playing');
    u.onend = clear;
    u.onerror = clear;

    speechSynthesis.speak(u);

    // 소리가 안 나는 기기가 있다. 조용히 실패하면 고장인지 무음인지 알 수 없다.
    setTimeout(() => {
      if (speechSynthesis.speaking || speechSynthesis.pending) return;
      clear();
      if (!this.warned) {
        this.warned = true;
        toast('소리가 안 나면 무음 스위치와 볼륨을 확인해 주세요');
      }
    }, 700);
  },
};

/* ── 저장소 ───────────────────────────────────────── */

const Store = {
  data: structuredClone(DEFAULTS),
  bytes: 0,

  load() {
    let migrated = false;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      this.bytes = raw ? raw.length : 0;
      if (raw) {
        const parsed = JSON.parse(raw);
        this.data = {
          ...structuredClone(DEFAULTS),
          ...parsed,
          settings: { ...DEFAULTS.settings,
                      ...(parsed.settings && typeof parsed.settings === 'object'
                          && !Array.isArray(parsed.settings) ? parsed.settings : {}) },
          // 손상된 저장소에서 배열이나 원시값이 들어오면 그대로 굳는다.
          // 배열도 typeof는 'object'라 그것만으로는 못 거른다.
          words: plainObject(parsed.words),
          days: plainObject(parsed.days),
          log: plainObject(parsed.log),
        };
      }
      // 이어보기는 따로 담아 두었다 (본 진도와 함께 쓰면 카드마다 62KB가 더 붙는다)
      const rawSession = localStorage.getItem(SESSION_KEY);
      if (rawSession) this.data.session = JSON.parse(rawSession);

      const t = this.data.settings.tier;
      if (typeof t === 'string') {
        // 예전에는 등급을 하나만 고를 수 있었다. 이제 여러 개를 겹쳐 고른다.
        this.data.settings.tiers = t === 'all' ? ['core', 'bonus', 'extra'] : [t];
        delete this.data.settings.tier;
        migrated = true;
      }
      if (!Array.isArray(this.data.settings.tiers) || !this.data.settings.tiers.length) {
        // 저장소가 깨졌을 때의 복구. 기본값을 그대로 쓴다.
        this.data.settings.tiers = [...DEFAULTS.settings.tiers];
      }
      if (typeof this.data.settings.dailyLimit === 'number') {
        // 예전에는 복습과 새 단어를 합쳐서 잘랐다. 이제 새 단어만 제한한다.
        // 예전에는 0이 무제한을 뜻했다. 지금은 0이 '없음'이라 뜻이 뒤집힌다.
        const old = this.data.settings.dailyLimit;
        this.data.settings.newPerDay = old === 0 ? -1 : old;
        delete this.data.settings.dailyLimit;
        migrated = true;
      }
    } catch (e) {
      console.warn('진도를 읽지 못했습니다. 새로 시작합니다.', e);
    }
    if (migrated) this.save();
    return this.data;
  },

  /** 단어 데이터가 바뀌어 없어진 id의 기록을 정리한다. */
  prune(validIds) {
    let dropped = 0;
    for (const id of Object.keys(this.data.words)) {
      if (!validIds.has(id)) { delete this.data.words[id]; dropped++; }
    }
    if (dropped) this.save();
    return dropped;
  },

  /* 진도 저장.
   *
   * 카드 한 장을 채점하면 grade()와 saveSession()이 각각 저장을 부른다.
   * 예전에는 그때마다 400KB를 통째로 직렬화해 두 번 썼다. 그래서 한 번
   * 500ms 미뤘다가 몰아 쓰게 바꿨는데, 그 사이에 앱이 꺼지면 그 채점이
   * 통째로 날아갔다. 폰에서는 앱 전환기로 밀어 없앨 때 pagehide도
   * visibilitychange도 안 뜨는 경우가 흔하다. 진도를 잃는 것보다는
   * 몇 밀리초 느린 편이 낫다.
   *
   * 그래서 지금은 미루지 않는다. 대신 같은 처리 안에서 여러 번 불러도
   * 마이크로태스크로 묶어 한 번만 쓴다. 마이크로태스크는 그 처리가 끝나기
   * 전에 반드시 실행되므로, 브라우저가 중간에 페이지를 죽일 틈이 없다.
   */
  _pending: false,

  save() {
    if (this._pending) return;
    this._pending = true;
    queueMicrotask(() => this.flush());
  },

  flush() {
    this._pending = false;
    try {
      // 이어보기(session)는 따로 담는다. 큐의 id 4,190개가 본 진도에 섞이면
      // 카드를 넘길 때마다 그만큼을 같이 쓰게 된다.
      const { session, ...rest } = this.data;
      const blob = JSON.stringify(rest);
      this.bytes = blob.length;
      localStorage.setItem(STORAGE_KEY, blob);
      if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      else localStorage.removeItem(SESSION_KEY);
    } catch (e) {
      toast('저장 공간이 부족합니다');
      console.error(e);
    }
  },

  get settings() { return this.data.settings; },

  record(id) {
    return this.data.words[id] || null;
  },

  /** 그날 몇 개를 채점했고 그중 몇 개가 처음 보는 단어였는지 센다.
   *  계획(하루 몇 개)과 실제를 나란히 놓으려면 이 숫자가 있어야 한다. */
  log(date, fresh) {
    const day = this.data.log[date] || (this.data.log[date] = { n: 0, f: 0 });
    day.n++;
    if (fresh) day.f++;
    // 반년치만 남긴다. 그 이상은 볼 일이 없고 저장만 늘린다.
    const keys = Object.keys(this.data.log);
    if (keys.length > 200) {
      for (const k of keys.sort().slice(0, keys.length - 180)) delete this.data.log[k];
    }
  },

  /** 되돌리기로 채점을 취소하면 그날 개수도 함께 되돌린다.
   *  안 그러면 열 번 누르고 세 번 되돌려도 '오늘 10개'로 남는다. */
  unlog(date, wasFresh) {
    const day = this.data.log[date];
    if (!day) return;
    day.n = Math.max(0, day.n - 1);
    if (wasFresh) day.f = Math.max(0, day.f - 1);
    if (!day.n && !day.f) delete this.data.log[date];
  },

  /** 최근 며칠간의 기록. 오늘부터 거슬러 올라간다. */
  recent(days) {
    const out = [];
    const base = new Date(todayISO() + 'T00:00:00');
    for (let i = 0; i < days; i++) {
      const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() - i);
      const iso = d.toLocaleDateString('sv-SE');
      out.push({ date: iso, ...(this.data.log[iso] || { n: 0, f: 0 }) });
    }
    return out;
  },

  ensure(id) {
    if (!this.data.words[id]) {
      this.data.words[id] = { box: 1, due: todayISO(), correct: 0, wrong: 0, lastSeen: null };
    }
    return this.data.words[id];
  },

  /** 진도만 지운다. 테마·등급·방향 같은 설정은 남긴다. */
  reset() {
    const keep = { ...this.data.settings };
    this.data = structuredClone(DEFAULTS);
    this.data.settings = keep;
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
    // 목록 채점의 되돌리기 버퍼에는 지우기 전 기록이 들어있다. 그대로 두면
    // 초기화한 뒤 목록에서 등급을 바꿀 때 그 기록이 되살아난다.
    listGrades.clear();
    this.flush();
  },

  /** 한 DAY의 기록만 지운다. 다른 DAY 진도는 건드리지 않는다. */
  resetDay(day) {
    const ids = (State.byDay.get(day) || []).map(w => w.id);
    let n = 0;
    for (const id of ids) {
      if (this.data.words[id]) { delete this.data.words[id]; n++; }
    }
    delete this.data.days[day];
    if (this.data.session && this.data.session.dayFilter === day) delete this.data.session;
    this.flush();
    return n;
  },
};

/* ── 스케줄러 (Leitner 5박스) ─────────────────────── */

const Scheduler = {
  /** 오늘 볼 단어를 기한이 된 것과 아직 안 본 것으로 나눠 돌려준다.
   *
   *  복습은 자르지 않는다. 이미 오늘 보기로 예정된 것들이라 자르면 그대로 밀리고,
   *  밀린 양이 매일 쌓여 영영 따라잡지 못한다. 제한은 새 단어에만 건다.
   */
  split({ dayFilter = null, newCap = null } = {}) {
    const today = todayISO();
    const pool = inScope(dayFilter ? (State.byDay.get(dayFilter) || []) : State.words);
    const due = [], fresh = [];

    for (const w of pool) {
      const rec = Store.record(w.id);
      if (!rec) fresh.push(w);
      else if (rec.due <= today) due.push(w);
    }
    // YYYY-MM-DD는 사전순이 곧 날짜순이다. localeCompare는 비교마다 Intl을
    // 부르느라 8배 느리고, 여기서는 아무것도 더 해주지 않는다.
    due.sort((a, b) => {
      const x = Store.record(a.id).due, y = Store.record(b.id).due;
      return x < y ? -1 : x > y ? 1 : 0;
    });

    const cap = newCap ?? Store.settings.newPerDay;
    // 0은 '새 단어 없음', -1은 '제한 없음'. 예전에는 0이 무제한을 뜻했다.
    const taken = cap < 0 ? fresh : fresh.slice(0, Math.max(0, cap));
    return { due, fresh: taken, freshTotal: fresh.length };
  },

  session(opts = {}) {
    const { due, fresh } = this.split(opts);
    return [...shuffle(due), ...fresh];
  },

  /** DAY를 직접 골랐을 때 기한을 따지지 않고 전부 본다.
   *  길게 눌러 '전체 다시 보기'를 골랐을 때 쓴다. */
  everything(dayFilter) {
    return shuffle(inScope(State.byDay.get(dayFilter) || []));
  },

  /** DAY를 누르면 나오는 것: 아직 안 본 것과 기한이 된 것.
   *
   *  예전에는 무조건 그 DAY 전부를 다시 냈다. 101개 중 87개를 끝내고 다시
   *  들어가면 처음부터 101장이 나왔다. 어디까지 했는지 알 수 없고,
   *  남은 14개를 보려면 87장을 넘겨야 했다.
   *
   *  다 끝냈고 기한도 안 됐으면 그때는 전부 내준다. 빈 화면보다는 낫다.
   */
  dayQueue(dayFilter) {
    const today = todayISO();
    const pool = inScope(State.byDay.get(dayFilter) || []);
    const fresh = [], due = [];
    for (const w of pool) {
      const rec = Store.record(w.id);
      if (!rec) fresh.push(w);
      else if (rec.due <= today) due.push(w);
    }
    // 다 끝냈고 기한도 안 됐으면 빈 채로 돌려준다. 예전에는 여기서 그 DAY를
    // 통째로 다시 내줬는데, 끝낸 DAY를 눌렀을 때 101장이 처음부터 또 나와
    // '끝냈는데 왜 또 나오지'가 됐다. 전부 다시 보려면 길게 눌러 고른다.
    // 기한이 된 복습을 먼저 털고 새 단어로 넘어간다
    return [...shuffle(due), ...fresh];
  },

  /** 지금까지 한 번이라도 본 단어 전부. 기한은 따지지 않는다.
   *  DAY 3까지 떼고 바로 훑고 싶을 때 쓴다. */
  learned() {
    return shuffle(inScope(State.words).filter(w => Store.record(w.id)));
  },

  /** 모름을 누른 적 있는 단어. 많이 누른 것부터 내보낸다.
   *
   *  '틀린 단어'라고 부르지 않는다. 플래시카드에는 채점기가 없어 틀릴 일이
   *  없다. 뒤집었더니 안 떠올라서 본인이 모름이라고 신고한 것뿐이다.
   *  진짜 오답은 사지선다인 퀴즈에만 있다. */
  weak() {
    return inScope(State.words)
      .filter(w => (Store.record(w.id) || {}).wrong > 0)
      .sort((a, b) => {
        const ra = Store.record(a.id), rb = Store.record(b.id);
        return (rb.wrong - ra.wrong) || (ra.correct - rb.correct);
      });
  },

  /** 기한이 됐는지. 아직 한 번도 안 본 단어는 항상 기한으로 본다. */
  isDue(id) {
    const rec = Store.record(id);
    return !rec || !rec.lastSeen || rec.due <= todayISO();
  },

  grade(id, result) {
    const due = this.isDue(id) || result === 'known';
    const fresh = !Store.record(id);        // ensure 전에 봐야 처음인지 안다
    const rec = Store.ensure(id);
    const today = todayISO();
    Store.log(today, fresh);
    // 저장소가 손상돼 box가 숫자가 아니면 BOX_INTERVALS[NaN]이 undefined가 되고
    // due가 "Invalid Date"로 굳는다. 그러면 그 단어는 영영 기한이 오지 않는다.
    rec.box = clampBox(rec.box);

    if (result === 'again') {
      // 모름은 기한과 무관하게 반영한다. 모른다는 건 진짜 모르는 것이다.
      rec.box = 1;
      rec.wrong++;
      rec.due = addDays(today, BOX_INTERVALS[1]);
    } else if (result === 'known') {
      // 원래 알던 단어. 한 칸씩 올리며 한 달을 쓰는 대신 바로 마지막 박스로 보낸다.
      // 완전히 빼지는 않는다. 정말 아는지 한 번은 확인해야 한다.
      rec.box = MAX_BOX;
      rec.correct++;
      rec.due = addDays(today, BOX_INTERVALS[MAX_BOX]);
    } else if (!due) {
      // 기한 전에 미리 본 것. 맞혔다고 간격을 늘리면 박스가 거짓말을 한다.
      // 하루 간격으로 떠올린 것을 근거로 2주 뒤를 장담할 수는 없다.
      //
      // 세션 안에서 다시 낸 카드도 여기로 온다. 모름을 누른 순간 기한이 내일로
      // 잡히므로, 몇 장 뒤에 다시 만나 안다를 눌러도 박스가 오르지 않는다.
      // 방금 본 것을 단기기억으로 맞힌 것이지 외운 것이 아니기 때문이다.
      rec.correct++;
    } else if (result === 'hard') {
      // 마지막 박스에서는 박스가 못 올라가 안다와 간격이 같아진다.
      // 애매는 확신이 없다는 뜻이므로 한 칸 물러서게 한다.
      if (rec.box >= MAX_BOX) rec.box = MAX_BOX - 1;
      rec.correct++;
      rec.due = addDays(today, BOX_INTERVALS[rec.box]);
    } else {
      rec.box = Math.min(MAX_BOX, rec.box + 1);
      rec.correct++;
      rec.due = addDays(today, BOX_INTERVALS[rec.box]);
    }
    rec.lastSeen = today;

    // 예전에는 id에서 'd01'을 잘라 썼는데, 추가 어휘는 'x-voucher' 꼴이라
    // Number('-v')가 NaN이 되어 days.NaN에 쌓였다. 단어가 제 DAY를 알고 있다.
    const w = State.byId.get(id);
    if (w && Number.isFinite(w.day)) {
      Store.data.days[w.day] = { lastStudied: todayISO() };
    }
    Store.save();
    return rec;
  },
};

/* ── 앱 상태 ──────────────────────────────────────── */

const State = {
  meta: null,
  days: [],
  words: [],
  byId: new Map(),
  byDay: new Map(),
  view: 'home',
  study: null,
  quiz: null,
  quizDay: 1,
  // stage: null(전체) | 1~5(그 박스) | 'new'(아직 안 봄) | 'seen'(한 번 이상 봄)
  // boxes: 고른 박스들(비면 전체). stage: null | 'new'(아직 안 봄) | 'seen'(한 번 이상 봄)
  list: { day: null, boxes: [], query: '', masked: false, weakOnly: false,
          stage: null, shown: LIST_PAGE },
};

async function loadData() {
  // 신선도는 서비스워커가 버전으로 관리한다. no-cache를 주면 실행할 때마다
  // 쓸데없이 통신을 깨워 조건부 요청을 한 번 더 보낸다.
  const res = await fetch('words.json');
  if (!res.ok) throw new Error('words.json 로드 실패: ' + res.status);
  const json = await res.json();

  State.meta = json.meta;
  State.days = json.days;
  for (const day of json.days) {
    State.byDay.set(day.day, day.words);
    for (const w of day.words) {
      w.day = day.day;
      // 뜻·품사·검색어를 여기서 한 번 만들어 둔다. 예전에는 화면을 그릴 때마다
      // 단어마다 Set과 배열을 새로 만들어, 검색어 한 글자에 2만 번씩 할당했다.
      w.meaning = [...new Set(w.senses.map(s => s.meaning))].join('; ');
      w.pos = w.senses.map(s => s.pos).filter(Boolean).join(' ');
      w.q = (w.headword + ' ' + w.meaning + ' ' +
             w.examples.map(e => e.en).join(' ')).toLowerCase();
      State.words.push(w);
      State.byId.set(w.id, w);
    }
  }
}

/* ── 표시 헬퍼 ────────────────────────────────────── */

/** 설정(등급, 예문 유무)에 맞는 단어만 남긴다. 학습·퀴즈·통계가 모두 이걸 쓴다. */
function inScopeWord(w) {
  const { tiers, onlyWithExample } = Store.settings;
  return tiers.includes(w.tier) && (!onlyWithExample || w.examples.length);
}

function inScope(words) {
  const { tiers, onlyWithExample } = Store.settings;
  return words.filter(w =>
    tiers.includes(w.tier) &&
    (!onlyWithExample || w.examples.length));
}

/** 최근 2주 학습량.
 *
 *  숫자 한 줄로는 '꾸준히 했는지 몰아서 했는지'가 안 보인다. 막대로 보면
 *  빈 날이 어디였는지 한눈에 들어온다.
 *
 *  막대는 두 층이다. 아래가 새 단어, 위가 복습. 복습은 내가 정하는 게
 *  아니라 기한이 정해 주는 것이라, 둘을 섞어 놓으면 '오늘 열심히 했다'가
 *  새 단어를 많이 봤다는 뜻인지 복습이 몰린 날인지 알 수 없다.
 */
const CHART_DAYS = 14;

function renderChart(freshLeft) {
  const el = $('#chart');
  const days = Store.recent(CHART_DAYS).reverse();      // 왼쪽이 옛날
  const max = Math.max(...days.map(d => d.n));
  if (!max) { el.hidden = true; return; }
  el.hidden = false;

  const plan = examPlan(freshLeft);
  const goal = plan && plan.perDay;
  // 목표선이 막대 위로 한참 솟으면 막대가 다 눌린다. 화면 안에 있을 때만 긋는다.
  const top = goal && goal <= max * 1.6 ? Math.max(max, goal) : max;

  const bars = days.map((d, i) => {
    const isToday = i === days.length - 1;
    const h = d.n / top * 100;
    const fh = d.n ? d.f / d.n * 100 : 0;               // 막대 안에서 새 단어가 차지하는 몫
    const label = Number(d.date.slice(8, 10));
    return `<div class="bar${isToday ? ' today' : ''}" title="${d.date} · ${d.n}개">`
      + `<i style="height:${h.toFixed(1)}%"><b style="height:${fh.toFixed(1)}%"></b></i>`
      + `<span>${label}</span></div>`;
  }).join('');

  const line = goal && goal <= top
    ? `<div class="goal" style="bottom:${(goal / top * 100).toFixed(1)}%">`
      + `<span>${goal.toLocaleString()}</span></div>` : '';

  el.innerHTML = `<div class="chart-plot">${line}${bars}</div>`
    + `<div class="chart-key"><span class="k-f"></span>새 단어`
    + `<span class="k-n"></span>복습`
    + (goal ? `<span class="k-g"></span>하루 몫` : '') + `</div>`;
}

/** 오늘 얼마나 했는지, 요즘 어느 정도 속도인지.
 *
 *  계획만 있고 실적이 없으면 밀리고 있는지 알 수가 없다. 오늘 개수와
 *  최근 이레의 하루 평균을 나란히 둔다. 시험일이 있으면 목표와 견준다.
 */
function renderTodayLine(freshLeft) {
  const el = $('#today-line');
  const week = Store.recent(7);
  const today = week[0];
  const done = week.reduce((a, d) => a + d.n, 0);
  if (!done) { el.hidden = true; return; }     // 한 번도 안 했으면 빈 줄을 두지 않는다

  el.hidden = false;
  const avg = Math.round(done / 7);
  const plan = examPlan(freshLeft);
  const goal = plan && plan.perDay;

  let head = `오늘 <b>${today.n.toLocaleString()}개</b>`;
  if (today.f) head += ` <span class="dim">(새 단어 ${today.f.toLocaleString()})</span>`;
  if (goal) {
    const pct = Math.min(100, Math.round(today.f / goal * 100));
    head += ` <span class="dim">· 오늘 몫 ${goal.toLocaleString()}개 중 ${pct}%</span>`;
  }
  el.innerHTML = head + ` <span class="dim">· 최근 이레 하루 평균 ${avg.toLocaleString()}개</span>`;
}

/** 시험일을 넣어 두었으면 남은 날과 하루 몫을 알려 준다.
 *
 *  '하루에 몇 개'를 감으로 정하는 대신 시험일에서 역산한다. 회독은 박스가
 *  오른 결과라, 목표 회독마다 마지막 새 단어를 시작해야 하는 시점이 정해진다.
 */
function renderExamLine(freshLeft) {
  const el = $('#exam-line');
  const plan = examPlan(freshLeft);
  if (!plan) { el.hidden = true; return; }
  el.hidden = false;

  if (plan.left < 0) {
    el.innerHTML = `시험일이 지났습니다 <span class="dim">· 설정에서 날짜를 바꾸거나 지우세요</span>`;
    return;
  }
  const dday = plan.left === 0 ? '오늘이 시험일입니다' : `시험까지 <b>D-${plan.left}</b>`;
  if (!freshLeft) {
    el.innerHTML = `${dday} <span class="dim">· 새로 볼 단어가 없습니다. 복습만 하면 됩니다</span>`;
    return;
  }
  if (plan.perDay === null) {
    // 남은 날이 목표 회독에 필요한 기간보다 짧다
    const can = Object.entries(PASS_LEAD)
      .filter(([, lead]) => plan.left - lead > 0)
      .map(([n]) => Number(n));
    const best = can.length ? Math.max(...can) : 0;
    el.innerHTML = `${dday} <span class="dim">· ${plan.passes}회독은 ${plan.lead}일이 필요해 시간이 모자랍니다`
      + (best ? ` (${best}회독까지 가능)` : '') + `</span>`;
    return;
  }
  el.innerHTML = `${dday} <span class="dim">·</span> ${plan.passes}회독하려면 `
    + `하루 <b>${plan.perDay.toLocaleString()}개</b> `
    + `<span class="dim">(${plan.usable}일 안에 ${freshLeft.toLocaleString()}개, `
    + `마지막 ${plan.lead}일은 복습)</span>`;
}

/** 홈에 필요한 숫자를 한 번에 센다.
 *
 *  예전에는 전체·본 것·외운 것·틀린 것·기한·박스 분포를 각각 세느라
 *  4,190개를 아홉 번 훑고 그때마다 배열을 새로 만들었다. 홈을 누를 때마다,
 *  설정을 건드릴 때마다 그게 다 돌았다. 한 바퀴면 충분하다.
 */
function homeStats() {
  const today = todayISO();
  const boxes = [0, 0, 0, 0, 0];
  let total = 0, seen = 0, mastered = 0, weak = 0, due = 0, freshTotal = 0;
  for (const w of State.words) {
    if (!inScopeWord(w)) continue;
    total++;
    const r = Store.record(w.id);
    if (!r) { freshTotal++; continue; }
    seen++;
    const b = clampBox(r.box);
    boxes[b - 1]++;
    if (b >= MAX_BOX) mastered++;
    if (r.wrong > 0) weak++;
    if (r.due <= today) due++;
  }
  const cap = Store.settings.newPerDay;
  const fresh = cap < 0 ? freshTotal : Math.min(freshTotal, Math.max(0, cap));
  return { total, seen, mastered, weak, due, fresh, freshTotal, boxes };
}

const TIER_LABEL = { core: '필수', bonus: '만점', extra: '추가' };

const stageLabel = st =>
  st === 'new' ? '아직 안 본 단어' : st === 'seen' ? '본 단어' : '';

/** DAY의 단원명. '동사 (1)'처럼 번호가 붙은 것은 묶을 때 번호를 뗀다. */
const dayTitle = day => {
  const d = State.days.find(x => x.day === day);
  return d ? (d.title || '') : '';
};
// 원본 표기가 들쭉날쭉하다. '필수 어휘'와 '필수어휘'가 섞여 있고 ETS 접두어도
// 붙었다 말았다 한다. 그대로 묶으면 DAY 5·6·7이 세 덩어리로 갈린다.
const meaningText = w => w.meaning;
const posText = w => w.pos;

/** id를 숫자로 바꾼다. 같은 단어가 매번 같은 판정을 받게 하려고 쓴다. */
function hashOf(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h);
}

/** 이 카드를 어느 방향으로 낼지 결정한다. */
function directionFor(id) {
  const dir = Store.settings.direction;
  if (dir !== 'mixed') return dir;
  // 같은 단어는 같은 방향이 되도록 id를 해시한다 (매번 흔들리지 않게)
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return (h & 1) ? 'ko2en' : 'en2ko';
}

function sensesHTML(w) {
  return w.senses.map(s => `
    <div class="sense">
      ${s.pos ? `<span class="pos">${escapeHTML(s.pos)}</span>` : ''}
      <span class="meaning">${escapeHTML(s.meaning)}</span>
    </div>`).join('');
}

function cardBackHTML(w) {
  const examples = w.examples.map(e => `
    <div class="ex">
      <div class="en">${escapeHTML(e.en)}${e.generated ? '<span class="gen">생성</span>' : ''}</div>
      ${e.ko ? `<div class="ko">${escapeHTML(e.ko)}${
        // 영어는 원문 그대로고 해석만 우리가 붙인 경우. 예문 자체를 만든
        // '생성'과는 다르므로 구분해서 표시한다.
        !e.generated && e.koGen ? '<span class="gen">해석</span>' : ''}</div>` : ''}
    </div>`).join('');

  const colloc = w.collocations.length ? `
    <div class="colloc">${w.collocations.map(c =>
      `<span><b>${escapeHTML(c.en)}</b>${c.ko ? ' ' + escapeHTML(c.ko) : ''}</span>`).join('')}
    </div>` : '';

  return `
    <div class="head"><h3>${escapeHTML(w.headword)}</h3>${Audio_.speakerHTML(w.audio, 'speak', w.headword)}</div>
    ${sensesHTML(w)}
    ${examples || colloc ? '<div class="divider"></div>' : ''}
    ${examples}${colloc}`;
}

/* ── 홈 ───────────────────────────────────────────── */

function renderHome() {
  // 통계도 지금 범위 안에서만 센다. 전체를 세면 '본 단어 3,000 / 전체 1,666'처럼
  // 앞뒤가 안 맞는 숫자가 나온다.
  const st = homeStats();
  const { total, seen, mastered, due, fresh, freshTotal, boxes } = st;

  const notes = [];
  const picked = Store.settings.tiers;
  if (picked.length < 3) notes.push(picked.map(t => TIER_LABEL[t]).join('+') + ' 어휘');
  if (Store.settings.onlyWithExample) notes.push('예문 있는 것만');
  $('#home-sub').textContent =
    `${State.meta.dayCount}일 · ${total.toLocaleString()}단어` +
    (notes.length ? ` (${notes.join(', ')})` : ` · 예문 ${State.meta.withExample.toLocaleString()}개`);

  $('#due-count').textContent = due + fresh;
  // 세션은 '복습(기한이 된 것)'과 '새 단어(처음 보는 것)'로 이루어진다.
  // 둘을 합쳐 부를 때는 '학습'이라고 한다.
  $('#due-label').textContent = (due || fresh)
    ? (due && fresh ? `복습 ${due}개 + 새 단어 ${fresh}개`
      : due ? `복습 ${due}개` : `새 단어 ${fresh}개`)
    : (freshTotal ? '오늘 몫은 끝났습니다' : '모든 단어를 다 봤습니다');

  renderExamLine(freshTotal);
  renderTodayLine(freshTotal);
  renderChart(freshTotal);
  $('#start-review').disabled = !(due || fresh);

  const learned = seen;
  const reviewBtn = $('#review-learned');
  reviewBtn.hidden = learned === 0;
  // 아래 통계 칸과 같은 집합이라 같은 이름을 쓴다. '배운'은 다 외웠다는
  // 뉘앙스인데 실제로는 한 번 채점했다는 뜻뿐이다.
  reviewBtn.textContent = `본 단어 (${learned.toLocaleString()})`;

  const weak = st.weak;
  const weakBtn = $('#review-weak');
  weakBtn.hidden = weak === 0;
  weakBtn.textContent = `안 떠오른 단어 (${weak.toLocaleString()})`;

  $('#stat-seen').textContent = seen.toLocaleString();
  $('#stat-mastered').textContent = mastered.toLocaleString();
  $('#stat-total').textContent = total.toLocaleString();

  // 각 칸을 눌러 그 단계의 단어를 바로 볼 수 있게 한다.
  // 숫자만 보이고 어떤 단어인지 알 수 없으면 분포를 봐도 할 일이 없다.
  $('#boxbar').innerHTML = boxes.map((n, i) =>
    `<button data-stage="${i + 1}"${n ? '' : ' disabled'}><b>${n}</b><span>박스 ${i + 1}</span></button>`).join('');

  // DAY 1~30은 공식 교재, 31부터는 다른 단어장이라 눈에 띄게 갈라 보여준다
  const cell = d => {
    let n = 0, done = 0;
    for (const w of d.words) {
      if (!inScopeWord(w)) continue;
      n++;
      if (Store.record(w.id)) done++;
    }
    if (!n) return '';
    const pct = Math.round(done / n * 100);
    return `<button class="day-cell${pct === 100 ? ' done' : ''}" data-day="${d.day}">
      <b>${String(d.day).padStart(2, '0')}</b>
      <span>${done}/${n}</span>
      <i class="bar" style="width:${pct}%"></i>
    </button>`;
  };
  // 칸을 단원별로 묶어 봤는데 5열 정렬이 깨져 오히려 읽기 나빴다.
  // 단원명은 DAY를 눌렀을 때(학습 화면·시트·목록)와 사용 가이드에서 본다.
  const official = State.days.filter(d => d.day <= 30).map(cell).join('');
  const extraCells = State.days.filter(d => d.day > 30).map(cell).join('');
  $('#day-grid').innerHTML = official;
  $('#day-grid-extra').innerHTML = extraCells;
  $('#extra-group').hidden = !extraCells;
  $('#official-group').hidden = !official;
}

/* ── 학습 (플래시카드) ────────────────────────────── */

/** 오늘 이어볼 수 있는 세션. 없으면 null.
 *
 *  어제 만든 세션을 오늘 이어보면 안 된다. 그 카드들은 이미 채점돼 기한이 미래라
 *  아무리 눌러도 박스가 움직이지 않고, 오늘 볼 것은 그대로 남는다.
 *  손댄 적 없는 세션도 잇지 않는다. 새로 만드는 것과 같다. */
function savedSession() {
  const s = Store.data.session;
  return s && s.date === todayISO() && s.ids
      && (s.index > 0 || s.touched) && s.index < s.ids.length ? s : null;
}

/** 학습 탭. 하던 세션이 있으면 범위와 상관없이 그걸 잇고, 없으면 오늘 학습을 시작한다.
 *  전에는 늘 오늘 학습을 시작해서, DAY 04를 하다 나와 탭을 누르면 DAY 04의
 *  이어보기 지점이 새 세션에 덮어써졌다. */
function resumeOrStart() {
  const saved = savedSession();
  if (saved) return startStudy(saved.dayFilter, saved.mode);
  startStudy();
}

function startStudy(dayFilter = null, mode = 'due', { resume = true } = {}) {
  // 홈의 '오늘 학습 시작'은 기한이 된 것과 새 단어만,
  // DAY를 직접 고르면 그 DAY 전부를 본다.
  const saved = resume ? savedSession() : null;
  if (saved && saved.dayFilter === dayFilter && saved.mode === mode) {
    // 중간에 나갔던 세션을 이어서 연다
    const queue = saved.ids.map(id => State.byId.get(id)).filter(Boolean);
    if (queue.length) {
      // 빠진 단어가 있으면 그만큼 커서를 당겨야 이미 본 카드가 다시 뜨지 않는다
      const missingBefore = saved.ids.slice(0, saved.index)
        .filter(id => !State.byId.has(id)).length;
      const index = Math.max(0, Math.min(saved.index - missingBefore, queue.length));
      // 이어본 세션에는 되돌릴 기록이 없다. 그 아래로는 못 내려가게 막는다.
      // 다시 낸 카드 수와 재출제 횟수도 되살린다. 없으면 '왜 103장이지?'가
      // 되고, 재출제 한도(모름 3번·애매 1번)도 리셋돼 무한히 다시 나온다.
      State.study = { queue, index, floor: index,
                      graded: saved.graded || 0, dayFilter, mode,
                      relearn: saved.relearn || 0, touched: !!saved.touched,
                      undo: [], retries: { ...(saved.retries || {}) } };
      navigate('study');
      return renderStudy();
    }
  }

  const queue = mode === 'weak' ? Scheduler.weak()
    : mode === 'learned' ? Scheduler.learned()
    : mode === 'all' && dayFilter ? Scheduler.everything(dayFilter)
    : mode === 'day' && dayFilter ? Scheduler.dayQueue(dayFilter)
    : Scheduler.session({ dayFilter });
  State.study = { queue, index: 0, floor: 0, graded: 0, dayFilter, mode, undo: [], retries: {} };
  saveSession();
  navigate('study');
  renderStudy();
}

/** 중간에 나가도 이어서 볼 수 있도록 위치를 남긴다. */
function saveSession() {
  const s = State.study;
  if (!s || s.index >= s.queue.length || s.finished) {
    delete Store.data.session;
  } else {
    // 큐는 고정이 아니다. 모름·애매를 누르면 그 카드가 뒤에 다시 끼워지고,
    // 되돌리면 빠진다. 한 번 만든 id 목록을 재사용했더니 다시 볼 카드가
    // 저장에서 통째로 누락돼, 껐다 켜면 그 단어들이 사라졌다.
    Store.data.session = { date: todayISO(), dayFilter: s.dayFilter, mode: s.mode,
                           index: s.index, graded: s.graded,
                           relearn: s.relearn || 0, retries: s.retries || {},
                           touched: !!s.touched,
                           ids: s.queue.map(w => w.id) };
  }
  Store.save();
}

function renderStudy() {
  const s = State.study;
  const done = $('#study-done');
  const stage = $('#card-stage');
  const list = $('#study-list');
  const bar = $('#grade-bar');
  const listMode = studyMode() === 'list';
  markPick('#study-mode', 'smode', v => v === studyMode());

  // 목록 방식에는 순서가 없다. 큐의 단어를 오늘 다 매겼으면 끝이다.
  const words = listMode && s ? uniqueQueue(s) : null;
  const gradedToday = words ? words.filter(w => seenToday(w.id)).length : 0;
  if (words) s.graded = gradedToday;
  const finished = !s || (listMode ? gradedToday >= words.length : s.index >= s.queue.length);

  if (finished) {
    stage.hidden = true;
    list.hidden = true;
    bar.hidden = true;
    done.hidden = false;
    $('.scope-row').hidden = true;
    if (s) { if (listMode) s.finished = true; saveSession(); }

    const day = s && s.dayFilter;
    const nothing = !s || !s.queue.length;
    $('#study-done-title').textContent =
      nothing ? '볼 단어가 없습니다'
      : s.mode === 'learned' ? '복습 완료'
      : day ? `DAY ${String(day).padStart(2, '0')} 완료` : '오늘 학습 완료';
    // 건너뛴 카드는 기록이 안 남아 다음에 또 나온다. 끝내고 나서
    // '분명 다 했는데 두 장 남았다'가 되지 않게 여기서 밝힌다.
    const skipped = s ? s.queue.filter(w => !Store.record(w.id)).length : 0;
    $('#study-done-sub').textContent = s && s.graded
      ? `${s.graded}번 채점했습니다`
        + (s.relearn ? ` · 세션 안에서 다시 낸 카드 ${s.relearn}장` : '')
        + (skipped ? ` · 건너뛴 카드 ${skipped}장은 기록이 남지 않아 다음에 또 나옵니다` : '')
      : '오늘 볼 단어가 없습니다. 길게 눌러 전체 다시 보기를 고르면 기한과 상관없이 볼 수 있습니다.';

    // 바로 다음 DAY로 넘어갈 수 있게 한다. 홈까지 갔다 오지 않아도 된다.
    const next = day && !nothing ? State.days.find(d => d.day === day + 1) : null;
    const nextBtn = $('#study-next-day');
    nextBtn.hidden = !next;
    if (next) nextBtn.textContent = `DAY ${String(next.day).padStart(2, '0')} 시작`;
    $('#study-again').hidden = !day || nothing;

    $('#study-progress').style.width = '100%';
    $('#study-counter').textContent = s ? `${s.graded}/${s.queue.length}` : '0/0';
    return;
  }
  $('.scope-row').hidden = false;
  done.hidden = true;
  $('#grade-note').hidden = true;
  // 순서 넘기기는 카드에서만 뜻이 있다
  $('#study-prev').hidden = listMode;
  $('#study-next').hidden = listMode;

  if (listMode) {
    stage.hidden = true;
    bar.hidden = true;
    list.hidden = false;
    renderStudyList(s, words, gradedToday);
    return;
  }
  list.hidden = true;
  stage.hidden = false;

  const w = s.queue[s.index];
  const card = $('#flashcard');
  card.classList.remove('flipped');
  bar.hidden = true;

  const dir = directionFor(w.id);
  // 칩에 단원명까지 담는다. 위쪽 범위줄은 '오늘 학습'처럼 여러 DAY가 섞이면
  // 단원명을 못 붙이는데, 카드는 단어 하나짜리라 언제나 붙일 수 있다.
  $('#card-day').innerHTML = `<b>DAY ${String(w.day).padStart(2, '0')}</b>`
    + `<i>${escapeHTML(dayTitle(w.day))}</i>`;
  $('#card-front').textContent = dir === 'en2ko' ? w.headword : meaningText(w);
  $('#card-back').innerHTML = cardBackHTML(w);

  const speak = $('#card-speak');
  speak.hidden = !(dir === 'en2ko' && (w.audio || Speech.supported()));
  speak.dataset.audio = w.audio || '';
  speak.dataset.word = w.headword;
  speak.classList.remove('loading', 'playing', 'failed');   // 앞 카드 상태를 물려받지 않게
  // 카드가 뜨면 그 단어 발음을 미리 받아 둔다. 눌렀을 때 바로 나게.
  Audio_.prime(w.audio);
  if (dir === 'en2ko' && Store.settings.autoplay) Audio_.play(w.audio, speak, w.headword);

  $('#study-counter').textContent = `${s.index + 1}/${s.queue.length}`;
  $('#study-progress').style.transform = `scaleX(${s.index / s.queue.length})`;
  // 단원명은 카드 칩에만 둔다. 여기 또 쓰면 DAY로 들어왔을 때 같은 말이
  // 40px 간격으로 두 번 나오고, 정작 이 줄의 본업인 '몇 장 남음'이 뒤로 밀린다.
  const left = s.queue.length - s.index;
  $('#study-scope').textContent = `${scopeLabel(s)} · ${left}장 남음`
    + (s.relearn ? ` · 다시 낸 카드 ${s.relearn}장` : '');
  $('#study-prev').disabled = s.index <= (s.floor || 0);
  $('#study-next').disabled = s.index >= s.queue.length - 1;
}

function flipCard() {
  const s = State.study;
  if (!s || s.index >= s.queue.length) return;
  $('#flashcard').classList.add('flipped');
  $('#grade-bar').hidden = false;
  const w = s.queue[s.index];
  const early = !Scheduler.isDue(w.id);
  $('#grade-note').hidden = !early;
  // 이미 마지막 박스에 있으면 '이미 앎'은 의미가 없다
  $('[data-grade="known"]').disabled = Store.record(w.id) && clampBox(Store.record(w.id).box) >= MAX_BOX;
  if (Store.settings.autoplay && directionFor(w.id) === 'ko2en') Audio_.play(w.audio, $('#card-back .speak'), w.headword);
}

function gradeCard(result) {
  const s = State.study;
  if (!s || s.index >= s.queue.length) return;
  if (!$('#flashcard').classList.contains('flipped')) return;

  // 되돌릴 수 있도록 채점 전 기록을 남긴다. 없던 단어면 null.
  const word = s.queue[s.index];
  const before = Store.record(word.id);
  s.undo[s.index] = before ? { ...before } : null;

  Scheduler.grade(word.id, result);
  s.graded++;
  s.index++;

  // 모름과 애매는 내일까지 기다리지 않고 이 세션 안에서 다시 낸다.
  // 다만 정해진 횟수까지만이다. 그 뒤로는 내일 몫으로 넘긴다.
  const gap = RELEARN_GAP[result];
  const seen = s.retries[word.id] || 0;
  if (gap && seen < RELEARN_MAX[result]) {
    s.retries[word.id] = seen + 1;
    const at = Math.min(s.index + gap, s.queue.length);
    s.queue.splice(at, 0, word);
    s.relearn = (s.relearn || 0) + 1;
  } else if (gap) {
    toast(`${word.headword} — 오늘은 여기까지, 내일 다시 나옵니다`);
  }

  saveSession();
  renderStudy();
}

/** 이전 카드로. 그 카드에 매겼던 채점은 되돌린다. */
function prevCard() {
  const s = State.study;
  if (!s || s.index <= (s.floor || 0)) return;
  s.index--;
  const id = s.queue[s.index].id;
  if (s.undo[s.index] !== undefined) {
    // 채점 전에 기록이 없었으면 그때 '처음 본 단어'로 셌다는 뜻이다
    Store.unlog(todayISO(), s.undo[s.index] === null);
    if (s.undo[s.index]) Store.data.words[id] = s.undo[s.index];
    else delete Store.data.words[id];
    delete s.undo[s.index];
    s.graded = Math.max(0, s.graded - 1);

    // 채점 때 큐 뒤에 다시 넣었던 카드가 있으면 그것도 걷어낸다.
    // 그러지 않으면 되돌린 뒤에도 중복이 남아 다시 나온다.
    const dup = s.queue.lastIndexOf(s.queue[s.index]);
    if (dup > s.index) {
      s.queue.splice(dup, 1);
      s.relearn = Math.max(0, (s.relearn || 0) - 1);
      if (s.retries[id]) s.retries[id]--;   // 실제로 뺐을 때만 횟수를 돌려준다
    }
  }
  saveSession();
  renderStudy();
}

/** 채점하지 않고 다음 카드로. 건너뛴 단어는 기록이 남지 않는다. */
function skipCard() {
  const s = State.study;
  if (!s || s.index >= s.queue.length) return;
  s.index++;
  saveSession();
  renderStudy();
}

/** 카드를 옆으로 밀어 넘긴다.
 *
 *  왼쪽으로 밀면 채점 없이 다음 장, 오른쪽으로 밀면 이전 장으로 간다.
 *  버튼이 화면 위쪽에 있어 한 손으로는 닿기 어렵다.
 *
 *  탭(뒤집기)과 세로 스크롤을 건드리면 안 되므로, 처음 몇 픽셀에서 방향을
 *  정하고 가로로 판정된 것만 가져간다. 한 번 정한 방향은 끝까지 바꾸지 않는다.
 */
// 손을 떼면 브라우저가 click을 한 번 더 쏜다. 그대로 두면 밀어 넘긴 직후
// 카드가 뒤집힌다. 방금 민 적이 있으면 그 click 한 번을 삼킨다.
let swipedAt = 0;
const justSwiped = () => Date.now() - swipedAt < 500;

const SWIPE_MIN = 56;      // 이만큼은 밀어야 넘긴다 (스크롤하다 실수로 넘어가지 않게)
const SWIPE_LOCK = 10;     // 이 거리 안에서 가로/세로를 정한다

function bindSwipe(el) {
  let x0 = 0, y0 = 0, dx = 0, axis = null, active = false;

  const reset = () => {
    el.style.transition = '';
    el.style.transform = '';
    el.style.opacity = '';
  };

  el.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) { active = false; return; }
    const t = e.touches[0];
    x0 = t.clientX; y0 = t.clientY; dx = 0; axis = null; active = true;
    el.style.transition = 'none';
  }, { passive: true });

  el.addEventListener('touchmove', e => {
    if (!active || e.touches.length !== 1) return;
    const t = e.touches[0];
    dx = t.clientX - x0;
    const dy = t.clientY - y0;

    if (!axis) {
      if (Math.abs(dx) < SWIPE_LOCK && Math.abs(dy) < SWIPE_LOCK) return;
      axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }
    if (axis !== 'x') return;

    e.preventDefault();                     // 가로로 정해진 뒤에만 스크롤을 막는다
    swipedAt = Date.now();
    // 갈 수 없는 쪽은 뻑뻑하게 끌린다. 끝이라는 걸 손으로 알 수 있게.
    const s = State.study;
    const blocked = (dx > 0 && s && s.index <= (s.floor || 0)) ||
                    (dx < 0 && s && s.index >= s.queue.length - 1);
    const shift = blocked ? dx * 0.25 : dx;
    el.style.transform = `translateX(${shift}px)`;
    el.style.opacity = String(Math.max(.45, 1 - Math.abs(shift) / 420));
  }, { passive: false });

  const finish = () => {
    if (!active) return;
    active = false;
    if (axis === 'x') swipedAt = Date.now();
    el.style.transition = 'transform .18s ease, opacity .18s ease';
    if (axis === 'x' && Math.abs(dx) >= SWIPE_MIN) {
      const back = dx > 0;
      const s = State.study;
      const can = back ? s && s.index > (s.floor || 0)
                       : s && s.index < s.queue.length - 1;
      if (can) {
        // 넘어가는 쪽으로 마저 밀어낸 뒤 새 카드를 그린다
        el.style.transform = `translateX(${back ? 1 : -1}00%)`;
        el.style.opacity = '0';
        setTimeout(() => { reset(); back ? prevCard() : skipCard(); }, 120);
        return;
      }
    }
    reset();
  };

  el.addEventListener('touchend', finish, { passive: true });
  el.addEventListener('touchcancel', finish, { passive: true });
}

/* ── 목록 ─────────────────────────────────────────── */

function renderListBox() {
  markPick('#list-box', 'box', v => State.list.boxes.includes(Number(v)));
}

function renderDayChips() {
  const cur = State.list.day;
  $('#day-chips').innerHTML =
    `<button data-chip="all"${cur === null ? ' class="on"' : ''}>전체</button>` +
    State.days.map(d =>
      `<button data-chip="${d.day}"${cur === d.day ? ' class="on"' : ''}>DAY ${String(d.day).padStart(2, '0')}</button>`
    ).join('');
}

function filteredWords() {
  const { day, query, boxes, stage } = State.list;
  const tiers = Store.settings.tiers;
  const q = query.trim().toLowerCase();
  let pool = day === null ? State.words : (State.byDay.get(day) || []);
  // 등급은 설정에서 정한 범위를 그대로 따른다. 여기서 또 고르게 두면
  // '설정에서 껐는데 목록에서 켜면?'이 생긴다. 목록은 범위 안을 보여 주는 곳이다.
  if (tiers.length < 3) pool = pool.filter(w => tiers.includes(w.tier));
  if (State.list.weakOnly) pool = pool.filter(w => (Store.record(w.id) || {}).wrong > 0);
  if (boxes.length) {
    pool = pool.filter(w => { const r = Store.record(w.id); return r && boxes.includes(clampBox(r.box)); });
  }
  if (stage !== null) {
    pool = pool.filter(w => stage === 'new' ? !Store.record(w.id) : !!Store.record(w.id));
  }
  if (!q) return pool;

  // 찾은 것을 가까운 순서로 내놓는다. 검색어는 표제어·뜻·예문을 통째로
  // 뒤지기 때문에, 그냥 두면 'transfer'를 쳤을 때 예문에 그 말이 든
  // 다른 단어가 먼저 나오고 정작 transfer가 세 번째에 온다.
  return pool.filter(w => w.q.includes(q))
    .map((w, i) => [searchRank(w, q), i, w])          // i로 같은 순위 안의 차례를 지킨다
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map(x => x[2]);
}

/** 검색어와 얼마나 가까운가. 작을수록 위로 온다. */
function searchRank(w, q) {
  const hw = w.headword.toLowerCase();
  if (hw === q) return 0;                              // 딱 그 단어
  if (hw.startsWith(q)) return 1;                      // transfer -> transferable
  if (hw.includes(q)) return 2;                        // 표제어 안에 들어 있음
  if ((w.meaning || '').toLowerCase().includes(q)) return 3;   // 뜻에 있음
  return 4;                                            // 예문에만 있음
}

function renderList() {
  const words = filteredWords();
  const shown = words.slice(0, State.list.shown);

  renderListCount(words);

  const toStudy = $('#list-to-study');
  toStudy.hidden = State.list.day === null;
  if (State.list.day !== null) {
    toStudy.textContent = `DAY ${String(State.list.day).padStart(2, '0')} 외우기`;
  }

  const wrap = $('#word-list');
  wrap.classList.toggle('masked', State.list.masked);
  wrap.innerHTML = shown.map(rowHTML).join('') || '<p class="muted">검색 결과가 없습니다.</p>';
  appendMore(wrap, words);
}

/** 목록 한 줄. 들여쓰기를 넣지 않는다 — 줄마다 공백 텍스트 노드가 열 몇 개씩
 *  생기는데, 4,190줄이면 그것만으로 수만 개다. */
function rowHTML(w) {
  const rec = Store.record(w.id);
  const pos = posText(w);
  // 예문이 둘이면 둘 다 보여준다. 뜻이 여러 개인 단어는 예문마다 뜻이 달라서
  // 첫 줄만 보이면 나머지 뜻은 예문 없이 외우게 된다 (pass = 지나가다 / 건네다).
  // 4,187개 중 108개뿐이라 목록이 길어지지도 않는다.
  const shown = w.examples.slice(0, 2);
  return `<div class="word-item" data-id="${escapeHTML(w.id)}"><div class="row">`
    + `<span class="hw">${escapeHTML(w.headword)}</span>`
    + (pos ? `<span class="pos">${escapeHTML(pos)}</span>` : '')
    + `<span class="tags">`
    + `<span class="tier">${TIER_LABEL[w.tier] || '기타'}</span>`
    // ✕는 오답 기호다. 여기 숫자는 모름을 몇 번 눌렀나이지 오답 횟수가 아니다.
    + `<span class="miss">${rec && rec.wrong ? '모름 ' + rec.wrong : ''}</span>`
    + `<span class="box">${rec ? '박스 ' + rec.box : ''}</span>`
    + `<span class="spk">${Audio_.speakerHTML(w.audio, 'speak', w.headword)}</span>`
    + `</span></div>`
    + `<div class="mean">${escapeHTML(meaningText(w))}</div>`
    + shown.map(ex =>
        `<div class="ex">${escapeHTML(ex.en)}${ex.generated ? '<span class="gen">생성</span>' : ''}`
        + (ex.ko ? `<div class="ko">${escapeHTML(ex.ko)}</div>` : '') + `</div>`).join('')
    + `</div>`;
}

/* ── 학습: 목록 방식 ───────────────────────────────── */

/** 목록 방식에서 매긴 채점. id -> { before, after, picked, date }
 *
 *  목록은 촘촘해서 옆 버튼을 잘못 누르기 쉽다. 그대로 두면 박스가 두 번
 *  움직이므로, 다시 누르면 앞의 채점을 되돌리고 새로 매길 수 있게 들고 있는다.
 *  before는 매기기 전 기록(없었으면 null), after는 매긴 직후 기록이다.
 */
const listGrades = new Map();

const studyMode = () => Store.settings.studyMode === 'list' ? 'list' : 'card';
const seenToday = (id, today = todayISO()) => {
  const r = Store.record(id);
  return !!r && r.lastSeen === today;
};
/** 카드 방식은 모름·애매를 뒤에 다시 끼운다. 목록에는 한 번만 보인다. */
function uniqueQueue(s) {
  const seen = new Set();
  return s.queue.filter(w => !seen.has(w.id) && seen.add(w.id));
}

/** 학습 범위 한 줄. 카드와 목록이 같은 말을 쓴다. */
function scopeLabel(s) {
  return s.mode === 'weak' ? '자주 안 떠오른 단어'
    : s.mode === 'learned' ? '본 단어 복습'
    : s.dayFilter ? `DAY ${String(s.dayFilter).padStart(2, '0')}` + (s.mode === 'all' ? ' 전체' : '')
    : '오늘 학습';
}

/** 줄 안의 채점 버튼. 카드 화면과 같은 네 등급을 쓴다. */
function gradeBarHTML(w) {
  const g = listGrades.get(w.id);
  // '이미 앎'을 켤지는 이 화면에서 매기기 전 상태로 정한다. 방금 누른 '안다'
  // 때문에 마지막 박스가 되어 마음을 바꿀 길이 막히면 안 된다.
  const base = g ? g.before : Store.record(w.id);
  const maxed = base && clampBox(base.box) >= MAX_BOX;
  const btn = (v, label) =>
    `<button type="button" class="${v}${g && g.picked === v ? ' on' : ''}"`
    + (v === 'known' && maxed && !(g && g.picked === 'known') ? ' disabled' : '')
    + ` data-lgrade="${v}">${label}</button>`;
  return `<div class="lgrade">`
    + btn('again', '모름') + btn('hard', '애매')
    + btn('good', '안다') + btn('known', '이미 앎')
    + `</div>`;
}

/** 목록 방식의 한 줄. 누르기 전에는 단어만, 누르면 뜻·예문·채점이 펼쳐진다.
 *  찾아보기 목록의 word-item 모양을 그대로 빌린다. 같은 카드 모양이어야 한다. */
function studyRowHTML(w, today = todayISO()) {
  const rec = Store.record(w.id);
  const done = seenToday(w.id, today);
  const ex = w.examples[0];
  return `<div class="word-item srow${done ? ' done open' : ''}" data-id="${escapeHTML(w.id)}">`
    + `<div class="row">`
    + `<span class="hw">${escapeHTML(w.headword)}</span>`
    + (w.pos ? `<span class="pos">${escapeHTML(w.pos)}</span>` : '')
    + `<span class="tags">`
    + `<span class="box">${rec ? '박스 ' + clampBox(rec.box) : ''}</span>`
    + `<span class="spk">${Audio_.speakerHTML(w.audio, 'speak', w.headword)}</span>`
    + `</span></div>`
    + `<div class="srow-body">`
    + `<div class="mean">${escapeHTML(w.meaning)}</div>`
    + (ex ? `<div class="ex">${escapeHTML(ex.en)}${ex.generated ? '<span class="gen">생성</span>' : ''}`
          + (ex.ko ? `<div class="ko">${escapeHTML(ex.ko)}</div>` : '') + `</div>` : '')
    + gradeBarHTML(w)
    + `</div></div>`;
}

function renderStudyList(s, words, graded) {
  $('#study-counter').textContent = `${graded}/${words.length}`;
  $('#study-progress').style.transform = `scaleX(${words.length ? graded / words.length : 0})`;
  $('#study-scope').textContent = `${scopeLabel(s)} · ${words.length - graded}개 남음`;
  const today = todayISO();
  $('#study-list').innerHTML = words.map(w => studyRowHTML(w, today)).join('');
}

/** 두 기록이 같은가. 되돌려도 되는지 판단할 때만 쓴다. */
const sameRecord = (a, b) => (!a === !b) &&
  (!a || (a.box === b.box && a.due === b.due && a.correct === b.correct
          && a.wrong === b.wrong && a.lastSeen === b.lastSeen));

/** 목록 방식에서 채점한다.
 *
 *  카드는 한 장씩 넘겨야 해서 훑는 속도가 안 난다. 단어만 보고 떠올린 뒤
 *  줄을 눌러 확인하고 그 자리에서 매기는 편이 빠른 사람이 있다. 박스 계산은
 *  카드와 똑같은 Scheduler.grade를 쓴다. 경로만 다르지 다른 규칙이 아니다.
 */
function gradeInList(id, result) {
  const s = State.study;
  const w = State.byId.get(id);
  if (!s || !w) return;
  const prev = listGrades.get(id);
  if (prev && prev.picked === result) return;         // 같은 걸 또 눌렀다

  const cur = Store.record(id);
  // 되돌려도 되는 것은 '내가 매긴 뒤로 아무도 손대지 않은' 기록뿐이다.
  // 목록에서 매긴 단어를 카드나 퀴즈에서 또 채점했다면, 여기서 되돌리는 순간
  // 그 사이의 진도가 통째로 사라진다. 그럴 때는 지금 값을 그대로 두고 새로 매긴다.
  const mine = prev && sameRecord(cur, prev.after);
  if (mine) {
    Store.unlog(prev.date, prev.before === null);     // 자정을 넘겼을 수 있다. 그때 그 날짜에서 뺀다.
    if (prev.before) Store.data.words[id] = { ...prev.before };
    else delete Store.data.words[id];
  }
  const before = mine ? prev.before : (cur ? { ...cur } : null);
  const date = todayISO();
  Scheduler.grade(id, result);
  listGrades.set(id, { before, after: { ...Store.record(id) }, picked: result, date });

  const words = uniqueQueue(s);
  const graded = words.filter(x => seenToday(x.id, date)).length;
  s.graded = graded;
  s.touched = true;
  if (graded >= words.length) s.finished = true;      // 다 했다. 이어보기 저장도 지운다.
  saveSession();
  if (s.finished) return renderStudy();

  // 목록을 통째로 다시 그리면 스크롤이 튀고 줄이 전부 새로 만들어진다.
  // 방금 매긴 줄만 갈아끼운다. 매긴 줄은 펼친 채로 남는다.
  const row = $(`#study-list .srow[data-id="${id.replace(/"/g, '\\"')}"]`);
  if (row) row.outerHTML = studyRowHTML(w, date);
  $('#study-counter').textContent = `${graded}/${words.length}`;
  $('#study-progress').style.transform = `scaleX(${graded / words.length})`;
  $('#study-scope').textContent = `${scopeLabel(s)} · ${words.length - graded}개 남음`;
}

/** '더 보기'는 새로 나올 몫만 뒤에 붙인다.
 *  예전에는 목록 전체를 다시 그려서, 800개쯤 펼친 뒤에는 한 번 누를 때마다
 *  4,800개 노드를 부수고 다시 만들었다. 스크롤 위치도 함께 날아갔다. */
function appendMore(wrap, words) {
  if (words.length <= State.list.shown) return;
  const more = document.createElement('button');
  more.className = 'btn btn-outline btn-block';
  more.textContent = '더 보기';
  more.onclick = () => {
    const from = State.list.shown;
    State.list.shown += LIST_PAGE;
    const rest = filteredWords();
    more.remove();
    wrap.insertAdjacentHTML('beforeend',
      rest.slice(from, State.list.shown).map(rowHTML).join(''));
    appendMore(wrap, rest);
    renderListCount(rest);
  };
  wrap.appendChild(more);
}

/** 홈에서 어떤 단계를 눌렀을 때 그 단어들을 목록으로 연다. */
/** 홈의 칸을 눌러 목록을 연다. 박스는 목록의 박스 고르기에 걸리고,
 *  안 본/본 단어는 위쪽 태그로 보여 준다. */
function openStage(stage) {
  const isBox = typeof stage === 'number';
  State.list.boxes = isBox ? [stage] : [];
  State.list.stage = isBox ? null : stage;
  State.list.day = null;
  State.list.query = '';
  State.list.weakOnly = false;
  State.list.shown = LIST_PAGE;
  const box = $('#search');
  if (box) box.value = '';
  navigate('list');
}

// 채점할 때마다 4,187개를 다시 세지 않도록 마지막 값을 들고 있는다.
let listCount = { total: 0, withEx: 0 };

function renderListCount(words) {
  if (words) listCount = { total: words.length,
                           withEx: words.reduce((n, w) => n + (w.examples.length ? 1 : 0), 0) };
  const { total, withEx } = listCount;
  // DAY를 골랐으면 단원명을 앞에 붙인다. 홈 칸에는 넣을 자리가 없어
  // 어느 단원인지 알 수 있는 자리가 여기와 학습 화면뿐이다.
  const head = State.list.day !== null ? `${dayTitle(State.list.day)} · ` : '';
  $('#list-count').textContent = head +
    `${total.toLocaleString()}단어 · 예문 ${withEx.toLocaleString()}` +
    (total > State.list.shown ? ` · ${State.list.shown}개 표시 중` : '');

  // 홈에서 넘어온 필터는 눈에 보여야 한다. 안 그러면 왜 목록이 짧은지 모른다.
  const tag = $('#list-stage');
  tag.hidden = State.list.stage === null;
  if (State.list.stage !== null) tag.firstChild.textContent = stageLabel(State.list.stage);
}

/* ── 퀴즈 ─────────────────────────────────────────── */

function quizPool() {
  const scope = $('#quiz-scope button.on').dataset.scope;
  if (scope === 'due') return Scheduler.session();
  if (scope === 'learned') return Scheduler.learned();
  if (scope === 'day') return inScope(State.byDay.get(State.quizDay) || []);
  return inScope(State.words);
}

function renderQuizSetup() {
  const qtype = Store.settings.quizType || 'meaning';
  markPick('#quiz-type', 'qtype', v => v === qtype);
  $('#quiz-type-hint').textContent =
    qtype === 'cloze' ? '예문에서 단어를 지우고 고르게 합니다. 토익 Part 5와 같은 모양입니다.'
    : qtype === 'both' ? '단어마다 둘 중 하나로 냅니다.'
    : '단어를 주고 뜻을 고르게 합니다. 방향은 설정의 출제 방향을 따릅니다.';

  const scope = $('#quiz-scope button.on').dataset.scope;
  const chips = $('#quiz-day-chips');
  chips.hidden = scope !== 'day';
  if (!chips.hidden) {
    // 목록 화면과 같은 칩을 쓴다. 네이티브 select는 플랫폼마다 모양이 달라진다.
    chips.innerHTML = State.days.map(d =>
      `<button data-quizday="${d.day}"${d.day === State.quizDay ? ' class="on"' : ''}>` +
      `DAY ${String(d.day).padStart(2, '0')}</button>`).join('');
    const on = chips.querySelector('button.on');
    if (on) on.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  const n = quizPool().length;
  const where = scope === 'day' ? `DAY ${String(State.quizDay).padStart(2, '0')}의 `
    : scope === 'learned' ? '배운 ' : '';
  const count = $('#quiz-count');
  count.max = String(Math.max(4, n));
  $('#quiz-count-max').textContent = n >= 4 ? `4 ~ ${n.toLocaleString()}` : '';
  const asked = n >= 4 ? quizLength(n) : 0;
  $('#quiz-avail').textContent = n < 4
    ? `출제할 단어가 ${n}개뿐입니다. 사지선다라 4개 이상 필요합니다.`
    : `${where}${n.toLocaleString()}단어에서 ${asked.toLocaleString()}문항을 냅니다.`;
  $('#quiz-start').disabled = n < 4;
}

/** 예문에서 표제어를 찾아 빈칸으로 바꾼다.
 *
 *  토익 Part 5가 정확히 이 모양이다. 뜻만 맞히면 'hold = 들다'는 알아도
 *  "A man is ___ a piece of wood"에서는 못 고른다.
 *
 *  표제어가 문장에 그대로 있지는 않다. hold -> holding처럼 변형돼 있어서
 *  낱말마다 어간까지만 보고 찾는다. 구는 통째로 가려야 답이 말이 된다 -
 *  'in advance'에서 advance만 지우면 "How far in ___"가 되어 이상하다.
 *
 *  못 찾으면 null. 그런 단어는 뜻 맞히기로 낸다.
 */
function clozeFrom(word) {
  // 표제어가 그대로 나오는 예문을 먼저 찾는다. 그런 문장은 선택지를 그대로
  // 끼워 넣어도 말이 된다. 변형된 것밖에 없으면(engage -> engaged) 그것도
  // 쓰되, 답을 맞힌 뒤에 실제 형태를 보여 준다.
  for (const strict of [true, false]) {
    for (const form of clozeForms(word.headword)) {
      const re = phraseRegex(form, strict);
      if (!re) continue;
      for (const e of word.examples) {
        if (e.en.split(/\s+/).length < 4) continue;   // 조각난 문장은 문제가 안 된다
        const m = e.en.match(re);
        if (!m) continue;
        return {
          sentence: e.en.replace(re, '______'),
          ko: e.ko || '',
          hit: m[0],
          full: e.en,
          // 원형이 그대로 있었으면 답을 끼워 넣어도 문장이 맞는다
          exact: strict,
        };
      }
    }
  }
  return null;
}

/** 표제어에서 찾아볼 형태들. 대괄호는 앞말을 갈아 끼우는 표기다.
 *  environmentally[eco] friendly -> environmentally friendly / eco friendly */
function clozeForms(headword) {
  const out = [];
  const bracket = headword.match(/^(.*?)(\S+)\[([^\]]+)\](.*)$/);
  if (bracket) {
    const [, head, word, alt, tail] = bracket;
    out.push((head + word + tail).trim(), (head + alt + tail).trim());
  } else {
    out.push(headword);
  }
  // fail to부정사처럼 한글이 섞인 것은 영어 부분만 쓴다
  return out.map(f => (f.match(/[A-Za-z][A-Za-z'()\- ]*/) || [''])[0].trim()).filter(Boolean);
}

/** 구를 통째로 잡는 정규식.
 *  strict면 표제어 그대로만, 아니면 낱말마다 어간까지만 보고 변형을 허용한다. */
function phraseRegex(form, strict) {
  const words = form.replace(/[()]/g, '').split(/[\s-]+/).filter(Boolean);
  if (!words.length) return null;
  // 내용어(3자 이상)가 하나도 없으면 포기한다. of, to 같은 것만으로는 못 찾는다.
  if (!words.some(w => w.length >= 3)) return null;
  const parts = words.map(w => {
    const esc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (strict) return esc(w);
    // 짧은 기능어는 그대로, 긴 낱말은 앞부분만 보고 변형을 허용한다
    return w.length < 3 ? esc(w) : esc(w.slice(0, Math.max(3, w.length - 3))) + "[A-Za-z']*";
  });
  try {
    return new RegExp('\\b' + parts.join("[\\s-]+") + "(?![A-Za-z'])", 'i');
  } catch (e) {
    return null;
  }
}

function buildQuestion(word, pool, dayCache) {
  // 빈칸 모드에서는 문장을 주고 단어를 고르게 한다. 방향 설정과 무관하다.
  const wantCloze = Store.settings.quizType === 'cloze'
    || (Store.settings.quizType === 'both' && (hashOf(word.id) & 1));
  const cloze = wantCloze ? clozeFrom(word) : null;
  const dir = cloze ? 'ko2en' : directionFor(word.id);
  const answer = dir === 'en2ko' ? meaningText(word) : word.headword;

  // 오답 선택지도 지금 범위 안에서만 뽑는다.
  // 같은 DAY는 문항마다 다시 거를 필요가 없어 한 번 걸러 두고 쓴다.
  let scoped = dayCache && dayCache.get(word.day);
  if (!scoped) {
    scoped = inScope(State.byDay.get(word.day) || []);
    if (dayCache) dayCache.set(word.day, scoped);
  }
  const sameDay = scoped.filter(w => w.id !== word.id);
  const others = shuffle(sameDay.length >= 3 ? sameDay : pool.filter(w => w.id !== word.id));

  const seen = new Set([answer]);
  const meaningSeen = new Set([meaningText(word)]);
  const distractors = [];
  for (const w of others) {
    const t = dir === 'en2ko' ? meaningText(w) : w.headword;
    // 한->영에서는 뜻이 같은 단어가 섞이면 정답이 둘이 된다
    if (dir === 'ko2en') {
      const m = meaningText(w);
      if (meaningSeen.has(m)) continue;
      meaningSeen.add(m);
    }
    if (seen.has(t)) continue;
    seen.add(t);
    distractors.push(t);
    if (distractors.length === 3) break;
  }

  return {
    id: word.id,
    prompt: cloze ? cloze.sentence : (dir === 'en2ko' ? word.headword : meaningText(word)),
    sub: cloze ? cloze.ko : '',
    cloze: !!cloze,
    full: cloze ? cloze.full : '',
    hit: cloze ? cloze.hit : '',
    exact: cloze ? cloze.exact : true,
    answer,
    options: shuffle([answer, ...distractors]),
  };
}

/** 문항 수. 직접 입력한 값이 있으면 그것을, 없으면 고른 버튼을 쓴다. */
function quizLength(poolSize) {
  const typed = Math.floor(Number($('#quiz-count').value));
  if (Number.isFinite(typed) && typed >= 4) return Math.min(typed, poolSize);
  const preset = Number(($('#quiz-length button.on') || {}).dataset?.len ?? 10);
  return preset > 0 ? Math.min(preset, poolSize) : poolSize;
}

function startQuiz() {
  const pool = quizPool();
  const picked = shuffle(pool).slice(0, quizLength(pool.length));

  // 문항은 화면에 낼 때 만든다. 전체(4,190문항)를 고르면 시작 버튼을 누른 뒤
  // 몇 초간 화면이 굳었다 — 아무도 안 볼 문항까지 미리 다 만들었기 때문이다.
  State.quiz = {
    picked, pool, dayCache: new Map(), questions: [],
    total: picked.length, index: 0, correct: 0, wrong: [],
  };
  $('#quiz-setup').hidden = true;
  $('#quiz-result').hidden = true;
  $('#quiz-run').hidden = false;
  renderQuiz();
}

function renderQuiz() {
  const q = State.quiz;
  const cur = q.questions[q.index] ||
    (q.questions[q.index] = buildQuestion(q.picked[q.index], q.pool, q.dayCache));

  $('#quiz-counter').textContent = `${q.index + 1}/${q.total}`;
  $('#quiz-progress').style.transform = `scaleX(${q.index / q.total})`;
  const qEl = $('#quiz-question');
  qEl.textContent = cur.prompt;
  qEl.classList.toggle('cloze', !!cur.cloze);
  // 해석은 답을 고른 뒤에 정답 칸 안에서 편다. 먼저 보여 주면 답을
  // 알려 주는 셈이고, 실제 시험지에도 해석은 없다.
  $('#quiz-next').hidden = true;

  const box = $('#quiz-options');
  box.classList.remove('locked');
  box.innerHTML = cur.options.map(o =>
    `<button data-opt="${escapeHTML(o)}">${escapeHTML(o)}</button>`).join('');
}

function answerQuiz(choice) {
  const q = State.quiz;
  if (!q || q.index >= q.total) return;
  const box = $('#quiz-options');
  // locked는 pointer-events만 막는다. 답을 고른 뒤에도 그 버튼에 포커스가
  // 남아 있어 Enter나 Space로 다시 눌리면 같은 문항이 거듭 채점됐다.
  // 점수·틀린 목록·오늘 개수·박스까지 전부 부풀려진다.
  if (box.classList.contains('locked')) return;
  box.classList.add('locked');
  for (const b of $$('button', box)) b.disabled = true;

  const cur = q.questions[q.index];

  const ok = choice === cur.answer;
  if (ok) q.correct++;
  else q.wrong.push(cur.id);
  // 사지선다는 찍어도 맞을 수 있어 기본으로는 박스를 건드리지 않는다.
  if (Store.settings.quizAffectsBox) Scheduler.grade(cur.id, ok ? 'good' : 'again');

  for (const btn of $$('button', box)) {
    if (btn.dataset.opt === cur.answer) btn.classList.add('correct');
    else if (btn.dataset.opt === choice) btn.classList.add('wrong');
  }
  // 빈칸을 실제 형태로 되돌려 준다. 선택지는 원형이라(engage), 문장에
  // 들어간 형태가 다르면(engaged) 그대로 끼워 넣었을 때 말이 안 된다.
  // 답을 고른 뒤 원문을 보여 주면 어떤 꼴로 쓰는지까지 같이 익힌다.
  if (cur.cloze && cur.full) {
    const qEl = $('#quiz-question');
    qEl.textContent = '';
    const i = cur.full.indexOf(cur.hit);
    qEl.append(cur.full.slice(0, i));
    const mark = document.createElement('mark');
    mark.textContent = cur.hit;
    qEl.append(mark, cur.full.slice(i + cur.hit.length));
  }

  // 해석은 정답 칸 안에서 편다. 따로 상자를 두면 화면이 한 번 더 밀리고,
  // 정답과 해석이 떨어져 있어 무엇의 해석인지 한 번 더 생각해야 한다.
  if (cur.sub) {
    const right = $$('button', box).find(b => b.dataset.opt === cur.answer);
    if (right) {
      const ko = document.createElement('span');
      ko.className = 'opt-ko';
      ko.textContent = cur.sub;
      right.appendChild(ko);
      requestAnimationFrame(() => ko.classList.add('open'));
    }
  }

  $('#quiz-next').hidden = false;
  $('#quiz-next').textContent = q.index + 1 >= q.total ? '결과 보기' : '다음';
}

function nextQuiz() {
  const q = State.quiz;
  q.index++;
  if (q.index >= q.total) return finishQuiz();
  renderQuiz();
}

function finishQuiz() {
  const q = State.quiz;
  const pct = Math.round(q.correct / q.total * 100);
  $('#quiz-run').hidden = true;
  $('#quiz-result').hidden = false;
  $('#quiz-score').textContent = pct;
  $('#quiz-score-sub').textContent = `${q.total}문항 중 ${q.correct}개 정답` +
    (Store.settings.quizAffectsBox ? ' · 박스에 반영됨' : ' · 박스는 그대로');

  const wrap = $('#quiz-wrong-wrap');
  wrap.hidden = q.wrong.length === 0;
  $('#quiz-wrong').innerHTML = q.wrong.map(id => {
    const w = State.byId.get(id);
    return `<div class="word-item">
      <div class="row"><span class="hw">${escapeHTML(w.headword)}</span></div>
      <div class="mean">${escapeHTML(meaningText(w))}</div>
    </div>`;
  }).join('');
}

/* ── 설정 ─────────────────────────────────────────── */

/** 등급별 단어 수는 변하지 않는다. 설정을 열 때마다 4,190개를 다시 셀 이유가 없다. */
let _tierCounts = null;
function tierCounts() {
  if (!_tierCounts) {
    _tierCounts = { core: 0, bonus: 0, extra: 0 };
    for (const w of State.words) if (_tierCounts[w.tier] !== undefined) _tierCounts[w.tier]++;
  }
  return _tierCounts;
}

function renderSettings() {
  const { direction, newPerDay, onlyWithExample } = Store.settings;
  markPick('#set-direction', 'dir', v => v === direction);
  // 프리셋에 없는 값은 직접 입력 칸에 담는다
  const presets = $$('#set-limit button').map(b => Number(b.dataset.limit));
  const custom = !presets.includes(newPerDay);
  markPick('#set-limit', 'limit', v => !custom && Number(v) === newPerDay);
  const nc = $('#new-count');
  if (document.activeElement !== nc) nc.value = custom ? String(newPerDay) : '';
  markPick('#set-scope', 'scope', v => (v === 'example') === onlyWithExample);

  markPick('#set-quizgrade', 'quizgrade', v => (v === 'on') === !!Store.settings.quizAffectsBox);
  markPick('#set-theme', 'theme-opt', v => v === (Store.settings.theme || 'system'));
  markPick('#set-tier', 'tier', v => Store.settings.tiers.includes(v));
  const counts = tierCounts();
  $('#tier-hint').textContent =
    `필수 ${counts.core.toLocaleString()} → 만점 ${counts.bonus.toLocaleString()} → ` +
    `추가 ${counts.extra.toLocaleString()} 순서로 끝내면 됩니다. ` +
    '필수와 만점은 ETS 공식 교재(DAY 1~30), 추가는 독종반 모바일 단어장(DAY 31~40)에서 ' +
    '왔습니다. 추가 등급에는 발음이 없습니다.';
  markPick('#set-autoplay', 'autoplay', v => (v === 'on') === Store.settings.autoplay);
  const vm = Store.settings.voiceMode || 'file';
  markPick('#set-voice', 'voice', v => v === vm);
  const withAudio = State.meta.withAudio || 0;
  const noAudio = (State.meta.wordCount || 0) - withAudio;
  $('#audio-hint').textContent = vm === 'tts'
    ? '녹음을 쓰지 않고 기기에 내장된 음성으로 읽습니다. 내려받을 것이 없고 모든 단어에서 납니다. '
      + '녹음보다 기계음에 가깝습니다.'
    : `${withAudio.toLocaleString()}단어는 녹음(mp3)으로, `
      + `녹음이 없는 ${noAudio.toLocaleString()}단어는 기기 내장 음성으로 읽습니다. `
      + '들은 녹음은 자동으로 저장되고, 내려받아 두면 오프라인에서도 들립니다.';

  // homeStats가 이미 한 바퀴로 세어 준다. split()을 또 돌려 정렬까지 할 일이 아니다.
  const { freshTotal } = homeStats();

  $('#exam-clear').hidden = !Store.settings.examDate;

  // 우리 칸에 날짜를 한국식으로 적는다. 네이티브 입력은 그 위에 투명하게 덮여 있다.
  const iso = Store.settings.examDate;
  const field = $('.date-field');
  const left = daysToExam();
  field.classList.toggle('empty', !iso);
  $('#exam-date-text').textContent = iso
    ? new Date(iso + 'T00:00:00').toLocaleDateString('ko-KR',
        { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' })
    : '날짜 선택';
  $('#exam-dday').textContent = left === null ? ''
    : left > 0 ? `D-${left}` : left === 0 ? 'D-DAY' : `D+${-left}`;
  const passes = clampPasses(Store.settings.targetPasses);
  markPick('#set-passes', 'passes', v => Number(v) === passes);
  const plan = examPlan(freshTotal);
  // 계획이 낸 숫자를 하루 몫에 바로 넣는다. 예전에는 홈에서 '하루 127개'를
  // 읽고 여기에 직접 127을 쳐 넣어야 했다.
  const applyBtn = $('#apply-plan');
  const rec = plan && plan.perDay;
  applyBtn.hidden = !rec || rec === newPerDay;
  if (!applyBtn.hidden) applyBtn.textContent = `하루 몫을 ${rec.toLocaleString()}개로 맞추기`;

  $('#exam-hint').textContent = !plan
    ? '시험 날짜를 넣으면 남은 단어를 며칠에 나눠 볼지 역산해 알려 줍니다. 안 넣어도 됩니다.'
    : plan.perDay
      ? `${plan.passes}회독은 마지막 새 단어를 시험 ${plan.lead}일 전까지 시작해야 채워집니다. `
        + `박스가 1→${Math.min(MAX_BOX, plan.passes + 1)}까지 오르는 데 그만큼 걸립니다.`
      : `남은 ${plan.left}일로는 ${plan.passes}회독이 어렵습니다. 회독을 줄이거나 범위를 좁히세요.`;
  $('#new-count-max').textContent = freshTotal ? `1 ~ ${freshTotal.toLocaleString()}` : '';
  if (newPerDay < 0) {
    $('#limit-hint').textContent =
      `남은 새 단어 ${freshTotal.toLocaleString()}개를 한 번에 전부 꺼냅니다. ` +
      '며칠 뒤 복습이 그만큼 몰리니 시험이 코앞일 때만 쓰세요.';
  } else if (newPerDay === 0) {
    $('#limit-hint').textContent = '새 단어를 꺼내지 않고 이미 배운 것만 복습합니다.';
  } else {
    const days = Math.max(1, Math.ceil(freshTotal / newPerDay));
    // 한 단어가 5번 상자까지 가는 데 평균 다섯 번쯤 나온다고 보고 어림한다
    const peak = Math.round(newPerDay * 3.7);
    $('#limit-hint').textContent =
      `복습은 밀린 만큼 전부 나오고 새 단어만 하루 ${newPerDay}개로 끊습니다. ` +
      `이 속도면 남은 ${freshTotal.toLocaleString()}개를 ${days}일에 끝내고, ` +
      `2주 뒤 하루 복습량은 ${peak}장 안팎이 됩니다.`;
  }

  const scoped = inScope(State.words);
  const withEx = scoped.filter(w => w.examples.length).length;
  $('#scope-hint').textContent =
    `지금 설정으로 ${scoped.length.toLocaleString()}단어가 출제됩니다` +
    (onlyWithExample ? '.' : ` (그중 예문 있는 것 ${withEx.toLocaleString()}개).`);

  // 저장할 때 재둔 값을 쓴다. 예전에는 설정을 열 때마다 400KB를 동기로 읽어
  // Blob까지 만들었다 — 글자 하나 칠 때마다.
  const bytes = Store.bytes;
  $('#info').innerHTML = `
    <div><dt>DAY 1~30</dt><dd>ETS 토익 기출 보카<br><span class="dim">공식 교재 · 예문은 <a href="${escapeHTML(State.meta.sourceUrl)}" target="_blank" rel="noopener">네이버 블로그</a></span></dd></div>
    <div><dt>DAY 31~40</dt><dd>독종반 모바일 단어장<br><span class="dim">발음 없음</span></dd></div>
    <div><dt>수집일</dt><dd>${escapeHTML(State.meta.crawledAt)}</dd></div>
    <div><dt>예문 보유</dt><dd>${State.meta.withExample.toLocaleString()} / ${State.meta.wordCount.toLocaleString()}</dd></div>
    ${State.meta.generatedExamples ? `<div><dt>생성한 예문</dt><dd>${State.meta.generatedExamples.toLocaleString()}</dd></div>` : ''}
    <div><dt>필수 / 만점 / 추가</dt><dd>${(State.meta.coreCount || 0).toLocaleString()} / ${(State.meta.wordCount - (State.meta.coreCount || 0) - (State.meta.extraCount || 0)).toLocaleString()} / ${(State.meta.extraCount || 0).toLocaleString()}</dd></div>
    <div><dt>발음 보유</dt><dd>${(State.meta.withAudio || 0).toLocaleString()} / ${State.meta.wordCount.toLocaleString()}</dd></div>
    <div><dt>단어 수</dt><dd>${State.meta.wordCount.toLocaleString()}</dd></div>
    ${(() => {
      const rs = Object.values(Store.data.words);
      const c = rs.reduce((n, r) => n + (r.correct || 0), 0);
      const w = rs.reduce((n, r) => n + (r.wrong || 0), 0);
      return c + w ? `<div><dt>채점 정확도</dt><dd>${Math.round(c / (c + w) * 100)}% <span class="dim">(${c.toLocaleString()} / ${(c + w).toLocaleString()})</span></dd></div>` : '';
    })()}
    <div><dt>진도 용량</dt><dd>${(bytes / 1024).toFixed(1)} KB</dd></div>
    <div><dt>앱 버전</dt><dd>${escapeHTML(BUILD)}</dd></div>`;
}

/** 진도를 내보낸다.
 *
 *  기기마다 저장소가 따로라 폰에서 본 진도가 PC에는 없다. 파일로 떨어뜨리면
 *  다시 찾아 옮겨야 하는데, 공유 시트를 쓸 수 있으면 에어드롭이나 메신저로
 *  한 번에 보낼 수 있다. 안 되는 기기에서는 예전처럼 파일로 떨어진다.
 */
async function exportProgress() {
  const name = `toeic-voca-progress-${todayISO()}.json`;
  const text = JSON.stringify(Store.data, null, 1);

  // 공유 시트는 폰에서만 쓴다. 데스크톱에서도 canShare는 true를 주지만,
  // OS 공유 시트를 거치면 파일 이름을 잃고 UUID로 떨어진다. PC에서는
  // 그냥 내려받는 편이 낫다 - 이름이 남아야 나중에 찾는다.
  const touch = matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.canShare) {
    try {
      const file = new File([text], name, { type: 'application/json' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: '토익 단어 진도' });
        return;                       // 취소해도 여기서 끝낸다
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;   // 사용자가 취소한 것
      // 공유가 안 되는 상황이면 파일로 떨어뜨린다
    }
  }

  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`${name} 으로 저장했습니다`);
}

function importProgress(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      let parsed;
      try {
        parsed = JSON.parse(reader.result);
      } catch {
        throw new Error('JSON 파일이 아닙니다');
      }
      if (!parsed || typeof parsed.words !== 'object' || parsed.words === null
          || Array.isArray(parsed.words)) {
        throw new Error('이 앱에서 내보낸 파일이 아닙니다');
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
      // 이어보기는 별도 키에 있다. 지우지 않으면 불러온 진도 위에 남의 세션이 얹힌다.
      localStorage.removeItem(SESSION_KEY);
      State.study = null;
      listGrades.clear();                        // 불러온 진도 위에 옛 되돌리기가 남으면 안 된다
      Store.load();                              // 마이그레이션을 그대로 태운다
      Store.prune(new Set(State.byId.keys()));   // 없어진 단어의 기록을 정리한다
      Theme.apply(Store.settings.theme);
      Store.flush();                             // 불러오기는 미루지 않고 바로 쓴다
      renderAll();
      toast(`${Object.keys(Store.data.words).length}단어의 진도를 불러왔습니다`);
    } catch (e) {
      toast('불러오기 실패: ' + e.message);
    }
  };
  reader.readAsText(file);
}

/** 달력.
 *
 *  브라우저 기본 달력은 파란 선택, 위아래 화살표, '삭제/오늘' 링크까지
 *  플랫폼 것이라 앱과 그림체가 달랐다. 앱을 shadcn 기준으로 맞춰 놨으니
 *  달력도 같은 규칙으로 그린다 - 검은 사각 선택, 흐린 요일 머리글,
 *  월·연 드롭다운, 양쪽 끝 화살표.
 */
const Calendar = {
  el: null,
  view: null,        // 지금 보고 있는 달 (Date, 1일로 맞춰 둠)
  value: null,       // 고른 날짜 (YYYY-MM-DD)
  onPick: null,

  open(value, onPick) {
    this.el = $('#calendar');
    this.value = value || null;
    this.onPick = onPick;
    const base = value ? new Date(value + 'T00:00:00') : new Date();
    this.view = new Date(base.getFullYear(), base.getMonth(), 1);
    this.el.hidden = false;
    this.render();
    // 바깥을 누르면 닫는다. 여는 클릭이 그대로 이어져 닫히지 않게 다음 틱부터.
    setTimeout(() => {
      document.addEventListener('pointerdown', this._outside, true);
      document.addEventListener('keydown', this._esc, true);
    }, 0);
  },

  close() {
    if (!this.el) return;
    this.el.hidden = true;
    this.el.innerHTML = '';
    document.removeEventListener('pointerdown', this._outside, true);
    document.removeEventListener('keydown', this._esc, true);
  },

  _outside: e => {
    const c = $('#calendar');
    if (!c || c.hidden) return;
    if (c.contains(e.target) || e.target.closest('#exam-date')) return;
    Calendar.close();
  },

  _esc: e => { if (e.key === 'Escape') Calendar.close(); },

  /** 월·연 목록을 연다. 네이티브 select를 쓰면 플랫폼이 제 크기로 띄워
   *  달력과 비율이 안 맞았다. 우리가 그린 목록을 대신 띄운다. */
  toggleMenu(which) {
    const menus = $$('.cal-menu', this.el);
    for (const menu of menus) {
      const mine = menu.dataset.for === which;
      menu.hidden = !mine || !menu.hidden;
      if (mine && !menu.hidden) {
        const on = menu.querySelector('.cal-opt.on');
        if (on) on.scrollIntoView({ block: 'center' });
      }
    }
  },

  closeMenus() {
    for (const menu of $$('.cal-menu', this.el)) menu.hidden = true;
  },

  shift(months) {
    this.view = new Date(this.view.getFullYear(), this.view.getMonth() + months, 1);
    this.render();
  },

  render() {
    const y = this.view.getFullYear(), m = this.view.getMonth();
    const today = todayISO();
    const first = new Date(y, m, 1);
    const start = new Date(y, m, 1 - first.getDay());     // 그 주 일요일부터
    const iso = d => d.toLocaleDateString('sv-SE');

    // 6주 x 7일. 달마다 줄 수가 달라지면 칸이 들썩인다.
    let cells = '';
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const s = iso(d);
      const cls = ['cal-day'];
      if (d.getMonth() !== m) cls.push('out');
      if (s === today) cls.push('today');
      if (s === this.value) cls.push('on');
      cells += `<button type="button" class="${cls.join(' ')}" data-date="${s}">${d.getDate()}</button>`;
    }

    // 연도는 올해를 가운데 두고 앞뒤로 조금씩
    const thisYear = new Date().getFullYear();
    const years = [];
    for (let i = thisYear - 1; i <= thisYear + 5; i++) years.push(i);
    if (!years.includes(y)) years.push(y), years.sort((a, b) => a - b);

    this.el.innerHTML = `
      <div class="cal-head">
        <button type="button" class="cal-nav" data-shift="-1" aria-label="이전 달">
          <svg viewBox="0 0 24 24" class="ico"><path d="m15 6-6 6 6 6"/></svg>
        </button>
        <div class="cal-pick">
          <div class="cal-sel-wrap">
            <button type="button" class="cal-sel" data-menu="month">
              <span>${m + 1}월</span>
              <svg viewBox="0 0 24 24" class="ico"><path d="m6 9 6 6 6-6"/></svg>
            </button>
            <div class="cal-menu" data-for="month" hidden>${
              Array.from({ length: 12 }, (_, i) =>
                `<button type="button" class="cal-opt${i === m ? ' on' : ''}" data-set-month="${i}">${i + 1}월</button>`).join('')}</div>
          </div>
          <div class="cal-sel-wrap">
            <button type="button" class="cal-sel" data-menu="year">
              <span>${y}</span>
              <svg viewBox="0 0 24 24" class="ico"><path d="m6 9 6 6 6-6"/></svg>
            </button>
            <div class="cal-menu" data-for="year" hidden>${
              years.map(v => `<button type="button" class="cal-opt${v === y ? ' on' : ''}" data-set-year="${v}">${v}</button>`).join('')}</div>
          </div>
        </div>
        <button type="button" class="cal-nav" data-shift="1" aria-label="다음 달">
          <svg viewBox="0 0 24 24" class="ico"><path d="m9 6 6 6-6 6"/></svg>
        </button>
      </div>
      <div class="cal-week">${['일','월','화','수','목','금','토']
        .map(d => `<span>${d}</span>`).join('')}</div>
      <div class="cal-grid">${cells}</div>`;
  },
};

/* ── 라우팅 ───────────────────────────────────────── */

function navigate(view) {
  Sheet.close();
  State.view = view;
  for (const v of $$('.view')) v.classList.toggle('on', v.dataset.view === view);
  markPick('#tabbar', 'nav', v => v === view);
  window.scrollTo(0, 0);

  if (view === 'home') renderHome();
  if (view === 'list') { renderListBox(); renderDayChips(); renderList(); }
  if (view === 'quiz') renderQuizSetup();
  if (view === 'settings') renderSettings();
  if (view === 'study' && !State.study) resumeOrStart();
}

function renderAll() {
  renderHome();
  if (State.view === 'list') renderList();
  if (State.view === 'settings') renderSettings();
}

/* ── 이벤트 ───────────────────────────────────────── */

/** DAY를 길게 누르면 무엇을 할지 고르는 시트를 연다.
 *  바로 초기화해버리면 실수로 진도를 날릴 수 있다. */
const Sheet = {
  day: null,
  openedAt: 0,

  open(day) {
    this.day = day;
    // 손을 떼는 순간 브라우저가 mousedown/mouseup/click을 만들어 보내는데,
    // 그때는 이미 시트가 열려 있어 그 클릭이 시트 버튼 위에 떨어진다.
    // 스크롤 위치에 따라 '진도 초기화'가 눌려 확인 없이 진도가 날아간다.
    this.openedAt = Date.now();
    const words = State.byDay.get(day) || [];
    const done = words.filter(w => Store.record(w.id)).length;
    $('#sheet-title').textContent = `DAY ${String(day).padStart(2, '0')} · ${dayTitle(day)}`;
    $('#sheet-sub').textContent = `${done}/${words.length} 진행`;
    $('[data-sheet="reset"]').disabled = done === 0;
    $('#sheet').hidden = false;
  },

  close() {
    $('#sheet').hidden = true;
    this.day = null;
  },

  run(action) {
    if (Date.now() - this.openedAt < 500) return;   // 손 떼며 생긴 유령 클릭
    const day = this.day;
    this.close();
    if (!day) return;
    if (action === 'study') return startStudy(day, 'day');
    if (action === 'redo') return startStudy(day, 'all', { resume: false });
    if (action === 'list') {
      State.list.day = day;
      State.list.shown = LIST_PAGE;
      return navigate('list');
    }
    if (action === 'reset') {
      const words = State.byDay.get(day) || [];
      const done = words.filter(w => Store.record(w.id)).length;
      if (!confirm(`DAY ${String(day).padStart(2, '0')}의 진도 ${done}개를 지웁니다. 계속할까요?`)) return;
      const n = Store.resetDay(day);
      renderHome();
      toast(`DAY ${String(day).padStart(2, '0')} 진도 ${n}개를 지웠습니다`);
    }
  },
};

function bindLongPress() {
  let timer = null, fired = false;

  const start = e => {
    const cell = e.target.closest('.day-cell');
    if (!cell) return;
    fired = false;
    timer = setTimeout(() => {
      fired = true;
      if (navigator.vibrate) navigator.vibrate(12);
      Sheet.open(Number(cell.dataset.day));
    }, 500);
  };
  const cancel = () => { clearTimeout(timer); timer = null; };

  for (const g of [$('#day-grid'), $('#day-grid-extra')]) {
    if (!g) continue;
    g.addEventListener('touchstart', start, { passive: true });
    g.addEventListener('mousedown', start);
    for (const ev of ['touchend', 'touchmove', 'touchcancel', 'mouseup', 'mouseleave'])
      g.addEventListener(ev, cancel, { passive: true });
    // 시트를 연 뒤에는 학습이 같이 시작되지 않게 클릭을 삼킨다
    g.addEventListener('click', e => {
      if (fired) { e.stopPropagation(); e.preventDefault(); fired = false; }
    }, true);
  }

  $('#sheet').addEventListener('click', e => {
    if (Date.now() - Sheet.openedAt < 500) return;  // 유령 클릭은 닫기도 막는다
    if (e.target.closest('[data-sheet-close]')) return Sheet.close();
    const item = e.target.closest('[data-sheet]');
    if (item) Sheet.run(item.dataset.sheet);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('#sheet').hidden) Sheet.close();
  });
}

function bind() {
  bindShell();
  bindHome();
  bindStudy();
  bindList();
  bindQuiz();
  bindSettings();
}

/** 화면을 가리지 않는 배선: 발음, 이동, 단축키, 시스템 테마 */
function bindShell() {
  bindLongPress();
  // 발음 버튼은 카드 안에 있다. 캡처 단계에서 잡아야 뒤집기보다 먼저 처리된다.
  document.addEventListener('click', e => {
    const say = e.target.closest('[data-say]');
    if (say) {
      e.stopPropagation();
      e.preventDefault();
      Speech.speak(say.dataset.say, say);
      return;
    }
    const speak = e.target.closest('[data-audio]');
    if (!speak) return;
    e.stopPropagation();
    e.preventDefault();
    Audio_.play(speak.dataset.audio, speak, speak.dataset.word || '');
  }, true);

  document.addEventListener('click', e => {
    const nav = e.target.closest('[data-nav]');
    if (nav) return navigate(nav.dataset.nav);

    const dayCell = e.target.closest('.day-cell');
    if (dayCell) return startStudy(Number(dayCell.dataset.day), 'day');

    const chip = e.target.closest('[data-chip]');
    if (chip) {
      State.list.day = chip.dataset.chip === 'all' ? null : Number(chip.dataset.chip);
      State.list.shown = LIST_PAGE;
      renderDayChips();
      return renderList();
    }
  });

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if ((Store.settings.theme || 'system') === 'system') Theme.apply('system');
  });

  // 데스크톱 단축키
  document.addEventListener('keydown', e => {
    if (State.view !== 'study' || studyMode() === 'list'
        || e.target.matches('input, select, textarea')) return;
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flipCard(); }
    if (e.key === '1') gradeCard('again');
    if (e.key === '2') gradeCard('hard');
    if (e.key === '3') gradeCard('good');
    if (e.key === 'ArrowLeft') prevCard();
    if (e.key === 'ArrowRight') skipCard();
  });
}

function bindHome() {
  $('#start-review').onclick = () => startStudy();
  $('#review-learned').onclick = () => startStudy(null, 'learned', { resume: false });
  // 외우지 않고 훑어만 보고 싶을 때가 있다
  $('#review-learned').oncontextmenu = e => { e.preventDefault(); openStage('seen'); };
  $('#review-weak').onclick = () => startStudy(null, 'weak', { resume: false });
  // 홈의 박스 칸과 통계 칸을 누르면 그 단어들을 목록으로 연다
  for (const sel of ['#boxbar', '#home-stats']) {
    $(sel).addEventListener('click', e => {
      const b = e.target.closest('[data-stage]');
      if (!b || b.disabled) return;
      const v = b.dataset.stage;
      openStage(v === 'all' ? null : (v === 'seen' || v === 'new') ? v : Number(v));
    });
  }
}

function bindStudy() {
  $('#flashcard').onclick = () => { if (!justSwiped()) flipCard(); };
  bindSwipe($('#flashcard'));
  $('#study-exit').onclick = () => { State.study = null; navigate('home'); };
  $('#study-prev').onclick = prevCard;
  $('#study-next').onclick = skipCard;
  // 카드 ↔ 목록. 같은 큐를 다르게 보여줄 뿐이라 범위는 그대로다.
  bindPick('#study-mode', 'smode', v => {
    if (studyMode() === v) return;
    Store.settings.studyMode = v;
    Store.save();
    const s = State.study;
    if (s && v === 'card') {
      // 목록에서 이미 매긴 단어는 카드로 다시 내지 않는다. 오늘 한 것 다음부터.
      const today = todayISO();
      while (s.index < s.queue.length && seenToday(s.queue[s.index].id, today)) s.index++;
      s.floor = s.index;                 // 되돌리기로 그 아래로는 못 간다
    }
    if (s) saveSession();                // 앞당긴 자리를 남긴다. 안 그러면 껐다 켜면 되돌아간다.
    renderStudy();
  });
  $('#study-list').addEventListener('click', e => {
    const row = e.target.closest('.srow');
    if (!row) return;
    const b = e.target.closest('[data-lgrade]');
    if (b) { if (!b.disabled) gradeInList(row.dataset.id, b.dataset.lgrade); return; }
    if (e.target.closest('[data-audio], [data-say]')) return;   // 발음은 캡처 단계가 처리했다
    row.classList.toggle('open');
  });
  $('#study-next-day').onclick = () => {
    const day = State.study && State.study.dayFilter;
    if (day) startStudy(day + 1, 'day', { resume: false });
  };
  $('#study-again').onclick = () => {
    const day = State.study && State.study.dayFilter;
    if (day) startStudy(day, 'all', { resume: false });
  };
  bindPick('#grade-bar', 'grade', v => gradeCard(v));
}

function bindList() {
  const searchLater = debounce(renderList, 150);
  $('#search').addEventListener('input', e => {
    State.list.query = e.target.value;
    State.list.shown = LIST_PAGE;
    searchLater();
  });
  $('#toggle-mask').onclick = e => {
    State.list.masked = !State.list.masked;
    e.currentTarget.setAttribute('aria-pressed', String(State.list.masked));
    e.currentTarget.classList.toggle('on', State.list.masked);
    e.currentTarget.textContent = State.list.masked ? '뜻 보이기' : '뜻 가리기';
    renderList();
  };
  $('#toggle-weak').onclick = e => {
    State.list.weakOnly = !State.list.weakOnly;
    e.currentTarget.setAttribute('aria-pressed', String(State.list.weakOnly));
    e.currentTarget.classList.toggle('on', State.list.weakOnly);
    State.list.shown = LIST_PAGE;
    renderList();
  };
  bindPick('#list-box', 'box', v => {
    const n = Number(v);
    const cur = State.list.boxes;
    // 여러 개 겹쳐 고른다. 전부 끄면 전체다.
    State.list.boxes = cur.includes(n) ? cur.filter(b => b !== n) : [...cur, n].sort();
    State.list.shown = LIST_PAGE;
    renderListBox();
    renderList();
  });
  $('#list-stage').onclick = () => {
    State.list.stage = null;
    State.list.shown = LIST_PAGE;
    renderList();
  };
  $('#list-to-study').onclick = () => {
    if (State.list.day) startStudy(State.list.day, 'day');
  };
}

function bindQuiz() {
  bindPick('#quiz-scope', 'scope', (v, b) => {
    markPick('#quiz-scope', 'scope', (_, x) => x === b);
    renderQuizSetup();
  });
  bindPick('#quiz-day-chips', 'quizday', v => {
    State.quizDay = Number(v);
    renderQuizSetup();
  });
  bindPick('#quiz-length', 'len', (v, b) => {
    markPick('#quiz-length', 'len', (_, x) => x === b);
    $('#quiz-count').value = '';        // 버튼을 고르면 직접 입력은 비운다
    renderQuizSetup();
  });
  const quizCountLater = debounce(renderQuizSetup, 250);
  $('#quiz-count').addEventListener('input', () => {
    for (const x of $$('#quiz-length button')) x.classList.remove('on');
    quizCountLater();
  });
  bindPick('#quiz-type', 'qtype', v => {
    Store.settings.quizType = v;
    Store.save();
    renderQuizSetup();
  });
  $('#quiz-start').onclick = startQuiz;
  $('#quiz-next').onclick = nextQuiz;
  $('#quiz-again').onclick = () => { $('#quiz-result').hidden = true; $('#quiz-setup').hidden = false; renderQuizSetup(); };
  $('#quiz-exit').onclick = () => { $('#quiz-run').hidden = true; $('#quiz-setup').hidden = false; renderQuizSetup(); };
  bindPick('#quiz-options', 'opt', v => answerQuiz(v));
}

function bindSettings() {
  bindPick('#set-direction', 'dir', v => {
    Store.settings.direction = v;
    Store.save();
    renderSettings();
  });
  bindPick('#set-quizgrade', 'quizgrade', v => {
    Store.settings.quizAffectsBox = v === 'on';
    Store.save();
    renderSettings();
  });
  bindPick('#set-autoplay', 'autoplay', v => {
    Store.settings.autoplay = v === 'on';
    Store.save();
    renderSettings();
  });
  bindPick('#set-voice', 'voice', v => {
    Store.settings.voiceMode = v;
    Store.save();
    renderSettings();
  });
  bindPick('#set-theme', 'theme-opt', v => {
    Store.settings.theme = v;
    Store.save();
    Theme.apply(v);
    renderSettings();
  });
  bindPick('#set-passes', 'passes', v => {
    Store.settings.targetPasses = Number(v);
    Store.save();
    renderSettings();
    renderHome();
  });
  bindPick('#set-limit', 'limit', v => {
    Store.settings.newPerDay = Number(v);
    $('#new-count').value = '';
    Store.save();
    renderSettings();
    renderHome();
  });
  bindPick('#set-tier', 'tier', v => {
    const next = toggleTier(Store.settings.tiers, v);
    if (!next) return;
    Store.settings.tiers = next;
    delete Store.data.session;         // 범위가 바뀌면 이어보기도 무효다
    Store.save();
    State.study = null;
    renderSettings();
    renderHome();
  });
  bindPick('#set-scope', 'scope', v => {
    Store.settings.onlyWithExample = v === 'example';
    delete Store.data.session;
    Store.save();
    State.study = null;
    renderSettings();
    renderHome();
  });

  // 화면 다시 그리기는 미룬다. '150'을 치면 1, 15, 150 세 번이 들어오는데
  // 그때마다 설정과 홈을 통째로 다시 그릴 이유가 없다.
  const newCountLater = debounce(() => { renderSettings(); renderHome(); }, 250);
  $('#new-count').addEventListener('input', e => {
    const v = Math.floor(Number(e.target.value));
    if (!Number.isFinite(v) || v < 1) return;      // 비우는 중이면 건드리지 않는다
    Store.settings.newPerDay = v;
    Store.save();
    newCountLater();
  });

  bindCalendar();

  $('#apply-plan').onclick = () => {
    const plan = examPlan(homeStats().freshTotal);
    if (!plan || !plan.perDay) return;
    Store.settings.newPerDay = plan.perDay;
    Store.save();
    renderSettings();
    renderHome();
    toast(`하루 새 단어를 ${plan.perDay.toLocaleString()}개로 맞췄습니다`);
  };

  $('#voice-test').onclick = () => {
    Speech.prime();
    Speech.warned = false;         // 안 되면 이번엔 다시 알려 준다
    Speech.speak('This is a test sentence for the pronunciation check.', $('#voice-test'));
  };

  $('#prefetch-audio').onclick = async e => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const label = btn.textContent;
    const { total, failed } = await Audio_.prefetch((done, all) => {
      btn.textContent = `내려받는 중 ${done}/${all}`;
    });
    btn.textContent = label;
    btn.disabled = false;
    toast(failed ? `${total - failed}개 저장, ${failed}개 실패` : `발음 ${total}개를 저장했습니다`);
  };

  $('#export').onclick = exportProgress;
  $('#import').onclick = () => $('#import-file').click();
  $('#import-file').onchange = e => { if (e.target.files[0]) importProgress(e.target.files[0]); };
  $('#reset').onclick = () => {
    if (!confirm('학습 진도를 모두 지웁니다. 계속할까요?')) return;
    Store.reset();
    State.study = null;
    renderAll();
    toast('진도를 초기화했습니다');
  };
}

/** 시험일 달력. 필드를 누르면 열리고, 팝오버 안의 모든 조작을 한곳에서 받는다. */
function bindCalendar() {
  $('#exam-date').onclick = () => {
    if (!$('#calendar').hidden) return Calendar.close();
    Calendar.open(Store.settings.examDate, iso => {
      Store.settings.examDate = iso;
      Store.save();
      Calendar.close();
      renderSettings();
      renderHome();
    });
  };
  $('#calendar').addEventListener('click', e => {
    const menuBtn = e.target.closest('[data-menu]');
    if (menuBtn) return Calendar.toggleMenu(menuBtn.dataset.menu);

    const mo = e.target.closest('[data-set-month]');
    if (mo) {
      const d = Calendar.view;
      Calendar.view = new Date(d.getFullYear(), Number(mo.dataset.setMonth), 1);
      return Calendar.render();
    }
    const yr = e.target.closest('[data-set-year]');
    if (yr) {
      const d = Calendar.view;
      Calendar.view = new Date(Number(yr.dataset.setYear), d.getMonth(), 1);
      return Calendar.render();
    }

    Calendar.closeMenus();          // 목록 밖을 눌렀으면 닫는다
    const day = e.target.closest('[data-date]');
    if (day) return Calendar.onPick(day.dataset.date);
    const nav = e.target.closest('[data-shift]');
    if (nav) return Calendar.shift(Number(nav.dataset.shift));
  });
  $('#exam-clear').onclick = () => {
    Calendar.close();
    Store.settings.examDate = '';
    Store.save();
    renderSettings();
    renderHome();
  };
}

/* ── 시작 ─────────────────────────────────────────── */

/** 새 버전이 나오면 스스로 갈아입는다.
 *
 *  예전에는 등록만 해두고 끝이라 두 번 열어야 새 버전이 보였다. 첫 실행에서
 *  새 서비스워커가 설치되고, 그 다음 실행에서야 그게 준 파일을 쓰기 때문이다.
 *  홈 화면에 추가해 쓰면 앱을 껐다 켜는 일 자체가 드물어 더 오래 묵는다.
 *
 *  그래서 새 워커가 조종간을 잡는 순간 한 번 새로고침한다. 이미 조종하던
 *  워커가 있었을 때만이다 — 처음 설치할 때도 이 이벤트가 뜨는데,
 *  그때 새로고침하면 첫 실행이 공연히 두 번 뜬다.
 */
function setupUpdates() {
  // 처음 설치할 때도 이 이벤트가 한 번 뜬다. 그때 새로고침하면 첫 실행이
  // 공연히 두 번 뜨므로 넘긴다. 다만 '넘긴다'로 끝내면 안 된다 —
  // 그 뒤로 오는 진짜 갱신까지 같이 무시하게 된다.
  let seenController = !!navigator.serviceWorker.controller;
  let reloading = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!seenController) { seenController = true; return; }   // 첫 장악
    if (reloading) return;
    reloading = true;
    Store.flush();               // 새로고침 전에 진도를 확실히 적어둔다
    location.reload();
  });

  navigator.serviceWorker.register('sw.js').then(reg => {
    // 앱을 며칠씩 안 끄고 두는 경우가 있어 가끔 직접 물어본다
    setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { reg.update().catch(() => {}); checkVersion(); }
    });
  }).catch(e => console.warn('SW 등록 실패', e));

  checkVersion();
}

/** 서버에 지금 몇 번인지 직접 물어보고, 낡았으면 스스로 갈아엎는다.
 *
 *  위의 reg.update()는 브라우저가 sw.js를 다시 받아 볼 마음이 있어야 듣는다.
 *  홈 화면에 추가해 쓰는 앱에서는 그게 며칠씩 안 일어나기도 하고, 그러면
 *  고쳐서 배포해도 기기에는 영영 닿지 않는다. 실제로 그런 일이 있었다.
 *
 *  그래서 캐시를 타지 않는 작은 파일 하나를 따로 두고 직접 비교한다.
 *  다르면 서비스워커와 캐시를 통째로 버리고 새로 받는다. 진도는 별도
 *  저장소에 있어 지워지지 않지만, 그래도 먼저 확실히 적어 둔다.
 */
async function checkVersion() {
  if (sessionStorage.getItem('toeic-voca-healing')) return;   // 한 번만
  try {
    const res = await fetch('version.json', { cache: 'no-store' });
    if (!res.ok) return;
    const { build } = await res.json();
    if (!build || build === BUILD) return;

    sessionStorage.setItem('toeic-voca-healing', build);
    Store.flush();
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
    // 발음 캐시는 남긴다. sw.js의 activate는 이걸 지키는데 여기서 통째로
    // 지워 버리면, 앱을 고칠 때마다 사용자가 24MB를 셀룰러로 다시 받는다.
    for (const k of await caches.keys()) {
      if (k !== AUDIO_CACHE) await caches.delete(k);
    }
    location.reload();
  } catch (e) {
    // 오프라인이면 그냥 넘어간다. 다음에 연결됐을 때 다시 본다.
  }
}

(async function init() {
  try {
    Store.load();
    Theme.apply(Store.settings.theme);
    await loadData();
    Store.prune(new Set(State.byId.keys()));
    bind();
    // iOS는 첫 발화가 사용자 손짓 안에서 일어나야 한다. 아무 데나 한 번
    // 닿는 순간 엔진을 깨워 둔다.
    addEventListener('pointerdown', () => Speech.prime(), { once: true, passive: true });
    Speech.watch();
    Speech.pick();          // 목록을 미리 당겨 둔다 (iOS는 처음 부를 때 채워진다)
    // 저장을 미뤄 두는 대신, 앱이 가려지거나 닫히는 순간에는 반드시 비운다.
    // 폰에서는 홈 버튼을 누르면 그대로 종료될 수 있어 pagehide가 마지막 기회다.
    addEventListener('pagehide', () => Store.flush());
    addEventListener('freeze', () => Store.flush());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) Store.flush();
    });
    $('#loading').hidden = true;
    $('#app').hidden = false;
    navigate('home');

    if ('serviceWorker' in navigator) setupUpdates();
  } catch (e) {
    $('#loading').innerHTML =
      `<p class="muted" style="padding:2rem;text-align:center">데이터를 불러오지 못했습니다.<br>${escapeHTML(e.message)}</p>`;
    console.error(e);
  }
})();
