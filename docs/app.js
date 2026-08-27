'use strict';

/* ── 상수 ─────────────────────────────────────────── */

const STORAGE_KEY = 'toeic-voca-progress';
const BOX_INTERVALS = { 1: 1, 2: 2, 3: 4, 4: 7, 5: 15 };  // 박스 -> 며칠 뒤
const MAX_BOX = 5;
const LIST_PAGE = 80;
const AUDIO_DIR = 'audio/';

const DEFAULTS = {
  version: 1,
  settings: { direction: 'mixed', newPerDay: 20, onlyWithExample: false, autoplay: false, tier: 'all', theme: 'system', quizAffectsBox: false },
  words: {},
  days: {},
};

/* ── 유틸 ─────────────────────────────────────────── */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const todayISO = () => new Date().toLocaleDateString('sv-SE');  // YYYY-MM-DD (로컬)

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('sv-SE');
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

  play(file) {
    if (!file) return;
    if (!this.el) this.el = new Audio();
    this.el.src = AUDIO_DIR + encodeURIComponent(file);
    // 오프라인이거나 아직 안 받은 파일이면 조용히 넘어간다
    this.el.play().catch(() => {});
  },

  speakerHTML(file, cls = 'speak') {
    if (!file) return '';
    return `<button class="${cls}" data-audio="${escapeHTML(file)}" aria-label="발음 듣기">
      <svg viewBox="0 0 24 24" class="ico"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>
    </button>`;
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
          const res = await fetch(AUDIO_DIR + encodeURIComponent(f), { cache: 'force-cache' });
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

  load() {
    let migrated = false;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        this.data = {
          ...structuredClone(DEFAULTS),
          ...parsed,
          settings: { ...DEFAULTS.settings, ...(parsed.settings || {}) },
          words: parsed.words || {},
          days: parsed.days || {},
        };
      }
      if (typeof this.data.settings.dailyLimit === 'number') {
        // 예전에는 복습과 새 단어를 합쳐서 잘랐다. 이제 새 단어만 제한한다.
        this.data.settings.newPerDay = this.data.settings.dailyLimit;
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

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
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

  reset() {
    this.data = structuredClone(DEFAULTS);
    localStorage.removeItem(STORAGE_KEY);
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
    due.sort((a, b) => Store.record(a.id).due.localeCompare(Store.record(b.id).due));

    const cap = newCap ?? Store.settings.newPerDay;
    // 0은 '새 단어 없음', -1은 '제한 없음'. 예전에는 0이 무제한을 뜻했다.
    const taken = cap < 0 ? fresh : fresh.slice(0, Math.max(0, cap));
    return { due, fresh: taken, freshTotal: fresh.length };
  },

  session(opts = {}) {
    const { due, fresh } = this.split(opts);
    return [...shuffle(due), ...fresh];
  },

  counts() {
    const { due, fresh, freshTotal } = this.split();
    return { due: due.length, fresh: fresh.length, freshTotal };
  },

  grade(id, result) {
    const rec = Store.ensure(id);
    if (result === 'again') {
      rec.box = 1;
      rec.wrong++;
    } else if (result === 'hard') {
      rec.box = Math.max(1, rec.box);
      rec.correct++;
    } else {
      rec.box = Math.min(MAX_BOX, rec.box + 1);
      rec.correct++;
    }
    rec.lastSeen = todayISO();
    rec.due = addDays(todayISO(), BOX_INTERVALS[rec.box]);

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
  list: { day: null, tier: 'all', query: '', masked: false, shown: LIST_PAGE },
};

async function loadData() {
  const res = await fetch('words.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('words.json 로드 실패: ' + res.status);
  const json = await res.json();

  State.meta = json.meta;
  State.days = json.days;
  for (const day of json.days) {
    State.byDay.set(day.day, day.words);
    for (const w of day.words) {
      w.day = day.day;
      State.words.push(w);
      State.byId.set(w.id, w);
    }
  }
}

/* ── 표시 헬퍼 ────────────────────────────────────── */

/** 설정(등급, 예문 유무)에 맞는 단어만 남긴다. 학습·퀴즈·통계가 모두 이걸 쓴다. */
function inScope(words) {
  const { tier, onlyWithExample } = Store.settings;
  return words.filter(w =>
    (tier === 'all' || w.tier === tier) &&
    (!onlyWithExample || w.examples.length));
}

const TIER_LABEL = { core: '필수', bonus: '만점', extra: '추가' };

const meaningText = w => w.senses.map(s => s.meaning).join('; ');
const posText = w => w.senses.map(s => s.pos).filter(Boolean).join(' ');

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
  const scoped = inScope(State.words);
  const total = scoped.length;
  const seen = Object.keys(Store.data.words).length;
  const mastered = Object.values(Store.data.words).filter(r => r.box >= MAX_BOX).length;
  const { due, fresh, freshTotal } = Scheduler.counts();

  const notes = [];
  if (Store.settings.tier !== 'all') notes.push(TIER_LABEL[Store.settings.tier] + ' 어휘');
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

  $('#stat-seen').textContent = seen.toLocaleString();
  $('#stat-mastered').textContent = mastered.toLocaleString();
  $('#stat-total').textContent = total.toLocaleString();

  const boxes = [0, 0, 0, 0, 0];
  for (const r of Object.values(Store.data.words)) boxes[r.box - 1]++;
  $('#boxbar').innerHTML = boxes.map((n, i) =>
    `<div><b>${n}</b><span>박스 ${i + 1}</span></div>`).join('');

  $('#day-grid').innerHTML = State.days.map(d => {
    const words = inScope(d.words);
    if (!words.length) return '';
    const done = words.filter(w => Store.record(w.id)).length;
    const pct = Math.round(done / words.length * 100);
    return `<button class="day-cell${pct === 100 ? ' done' : ''}" data-day="${d.day}">
      <b>${String(d.day).padStart(2, '0')}</b>
      <span>${done}/${words.length}</span>
      <i class="bar" style="width:${pct}%"></i>
    </button>`;
  }).join('');
}

/* ── 학습 (플래시카드) ────────────────────────────── */

function startStudy(dayFilter = null) {
  const queue = Scheduler.session({ dayFilter });
  State.study = { queue, index: 0, graded: 0, dayFilter };
  navigate('study');
  renderStudy();
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
    $('#study-done-sub').textContent = s && s.graded
      ? `${s.graded}단어를 봤습니다`
      : '오늘 볼 단어가 없습니다. DAY를 직접 골라보세요.';
    $('#study-progress').style.width = '100%';
    $('#study-counter').textContent = s ? `${s.graded}/${s.queue.length}` : '0/0';
    return;
  }

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
  if (dir === 'en2ko' && Store.settings.autoplay) Audio_.play(w.audio);

  $('#study-counter').textContent = `${s.index + 1}/${s.queue.length}`;
  $('#study-progress').style.width = (s.index / s.queue.length * 100) + '%';
}

function flipCard() {
  const s = State.study;
  if (!s || s.index >= s.queue.length) return;
  $('#flashcard').classList.add('flipped');
  $('#grade-bar').hidden = false;
  const w = s.queue[s.index];
  if (Store.settings.autoplay && directionFor(w.id) === 'ko2en') Audio_.play(w.audio);
}

function gradeCard(result) {
  const s = State.study;
  if (!s || s.index >= s.queue.length) return;
  if (!$('#flashcard').classList.contains('flipped')) return;

  Scheduler.grade(s.queue[s.index].id, result);
  s.graded++;
  s.index++;
  renderStudy();
}

/* ── 목록 ─────────────────────────────────────────── */

function renderListTier() {
  for (const b of $$('#list-tier button')) b.classList.toggle('on', b.dataset.tier === State.list.tier);
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
  const { day, tier, query } = State.list;
  const q = query.trim().toLowerCase();
  let pool = day === null ? State.words : (State.byDay.get(day) || []);
  if (tier !== 'all') pool = pool.filter(w => w.tier === tier);
  if (!q) return pool;
  return pool.filter(w =>
    w.headword.toLowerCase().includes(q) ||
    meaningText(w).toLowerCase().includes(q) ||
    w.examples.some(e => e.en.toLowerCase().includes(q)));
}

function renderList() {
  const words = filteredWords();
  const shown = words.slice(0, State.list.shown);

  const withEx = words.filter(w => w.examples.length).length;
  $('#list-count').textContent =
    `${words.length.toLocaleString()}단어 · 예문 ${withEx.toLocaleString()}` +
    (words.length > shown.length ? ` · ${shown.length}개 표시 중` : '');

  const wrap = $('#word-list');
  wrap.classList.toggle('masked', State.list.masked);
  wrap.innerHTML = shown.map(w => {
    const rec = Store.record(w.id);
    const ex = w.examples[0];
    return `<div class="word-item">
      <div class="row">
        <span class="hw">${escapeHTML(w.headword)}</span>
        ${posText(w) ? `<span class="pos">${escapeHTML(posText(w))}</span>` : ''}
        <span class="tier" style="margin-left:auto">${TIER_LABEL[w.tier] || '기타'}</span>
        ${rec ? `<span class="box">박스 ${rec.box}</span>` : ''}
        ${w.audio ? Audio_.speakerHTML(w.audio) : ''}
      </div>
      <div class="mean">${escapeHTML(meaningText(w))}</div>
      ${ex ? `<div class="ex">${escapeHTML(ex.en)}${ex.generated ? '<span class="gen">생성</span>' : ''}${
        ex.ko ? `<div class="ko">${escapeHTML(ex.ko)}</div>` : ''}</div>` : ''}
    </div>`;
  }).join('') || '<p class="muted">검색 결과가 없습니다.</p>';

  if (words.length > shown.length) {
    const more = document.createElement('button');
    more.className = 'btn btn-outline btn-block';
    more.textContent = '더 보기';
    more.onclick = () => { State.list.shown += LIST_PAGE; renderList(); };
    wrap.appendChild(more);
  }
}

/* ── 퀴즈 ─────────────────────────────────────────── */

function quizPool() {
  const scope = $('#quiz-scope button.on').dataset.scope;
  if (scope === 'due') return Scheduler.session();
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
  const where = scope === 'day' ? `DAY ${String(State.quizDay).padStart(2, '0')}의 ` : '';
  $('#quiz-avail').textContent = n < 4
    ? `출제할 단어가 ${n}개뿐입니다. 사지선다라 4개 이상 필요합니다.`
    : `${where}${n.toLocaleString()}단어에서 출제합니다.`;
  $('#quiz-start').disabled = n < 4;
}

function buildQuestion(word, pool) {
  const dir = directionFor(word.id);
  const answer = dir === 'en2ko' ? meaningText(word) : word.headword;

  const sameDay = (State.byDay.get(word.day) || []).filter(w => w.id !== word.id);
  const others = shuffle(sameDay.length >= 3 ? sameDay : pool.filter(w => w.id !== word.id));

  const seen = new Set([answer]);
  const distractors = [];
  for (const w of others) {
    const t = dir === 'en2ko' ? meaningText(w) : w.headword;
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

function startQuiz() {
  const pool = quizPool();
  const len = Number($('#quiz-length button.on').dataset.len);
  const picked = shuffle(pool).slice(0, len > 0 ? len : pool.length);

  State.quiz = {
    questions: picked.map(w => buildQuestion(w, pool)),
    index: 0, correct: 0, wrong: [],
  };
  $('#quiz-setup').hidden = true;
  $('#quiz-result').hidden = true;
  $('#quiz-run').hidden = false;
  renderQuiz();
}

function renderQuiz() {
  const q = State.quiz;
  const cur = q.questions[q.index];

  $('#quiz-counter').textContent = `${q.index + 1}/${q.questions.length}`;
  $('#quiz-progress').style.width = (q.index / q.questions.length * 100) + '%';
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
  $('#quiz-next').textContent = q.index + 1 >= q.questions.length ? '결과 보기' : '다음';
}

function nextQuiz() {
  const q = State.quiz;
  q.index++;
  if (q.index >= q.questions.length) return finishQuiz();
  renderQuiz();
}

function finishQuiz() {
  const q = State.quiz;
  const pct = Math.round(q.correct / q.questions.length * 100);
  $('#quiz-run').hidden = true;
  $('#quiz-result').hidden = false;
  $('#quiz-score').textContent = pct;
  $('#quiz-score-sub').textContent = `${q.questions.length}문항 중 ${q.correct}개 정답` +
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

function renderSettings() {
  const { direction, newPerDay, onlyWithExample } = Store.settings;
  for (const b of $$('#set-direction button')) b.classList.toggle('on', b.dataset.dir === direction);
  for (const b of $$('#set-limit button')) b.classList.toggle('on', Number(b.dataset.limit) === newPerDay);
  for (const b of $$('#set-scope button'))
    b.classList.toggle('on', (b.dataset.scope === 'example') === onlyWithExample);

  for (const b of $$('#set-quizgrade button'))
    b.classList.toggle('on', (b.dataset.quizgrade === 'on') === !!Store.settings.quizAffectsBox);
  for (const b of $$('#set-theme button'))
    b.classList.toggle('on', b.dataset.themeOpt === (Store.settings.theme || 'system'));
  for (const b of $$('#set-tier button'))
    b.classList.toggle('on', b.dataset.tier === Store.settings.tier);
  const counts = { core: 0, bonus: 0, extra: 0 };
  for (const w of State.words) if (counts[w.tier] !== undefined) counts[w.tier]++;
  $('#tier-hint').textContent =
    `필수 ${counts.core.toLocaleString()} → 만점 ${counts.bonus.toLocaleString()} → ` +
    `추가 ${counts.extra.toLocaleString()} 순서로 끝내면 됩니다. ` +
    '추가 등급은 다른 단어장에서 가져온 것이라 발음이 없습니다.';
  for (const b of $$('#set-autoplay button'))
    b.classList.toggle('on', (b.dataset.autoplay === 'on') === Store.settings.autoplay);
  $('#audio-hint').textContent =
    `${(State.meta.withAudio || 0).toLocaleString()}단어에 발음이 있습니다. ` +
    '들은 발음은 자동으로 저장되고, 내려받아 두면 오프라인에서도 들립니다.';

  const { freshTotal } = Scheduler.counts();
  if (newPerDay < 0) {
    $('#limit-hint').textContent =
      `남은 새 단어 ${freshTotal.toLocaleString()}개를 한 번에 전부 꺼냅니다. ` +
      '며칠 뒤 복습이 그만큼 몰리니 시험이 코앞일 때만 쓰세요.';
  } else if (newPerDay === 0) {
    $('#limit-hint').textContent = '새 단어를 꺼내지 않고 이미 배운 것만 복습합니다.';
  } else {
    const days = Math.ceil(freshTotal / newPerDay);
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

  const bytes = new Blob([localStorage.getItem(STORAGE_KEY) || '']).size;
  $('#info').innerHTML = `
    <div><dt>출처</dt><dd><a href="${escapeHTML(State.meta.sourceUrl)}" target="_blank" rel="noopener">네이버 블로그</a></dd></div>
    <div><dt>수집일</dt><dd>${escapeHTML(State.meta.crawledAt)}</dd></div>
    <div><dt>예문 보유</dt><dd>${State.meta.withExample.toLocaleString()} / ${State.meta.wordCount.toLocaleString()}</dd></div>
    ${State.meta.generatedExamples ? `<div><dt>생성한 예문</dt><dd>${State.meta.generatedExamples.toLocaleString()}</dd></div>` : ''}
    <div><dt>필수 / 만점 / 추가</dt><dd>${(State.meta.coreCount || 0).toLocaleString()} / ${(State.meta.wordCount - (State.meta.coreCount || 0) - (State.meta.extraCount || 0)).toLocaleString()} / ${(State.meta.extraCount || 0).toLocaleString()}</dd></div>
    <div><dt>발음 보유</dt><dd>${(State.meta.withAudio || 0).toLocaleString()} / ${State.meta.wordCount.toLocaleString()}</dd></div>
    <div><dt>단어 수</dt><dd>${State.meta.wordCount.toLocaleString()}</dd></div>
    <div><dt>진도 용량</dt><dd>${(bytes / 1024).toFixed(1)} KB</dd></div>`;
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
      const parsed = JSON.parse(reader.result);
      if (!parsed || typeof parsed.words !== 'object') throw new Error('형식이 올바르지 않습니다');
      Store.data = {
        ...structuredClone(DEFAULTS),
        ...parsed,
        settings: { ...DEFAULTS.settings, ...(parsed.settings || {}) },
      };
      Store.save();
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

function bind() {
  // 발음 버튼은 카드 안에 있다. 캡처 단계에서 잡아야 뒤집기보다 먼저 처리된다.
  document.addEventListener('click', e => {
    const speak = e.target.closest('[data-audio]');
    if (!speak) return;
    e.stopPropagation();
    e.preventDefault();
    Audio_.play(speak.dataset.audio);
  }, true);

  document.addEventListener('click', e => {
    const nav = e.target.closest('[data-nav]');
    if (nav) return navigate(nav.dataset.nav);

    const dayCell = e.target.closest('.day-cell');
    if (dayCell) return startStudy(Number(dayCell.dataset.day));

    const chip = e.target.closest('[data-chip]');
    if (chip) {
      State.list.day = chip.dataset.chip === 'all' ? null : Number(chip.dataset.chip);
      State.list.shown = LIST_PAGE;
      renderDayChips();
      return renderList();
    }
  });

  $('#start-review').onclick = () => startStudy();
  $('#flashcard').onclick = flipCard;
  $('#study-exit').onclick = () => { State.study = null; navigate('home'); };
  $('#grade-bar').onclick = e => {
    const b = e.target.closest('[data-grade]');
    if (b) gradeCard(b.dataset.grade);
  };

  $('#search').addEventListener('input', e => {
    State.list.query = e.target.value;
    State.list.shown = LIST_PAGE;
    renderList();
  });
  $('#toggle-mask').onclick = e => {
    State.list.masked = !State.list.masked;
    e.currentTarget.setAttribute('aria-pressed', String(State.list.masked));
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
    if (b) for (const x of $$('#quiz-length button')) x.classList.toggle('on', x === b);
  };
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
    Store.settings.tier = b.dataset.tier;
    Store.save();
    State.study = null;
    renderSettings();
    renderHome();
  };
  $('#list-tier').onclick = e => {
    const b = e.target.closest('[data-tier]');
    if (!b) return;
    State.list.tier = b.dataset.tier;
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
    Store.save();
    State.study = null;
    renderSettings();
    renderHome();
  };
  $('#set-limit').onclick = e => {
    const b = e.target.closest('[data-limit]');
    if (!b) return;
    Store.settings.newPerDay = Number(b.dataset.limit);
    Store.save();
    renderSettings();
    renderHome();
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
  });
}

/* ── 시작 ─────────────────────────────────────────── */

(async function init() {
  try {
    Store.load();
    Theme.apply(Store.settings.theme);
    await loadData();
    Store.prune(new Set(State.byId.keys()));
    bind();
    $('#loading').hidden = true;
    $('#app').hidden = false;
    navigate('home');

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW 등록 실패', e));
    }
  } catch (e) {
    $('#loading').innerHTML =
      `<p class="muted" style="padding:2rem;text-align:center">데이터를 불러오지 못했습니다.<br>${escapeHTML(e.message)}</p>`;
    console.error(e);
  }
})();
