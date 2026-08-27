'use strict';

/* ── 상수 ─────────────────────────────────────────── */

// 배포할 때 bump_sw.py가 docs/ 내용 해시로 채운다. 설정에서 보여 주기 위한 것으로,
// 기기가 새 버전을 받았는지 눈으로 확인할 수 있다.
const BUILD = '03c92cf2';

const STORAGE_KEY = 'toeic-voca-progress';
const SESSION_KEY = 'toeic-voca-session';
const THEME_KEY = 'toeic-voca-theme';
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
  settings: { direction: 'mixed', newPerDay: -1, onlyWithExample: false, autoplay: false, tiers: ['core', 'bonus', 'extra'], theme: 'system', quizAffectsBox: false },
  words: {},
  days: {},
  session: null,
};

/* ── 유틸 ─────────────────────────────────────────── */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const todayISO = () => new Date().toLocaleDateString('sv-SE');  // YYYY-MM-DD (로컬)

/** 저장된 박스 값을 1~5 정수로 강제한다. 손상된 값이 스케줄을 망가뜨리지 않게. */
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
  play(file, btn) {
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

  speakerHTML(file, cls = 'speak') {
    if (!file) return '';
    return `<button class="${cls}" type="button" data-audio="${escapeHTML(file)}" aria-label="발음 듣기">`
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
          words: parsed.words || {},
          days: parsed.days || {},
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
        this.data.settings.tiers = ['core', 'bonus', 'extra'];
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
    if (!fresh.length && !due.length) return shuffle(pool);
    // 기한이 된 복습을 먼저 털고 새 단어로 넘어간다
    return [...shuffle(due), ...fresh];
  },

  /** 지금까지 한 번이라도 본 단어 전부. 기한은 따지지 않는다.
   *  DAY 3까지 떼고 바로 훑고 싶을 때 쓴다. */
  learned() {
    return shuffle(inScope(State.words).filter(w => Store.record(w.id)));
  },

  /** 한 번이라도 틀린 단어. 많이 틀린 것부터 내보낸다. */
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
    const rec = Store.ensure(id);
    const today = todayISO();
    // 저장소가 손상돼 box가 숫자가 아니면 BOX_INTERVALS[NaN]이 undefined가 되고
    // due가 "Invalid Date"로 굳는다. 그러면 그 단어는 영영 기한이 오지 않는다.
    rec.box = clampBox(rec.box);

    if (result === 'again') {
      // 틀린 것은 기한과 무관하게 반영한다. 모른다는 건 진짜 모르는 것이다.
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

    const day = Number(id.slice(1, 3));
    Store.data.days[day] = { lastStudied: todayISO() };
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
  list: { day: null, tiers: ['core', 'bonus', 'extra'], query: '', masked: false, weakOnly: false, shown: LIST_PAGE },
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

/** DAY의 단원명. '동사 (1)'처럼 번호가 붙은 것은 묶을 때 번호를 뗀다. */
const dayTitle = day => {
  const d = State.days.find(x => x.day === day);
  return d ? (d.title || '') : '';
};
// 원본 표기가 들쭉날쭉하다. '필수 어휘'와 '필수어휘'가 섞여 있고 ETS 접두어도
// 붙었다 말았다 한다. 그대로 묶으면 DAY 5·6·7이 세 덩어리로 갈린다.
const groupTitle = title => (title || '')
  .replace(/\s*\(\d+\)\s*$/, '')
  .replace(/^ETS\s+/, '')
  .replace(/필수\s*어휘/, '필수 어휘')
  .replace(/\s+/g, ' ')
  .trim();

const meaningText = w => w.meaning;
const posText = w => w.pos;

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
      ${e.ko ? `<div class="ko">${escapeHTML(e.ko)}</div>` : ''}
    </div>`).join('');

  const colloc = w.collocations.length ? `
    <div class="colloc">${w.collocations.map(c =>
      `<span><b>${escapeHTML(c.en)}</b>${c.ko ? ' ' + escapeHTML(c.ko) : ''}</span>`).join('')}
    </div>` : '';

  return `
    <div class="head"><h3>${escapeHTML(w.headword)}</h3>${Audio_.speakerHTML(w.audio)}</div>
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
  $('#start-review').disabled = !(due || fresh);

  const learned = seen;
  const reviewBtn = $('#review-learned');
  reviewBtn.hidden = learned === 0;
  reviewBtn.textContent = `배운 단어 (${learned.toLocaleString()})`;

  const weak = st.weak;
  const weakBtn = $('#review-weak');
  weakBtn.hidden = weak === 0;
  weakBtn.textContent = `틀린 단어 (${weak.toLocaleString()})`;

  $('#stat-seen').textContent = seen.toLocaleString();
  $('#stat-mastered').textContent = mastered.toLocaleString();
  $('#stat-total').textContent = total.toLocaleString();

  $('#boxbar').innerHTML = boxes.map((n, i) =>
    `<div><b>${n}</b><span>박스 ${i + 1}</span></div>`).join('');

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

function startStudy(dayFilter = null, mode = 'due', { resume = true } = {}) {
  // 홈의 '오늘 학습 시작'은 기한이 된 것과 새 단어만,
  // DAY를 직접 고르면 그 DAY 전부를 본다.
  const saved = Store.data.session;
  // 어제 만든 세션을 오늘 이어보면 안 된다. 그 카드들은 이미 채점돼 기한이 미래라
  // 아무리 눌러도 박스가 움직이지 않고, 오늘 볼 것은 그대로 남는다.
  if (resume && saved && saved.date === todayISO()
      && saved.dayFilter === dayFilter && saved.mode === mode
      && saved.ids && saved.index > 0 && saved.index < saved.ids.length) {
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
                      relearn: saved.relearn || 0,
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
  if (!s || s.index >= s.queue.length) {
    delete Store.data.session;
  } else {
    // 큐는 고정이 아니다. 모름·애매를 누르면 그 카드가 뒤에 다시 끼워지고,
    // 되돌리면 빠진다. 한 번 만든 id 목록을 재사용했더니 다시 볼 카드가
    // 저장에서 통째로 누락돼, 껐다 켜면 그 단어들이 사라졌다.
    Store.data.session = { date: todayISO(), dayFilter: s.dayFilter, mode: s.mode,
                           index: s.index, graded: s.graded,
                           relearn: s.relearn || 0, retries: s.retries || {},
                           ids: s.queue.map(w => w.id) };
  }
  Store.save();
}

function renderStudy() {
  const s = State.study;
  const done = $('#study-done');
  const stage = $('#card-stage');
  const bar = $('#grade-bar');

  if (!s || s.index >= s.queue.length) {
    stage.hidden = true;
    bar.hidden = true;
    done.hidden = false;
    $('.scope-row').hidden = true;
    if (s) saveSession();

    const day = s && s.dayFilter;
    const nothing = !s || !s.queue.length;
    $('#study-done-title').textContent =
      nothing ? '볼 단어가 없습니다'
      : s.mode === 'learned' ? '복습 완료'
      : day ? `DAY ${String(day).padStart(2, '0')} 완료` : '오늘 학습 완료';
    $('#study-done-sub').textContent = s && s.graded
      ? `${s.graded}번 채점했습니다` +
        (s.relearn ? ` (${s.relearn}장은 세션 안에서 다시 냈습니다)` : '')
      : '오늘 볼 단어가 없습니다. 홈에서 DAY를 누르면 기한과 상관없이 다시 볼 수 있습니다.';

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

  stage.hidden = false;
  done.hidden = true;

  const w = s.queue[s.index];
  const card = $('#flashcard');
  card.classList.remove('flipped');
  bar.hidden = true;

  const dir = directionFor(w.id);
  $('#card-day').textContent = `DAY ${String(w.day).padStart(2, '0')}`;
  $('#card-front').textContent = dir === 'en2ko' ? w.headword : meaningText(w);
  $('#card-back').innerHTML = cardBackHTML(w);

  const speak = $('#card-speak');
  speak.hidden = !(dir === 'en2ko' && w.audio);
  speak.dataset.audio = w.audio || '';
  speak.classList.remove('loading', 'playing', 'failed');   // 앞 카드 상태를 물려받지 않게
  // 카드가 뜨면 그 단어 발음을 미리 받아 둔다. 눌렀을 때 바로 나게.
  Audio_.prime(w.audio);
  if (dir === 'en2ko' && Store.settings.autoplay) Audio_.play(w.audio, speak);

  $('#study-counter').textContent = `${s.index + 1}/${s.queue.length}`;
  $('#study-progress').style.transform = `scaleX(${s.index / s.queue.length})`;
  const left = s.queue.length - s.index;
  $('#study-scope').textContent =
    (s.mode === 'weak' ? '자주 틀린 단어'
      : s.mode === 'learned' ? '배운 단어 복습'
      : s.dayFilter ? `DAY ${String(s.dayFilter).padStart(2, '0')} · ${dayTitle(s.dayFilter)}`
                    + (s.mode === 'all' ? ' · 전체' : '')
      : '오늘 학습') +
    ` · ${left}장 남음` + (s.relearn ? ` · 다시 낸 카드 ${s.relearn}장` : '');
  $('#study-to-list').hidden = !s.dayFilter;
  $('#grade-note').hidden = true;
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
  if (Store.settings.autoplay && directionFor(w.id) === 'ko2en') Audio_.play(w.audio, $('#card-back .speak'));
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

function renderListTier() {
  for (const b of $$('#list-tier button'))
    b.classList.toggle('on', State.list.tiers.includes(b.dataset.tier));
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
  const { day, tiers, query } = State.list;
  const q = query.trim().toLowerCase();
  let pool = day === null ? State.words : (State.byDay.get(day) || []);
  if (tiers.length < 3) pool = pool.filter(w => tiers.includes(w.tier));
  if (State.list.weakOnly) pool = pool.filter(w => (Store.record(w.id) || {}).wrong > 0);
  if (!q) return pool;
  return pool.filter(w => w.q.includes(q));
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
  const ex = w.examples[0];
  const pos = posText(w);
  return `<div class="word-item"><div class="row">`
    + `<span class="hw">${escapeHTML(w.headword)}</span>`
    + (pos ? `<span class="pos">${escapeHTML(pos)}</span>` : '')
    + `<span class="tags">`
    + `<span class="tier">${TIER_LABEL[w.tier] || '기타'}</span>`
    + `<span class="miss">${rec && rec.wrong ? '✕' + rec.wrong : ''}</span>`
    + `<span class="box">${rec ? '박스 ' + rec.box : ''}</span>`
    + `<span class="spk">${w.audio ? Audio_.speakerHTML(w.audio) : ''}</span>`
    + `</span></div>`
    + `<div class="mean">${escapeHTML(meaningText(w))}</div>`
    + (ex ? `<div class="ex">${escapeHTML(ex.en)}${ex.generated ? '<span class="gen">생성</span>' : ''}`
          + (ex.ko ? `<div class="ko">${escapeHTML(ex.ko)}</div>` : '') + `</div>` : '')
    + `</div>`;
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

function renderListCount(words) {
  const withEx = words.reduce((n, w) => n + (w.examples.length ? 1 : 0), 0);
  // DAY를 골랐으면 단원명을 앞에 붙인다. 홈 칸에는 넣을 자리가 없어
  // 어느 단원인지 알 수 있는 자리가 여기와 학습 화면뿐이다.
  const head = State.list.day !== null ? `${dayTitle(State.list.day)} · ` : '';
  $('#list-count').textContent = head +
    `${words.length.toLocaleString()}단어 · 예문 ${withEx.toLocaleString()}` +
    (words.length > State.list.shown ? ` · ${State.list.shown}개 표시 중` : '');
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

function buildQuestion(word, pool, dayCache) {
  const dir = directionFor(word.id);
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
    prompt: dir === 'en2ko' ? word.headword : meaningText(word),
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
  $('#quiz-question').textContent = cur.prompt;
  $('#quiz-next').hidden = true;

  const box = $('#quiz-options');
  box.classList.remove('locked');
  box.innerHTML = cur.options.map(o =>
    `<button data-opt="${escapeHTML(o)}">${escapeHTML(o)}</button>`).join('');
}

function answerQuiz(choice) {
  const q = State.quiz;
  const cur = q.questions[q.index];
  const box = $('#quiz-options');
  box.classList.add('locked');

  const ok = choice === cur.answer;
  if (ok) q.correct++;
  else q.wrong.push(cur.id);
  // 사지선다는 찍어도 맞을 수 있어 기본으로는 박스를 건드리지 않는다.
  if (Store.settings.quizAffectsBox) Scheduler.grade(cur.id, ok ? 'good' : 'again');

  for (const btn of $$('button', box)) {
    if (btn.dataset.opt === cur.answer) btn.classList.add('correct');
    else if (btn.dataset.opt === choice) btn.classList.add('wrong');
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
  for (const b of $$('#set-direction button')) b.classList.toggle('on', b.dataset.dir === direction);
  // 프리셋에 없는 값은 직접 입력 칸에 담는다
  const presets = $$('#set-limit button').map(b => Number(b.dataset.limit));
  const custom = !presets.includes(newPerDay);
  for (const b of $$('#set-limit button'))
    b.classList.toggle('on', !custom && Number(b.dataset.limit) === newPerDay);
  const nc = $('#new-count');
  if (document.activeElement !== nc) nc.value = custom ? String(newPerDay) : '';
  for (const b of $$('#set-scope button'))
    b.classList.toggle('on', (b.dataset.scope === 'example') === onlyWithExample);

  for (const b of $$('#set-quizgrade button'))
    b.classList.toggle('on', (b.dataset.quizgrade === 'on') === !!Store.settings.quizAffectsBox);
  for (const b of $$('#set-theme button'))
    b.classList.toggle('on', b.dataset.themeOpt === (Store.settings.theme || 'system'));
  for (const b of $$('#set-tier button'))
    b.classList.toggle('on', Store.settings.tiers.includes(b.dataset.tier));
  const counts = tierCounts();
  $('#tier-hint').textContent =
    `필수 ${counts.core.toLocaleString()} → 만점 ${counts.bonus.toLocaleString()} → ` +
    `추가 ${counts.extra.toLocaleString()} 순서로 끝내면 됩니다. ` +
    '필수와 만점은 ETS 공식 교재(DAY 1~30), 추가는 독종반 모바일 단어장(DAY 31~40)에서 ' +
    '왔습니다. 추가 등급에는 발음이 없습니다.';
  for (const b of $$('#set-autoplay button'))
    b.classList.toggle('on', (b.dataset.autoplay === 'on') === Store.settings.autoplay);
  $('#audio-hint').textContent =
    `${(State.meta.withAudio || 0).toLocaleString()}단어에 발음이 있습니다. ` +
    '들은 발음은 자동으로 저장되고, 내려받아 두면 오프라인에서도 들립니다.';

  // homeStats가 이미 한 바퀴로 세어 준다. split()을 또 돌려 정렬까지 할 일이 아니다.
  const { freshTotal } = homeStats();
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

function exportProgress() {
  const blob = new Blob([JSON.stringify(Store.data, null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `toeic-voca-progress-${todayISO()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('진도를 파일로 저장했습니다');
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

/* ── 라우팅 ───────────────────────────────────────── */

function navigate(view) {
  Sheet.close();
  State.view = view;
  for (const v of $$('.view')) v.classList.toggle('on', v.dataset.view === view);
  for (const b of $$('#tabbar button')) b.classList.toggle('on', b.dataset.nav === view);
  window.scrollTo(0, 0);

  if (view === 'home') renderHome();
  if (view === 'list') { renderListTier(); renderDayChips(); renderList(); }
  if (view === 'quiz') renderQuizSetup();
  if (view === 'settings') renderSettings();
  if (view === 'study' && !State.study) startStudy();
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
  bindLongPress();
  // 발음 버튼은 카드 안에 있다. 캡처 단계에서 잡아야 뒤집기보다 먼저 처리된다.
  document.addEventListener('click', e => {
    const speak = e.target.closest('[data-audio]');
    if (!speak) return;
    e.stopPropagation();
    e.preventDefault();
    Audio_.play(speak.dataset.audio, speak);
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

  $('#start-review').onclick = () => startStudy();
  $('#review-learned').onclick = () => startStudy(null, 'learned', { resume: false });
  $('#review-weak').onclick = () => startStudy(null, 'weak', { resume: false });
  $('#toggle-weak').onclick = e => {
    State.list.weakOnly = !State.list.weakOnly;
    e.currentTarget.setAttribute('aria-pressed', String(State.list.weakOnly));
    e.currentTarget.classList.toggle('on', State.list.weakOnly);
    State.list.shown = LIST_PAGE;
    renderList();
  };
  $('#flashcard').onclick = () => { if (!justSwiped()) flipCard(); };
  bindSwipe($('#flashcard'));
  $('#study-exit').onclick = () => { State.study = null; navigate('home'); };
  $('#study-prev').onclick = prevCard;
  $('#study-next').onclick = skipCard;
  $('#study-to-list').onclick = () => {
    const day = State.study && State.study.dayFilter;
    if (!day) return;
    State.list.day = day;
    State.list.tiers = ['core', 'bonus', 'extra'];
    State.list.shown = LIST_PAGE;
    navigate('list');
  };
  $('#study-next-day').onclick = () => {
    const day = State.study && State.study.dayFilter;
    if (day) startStudy(day + 1, 'day', { resume: false });
  };
  $('#study-again').onclick = () => {
    const day = State.study && State.study.dayFilter;
    if (day) startStudy(day, 'all', { resume: false });
  };
  $('#list-to-study').onclick = () => {
    if (State.list.day) startStudy(State.list.day, 'day');
  };
  $('#grade-bar').onclick = e => {
    const b = e.target.closest('[data-grade]');
    if (b) gradeCard(b.dataset.grade);
  };

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

  $('#quiz-scope').onclick = e => {
    const b = e.target.closest('[data-scope]');
    if (!b) return;
    for (const x of $$('#quiz-scope button')) x.classList.toggle('on', x === b);
    renderQuizSetup();
  };
  $('#quiz-day-chips').onclick = e => {
    const b = e.target.closest('[data-quizday]');
    if (!b) return;
    State.quizDay = Number(b.dataset.quizday);
    renderQuizSetup();
  };
  $('#quiz-length').onclick = e => {
    const b = e.target.closest('[data-len]');
    if (!b) return;
    for (const x of $$('#quiz-length button')) x.classList.toggle('on', x === b);
    $('#quiz-count').value = '';        // 버튼을 고르면 직접 입력은 비운다
    renderQuizSetup();
  };
  const quizCountLater = debounce(renderQuizSetup, 250);
  $('#quiz-count').addEventListener('input', () => {
    for (const x of $$('#quiz-length button')) x.classList.remove('on');
    quizCountLater();
  });
  $('#quiz-start').onclick = startQuiz;
  $('#quiz-next').onclick = nextQuiz;
  $('#quiz-again').onclick = () => { $('#quiz-result').hidden = true; $('#quiz-setup').hidden = false; renderQuizSetup(); };
  $('#quiz-exit').onclick = () => { $('#quiz-run').hidden = true; $('#quiz-setup').hidden = false; renderQuizSetup(); };
  $('#quiz-options').onclick = e => {
    const b = e.target.closest('[data-opt]');
    if (b) answerQuiz(b.dataset.opt);
  };

  $('#set-direction').onclick = e => {
    const b = e.target.closest('[data-dir]');
    if (!b) return;
    Store.settings.direction = b.dataset.dir;
    Store.save();
    renderSettings();
  };
  $('#set-quizgrade').onclick = e => {
    const b = e.target.closest('[data-quizgrade]');
    if (!b) return;
    Store.settings.quizAffectsBox = b.dataset.quizgrade === 'on';
    Store.save();
    renderSettings();
  };
  $('#set-theme').onclick = e => {
    const b = e.target.closest('[data-theme-opt]');
    if (!b) return;
    Store.settings.theme = b.dataset.themeOpt;
    Store.save();
    Theme.apply(Store.settings.theme);
    renderSettings();
  };
  $('#set-tier').onclick = e => {
    const b = e.target.closest('[data-tier]');
    if (!b) return;
    const cur = Store.settings.tiers;
    const next = cur.includes(b.dataset.tier)
      ? cur.filter(t => t !== b.dataset.tier)
      : [...cur, b.dataset.tier];
    if (!next.length) return;            // 하나는 남겨둔다
    Store.settings.tiers = next;
    delete Store.data.session;          // 범위가 바뀌면 이어보기도 무효다
    Store.save();
    State.study = null;
    renderSettings();
    renderHome();
  };
  $('#list-tier').onclick = e => {
    const b = e.target.closest('[data-tier]');
    if (!b) return;
    const cur = State.list.tiers;
    const next = cur.includes(b.dataset.tier)
      ? cur.filter(t => t !== b.dataset.tier)
      : [...cur, b.dataset.tier];
    if (!next.length) return;
    State.list.tiers = next;
    State.list.shown = LIST_PAGE;
    renderListTier();
    renderList();
  };
  $('#set-autoplay').onclick = e => {
    const b = e.target.closest('[data-autoplay]');
    if (!b) return;
    Store.settings.autoplay = b.dataset.autoplay === 'on';
    Store.save();
    renderSettings();
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
  $('#set-scope').onclick = e => {
    const b = e.target.closest('[data-scope]');
    if (!b) return;
    Store.settings.onlyWithExample = b.dataset.scope === 'example';
    delete Store.data.session;
    Store.save();
    State.study = null;
    renderSettings();
    renderHome();
  };
  $('#set-limit').onclick = e => {
    const b = e.target.closest('[data-limit]');
    if (!b) return;
    Store.settings.newPerDay = Number(b.dataset.limit);
    $('#new-count').value = '';
    Store.save();
    renderSettings();
    renderHome();
  };
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

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if ((Store.settings.theme || 'system') === 'system') Theme.apply('system');
  });

  // 데스크톱 단축키
  document.addEventListener('keydown', e => {
    if (State.view !== 'study' || e.target.matches('input, select, textarea')) return;
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flipCard(); }
    if (e.key === '1') gradeCard('again');
    if (e.key === '2') gradeCard('hard');
    if (e.key === '3') gradeCard('good');
    if (e.key === 'ArrowLeft') prevCard();
    if (e.key === 'ArrowRight') skipCard();
  });
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
    for (const k of await caches.keys()) await caches.delete(k);
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
