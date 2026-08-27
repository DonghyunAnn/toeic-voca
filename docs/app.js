'use strict';

/* ── 상수 ─────────────────────────────────────────── */

const STORAGE_KEY = 'toeic-voca-progress';
const BOX_INTERVALS = { 1: 1, 2: 2, 3: 4, 4: 7, 5: 15 };  // 박스 -> 며칠 뒤
const MAX_BOX = 5;
const LIST_PAGE = 80;

const DEFAULTS = {
  version: 1,
  settings: { direction: 'mixed', dailyLimit: 20, onlyWithExample: false },
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

/* ── 저장소 ───────────────────────────────────────── */

const Store = {
  data: structuredClone(DEFAULTS),

  load() {
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
    } catch (e) {
      console.warn('진도를 읽지 못했습니다. 새로 시작합니다.', e);
    }
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
  /** 오늘 복습 대상: 기한이 된 단어 + 아직 안 본 단어를 하루 분량까지. */
  session({ dayFilter = null, limit = null } = {}) {
    const today = todayISO();
    let pool = dayFilter ? (State.byDay.get(dayFilter) || []) : State.words;
    if (Store.settings.onlyWithExample) pool = pool.filter(w => w.examples.length);
    const due = [], fresh = [];

    for (const w of pool) {
      const rec = Store.record(w.id);
      if (!rec) fresh.push(w);
      else if (rec.due <= today) due.push(w);
    }
    due.sort((a, b) => (Store.record(a.id).due).localeCompare(Store.record(b.id).due));

    const cap = limit ?? Store.settings.dailyLimit;
    const picked = [...shuffle(due), ...fresh];
    return cap > 0 ? picked.slice(0, cap) : picked;
  },

  dueCount() {
    const today = todayISO();
    const pool = Store.settings.onlyWithExample
      ? State.words.filter(w => w.examples.length) : State.words;
    let n = 0;
    for (const w of pool) {
      const rec = Store.record(w.id);
      if (rec && rec.due <= today) n++;
    }
    return n;
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
  list: { day: null, query: '', masked: false, shown: LIST_PAGE },
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
      <div class="en">${escapeHTML(e.en)}</div>
      ${e.ko ? `<div class="ko">${escapeHTML(e.ko)}</div>` : ''}
    </div>`).join('');

  const colloc = w.collocations.length ? `
    <div class="colloc">${w.collocations.map(c =>
      `<span><b>${escapeHTML(c.en)}</b>${c.ko ? ' ' + escapeHTML(c.ko) : ''}</span>`).join('')}
    </div>` : '';

  return `
    <div class="head"><h3>${escapeHTML(w.headword)}</h3></div>
    ${sensesHTML(w)}
    ${examples || colloc ? '<div class="divider"></div>' : ''}
    ${examples}${colloc}`;
}

/* ── 홈 ───────────────────────────────────────────── */

function renderHome() {
  const scoped = Store.settings.onlyWithExample
    ? State.words.filter(w => w.examples.length) : State.words;
  const total = scoped.length;
  const seen = Object.keys(Store.data.words).length;
  const mastered = Object.values(Store.data.words).filter(r => r.box >= MAX_BOX).length;
  const due = Scheduler.dueCount();
  const fresh = Math.max(0, total - seen);

  $('#home-sub').textContent =
    `${State.meta.dayCount}일 · ${total.toLocaleString()}단어` +
    (Store.settings.onlyWithExample ? ' (예문 있는 것만)' : ` · 예문 ${State.meta.withExample.toLocaleString()}개`);

  $('#due-count').textContent = due || Math.min(fresh, Store.settings.dailyLimit);
  $('#due-label').textContent = due
    ? '오늘 복습할 단어'
    : (fresh ? '새로 배울 단어' : '오늘 할 학습이 없습니다');
  $('#start-review').disabled = !(due || fresh);

  $('#stat-seen').textContent = seen.toLocaleString();
  $('#stat-mastered').textContent = mastered.toLocaleString();
  $('#stat-total').textContent = total.toLocaleString();

  const boxes = [0, 0, 0, 0, 0];
  for (const r of Object.values(Store.data.words)) boxes[r.box - 1]++;
  $('#boxbar').innerHTML = boxes.map((n, i) =>
    `<div><b>${n}</b><span>박스 ${i + 1}</span></div>`).join('');

  $('#day-grid').innerHTML = State.days.map(d => {
    const words = Store.settings.onlyWithExample
      ? d.words.filter(w => w.examples.length) : d.words;
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
      ? `${s.graded}단어를 학습했습니다`
      : '복습할 단어가 없습니다. 새 DAY를 골라보세요.';
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

  $('#study-counter').textContent = `${s.index + 1}/${s.queue.length}`;
  $('#study-progress').style.width = (s.index / s.queue.length * 100) + '%';
}

function flipCard() {
  const s = State.study;
  if (!s || s.index >= s.queue.length) return;
  $('#flashcard').classList.add('flipped');
  $('#grade-bar').hidden = false;
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

function renderDayChips() {
  const cur = State.list.day;
  $('#day-chips').innerHTML =
    `<button data-chip="all"${cur === null ? ' class="on"' : ''}>전체</button>` +
    State.days.map(d =>
      `<button data-chip="${d.day}"${cur === d.day ? ' class="on"' : ''}>DAY ${String(d.day).padStart(2, '0')}</button>`
    ).join('');
}

function filteredWords() {
  const { day, query } = State.list;
  const q = query.trim().toLowerCase();
  let pool = day === null ? State.words : (State.byDay.get(day) || []);
  if (!q) return pool;
  return pool.filter(w =>
    w.headword.toLowerCase().includes(q) ||
    meaningText(w).toLowerCase().includes(q) ||
    w.examples.some(e => e.en.toLowerCase().includes(q)));
}

function renderList() {
  const words = filteredWords();
  const shown = words.slice(0, State.list.shown);

  $('#list-count').textContent =
    `${words.length.toLocaleString()}단어` +
    (words.length > shown.length ? ` 중 ${shown.length}개 표시` : '');

  const wrap = $('#word-list');
  wrap.classList.toggle('masked', State.list.masked);
  wrap.innerHTML = shown.map(w => {
    const rec = Store.record(w.id);
    const ex = w.examples[0];
    return `<div class="word-item">
      <div class="row">
        <span class="hw">${escapeHTML(w.headword)}</span>
        ${posText(w) ? `<span class="pos">${escapeHTML(posText(w))}</span>` : ''}
        ${rec ? `<span class="box">박스 ${rec.box}</span>` : ''}
      </div>
      <div class="mean">${escapeHTML(meaningText(w))}</div>
      ${ex ? `<div class="ex">${escapeHTML(ex.en)}${
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
  if (scope === 'due') return Scheduler.session({ limit: 0 });
  const only = Store.settings.onlyWithExample;
  const trim = ws => only ? ws.filter(w => w.examples.length) : ws;
  if (scope === 'day') return trim(State.byDay.get(Number($('#quiz-day').value)) || []);
  return trim(State.words);
}

function renderQuizSetup() {
  const sel = $('#quiz-day');
  if (!sel.options.length) {
    sel.innerHTML = State.days.map(d =>
      `<option value="${d.day}">DAY ${String(d.day).padStart(2, '0')} — ${escapeHTML(d.title)}</option>`).join('');
  }
  const scope = $('#quiz-scope button.on').dataset.scope;
  sel.hidden = scope !== 'day';

  const n = quizPool().length;
  $('#quiz-avail').textContent = `출제 가능 ${n.toLocaleString()}단어`;
  $('#quiz-start').disabled = n < 4;
  if (n < 4 && n > 0) $('#quiz-avail').textContent += ' — 4단어 이상 필요합니다';
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
  Scheduler.grade(cur.id, ok ? 'good' : 'again');

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
  $('#quiz-score-sub').textContent = `${q.questions.length}문항 중 ${q.correct}개 정답`;

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
  const { direction, dailyLimit, onlyWithExample } = Store.settings;
  for (const b of $$('#set-direction button')) b.classList.toggle('on', b.dataset.dir === direction);
  for (const b of $$('#set-limit button')) b.classList.toggle('on', Number(b.dataset.limit) === dailyLimit);
  for (const b of $$('#set-scope button'))
    b.classList.toggle('on', (b.dataset.scope === 'example') === onlyWithExample);

  const withEx = State.meta.withExample;
  $('#scope-hint').textContent = onlyWithExample
    ? `예문이 있는 ${withEx.toLocaleString()}단어만 출제합니다.`
    : `전체 ${State.meta.wordCount.toLocaleString()}단어 중 ${withEx.toLocaleString()}개에 예문이 있습니다.`;

  const bytes = new Blob([localStorage.getItem(STORAGE_KEY) || '']).size;
  $('#info').innerHTML = `
    <div><dt>출처</dt><dd><a href="${escapeHTML(State.meta.sourceUrl)}" target="_blank" rel="noopener">네이버 블로그</a></dd></div>
    <div><dt>수집일</dt><dd>${escapeHTML(State.meta.crawledAt)}</dd></div>
    <div><dt>예문 보유</dt><dd>${State.meta.withExample.toLocaleString()} / ${State.meta.wordCount.toLocaleString()}</dd></div>
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
  if (view === 'list') { renderDayChips(); renderList(); }
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
  $('#quiz-day').onchange = renderQuizSetup;
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
    Store.settings.dailyLimit = Number(b.dataset.limit);
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
