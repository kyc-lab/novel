// 설정. 이 기기에만 저장한다(폰은 폰대로, PC는 PC대로 글자 크기를 다르게 쓸 수 있게).

const KEY = 'settings';

const DEFAULTS = {
  fontSize: 18, // 본문 글자 크기(px)
  lineHeight: 1.9, // 줄 간격
  bodyFont: 'serif', // 'serif' 명조 / 'sans' 고딕
  theme: 'dark', // 'dark' / 'light'
  accent: '#5EC4B6', // 포인트 색
  countBasis: 'with', // 'with' 공백 포함 / 'without' 공백 제외 / 'both' 둘 다
  countNewlines: false, // 줄바꿈을 글자수에 넣을지
  goal: 5500, // 회차 목표 글자수
  overlay: false, // 본문 위에 떠 있는 작은 글자수
  aiProvider: 'openai', // AI 담당: 'openai'(GPT) / 'gemini' / 'claude'
  aiModels: {}, // 회사별로 고른 모델 { openai: 'gpt-…' }. 비어 있으면 기본 모델
  checkItems: [], // 점검 항목(비어 있으면 기본 항목)
  hookAge: 10, // 이만큼 회차가 지나도 안 풀린 떡밥은 알림
  navOrder: [], // 폰 아래 바 순서(비어 있으면 기본)
  symbols: ['⋯', '⋯⋯', '……', '…', '「」', '『』', '―', '·', '~', '“”', '‘’', '♡', '★', '《》'], // 기호 바
  // 말줄임표 모양: 'mid' ⋯ / 'low' …  — 점 세 개를 치면 한 개, 바로 하나 더 치면 두 개(⋯⋯)가 된다.
  ellipsisStyle: 'mid',
  smartQuotes: true, // 곧은 따옴표(" ')를 치면 “” ‘’ 짝으로 넣고 커서를 가운데에
  // 자동 변환 규칙. 말줄임표 규칙은 바뀔 글자가 위의 "모양" 설정을 따른다.
  rules: [
    { id: 'ellipsis', from: '...', on: true },
    { id: 'dash', from: '--', to: '―', on: true },
  ],
};

// ⋯ 는 U+22EF(항상 가운데), … 는 U+2026(글꼴에 따라 가운데·아래로 다르게 보임)
export const ELLIPSIS = { mid: '⋯', low: '…' };
export const DEFAULT_SYMBOLS = DEFAULTS.symbols;

function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) ?? {};
  } catch {
    return {};
  }
}

let current = { ...DEFAULTS, ...read() };
if (!(current.ellipsisStyle in ELLIPSIS)) current.ellipsisStyle = 'low'; // 예전 "한 개" 선택 → 아래 점
const listeners = [];

export const get = () => current;
export const onChange = (fn) => listeners.push(fn);

export function update(patch) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch (err) {
    console.error(err);
  }
  // 기기끼리 공유하는 항목(자동 변환 규칙)을 이 기기에서 바꿨으면 "드라이브에 올릴 것 있음"으로 표시
  if (!applyingShared && SHARED_KEYS.some((k) => k in patch)) {
    writeSharedMeta({ at: Date.now(), dirty: true });
    sharedListeners.forEach((fn) => fn());
  }
  apply();
  listeners.forEach((fn) => fn(current));
}

// ───────── 기기끼리 공유하는 설정: 자동 변환 규칙 ─────────
// 나머지 설정(글자 크기·테마·기호 바 등)은 기기마다 따로다.

const SHARED_KEYS = ['rules', 'ellipsisStyle', 'smartQuotes'];
const SHARED_META = 'sharedSettingsMeta'; // { at: 마지막으로 바뀐 시각, dirty: 드라이브에 아직 안 올라감 }
const sharedListeners = [];
let applyingShared = false;

export const onSharedChange = (fn) => sharedListeners.push(fn);

function readSharedMeta() {
  try {
    return JSON.parse(localStorage.getItem(SHARED_META));
  } catch {
    return null;
  }
}
const writeSharedMeta = (meta) => localStorage.setItem(SHARED_META, JSON.stringify(meta));
const sharedIsDefault = () => SHARED_KEYS.every((k) => JSON.stringify(current[k]) === JSON.stringify(DEFAULTS[k]));

// 공유 항목의 지금 값. 이 기능이 생기기 전에 규칙을 고쳐 둔 기기는 시각을 1로 본다
// (한 번도 안 건드린 기기 0 보다는 새것, 기능이 생긴 뒤에 고친 것보다는 옛것).
export function getShared() {
  const meta = readSharedMeta();
  return {
    rules: current.rules,
    ellipsisStyle: current.ellipsisStyle,
    smartQuotes: current.smartQuotes,
    updatedAt: meta?.at ?? (sharedIsDefault() ? 0 : 1),
    dirty: meta?.dirty ?? !sharedIsDefault(),
  };
}

// 드라이브에서 받은(또는 합친) 값을 이 기기에 적용한다.
export function applyShared(data, { dirty = false } = {}) {
  const patch = {};
  if (Array.isArray(data.rules)) {
    // 기본 규칙 두 개(말줄임표·줄표)는 빠져 있어도 항상 있게 한다.
    const missing = DEFAULTS.rules.filter((d) => !data.rules.some((r) => r.id === d.id));
    patch.rules = [...missing, ...data.rules];
  }
  if (data.ellipsisStyle in ELLIPSIS) patch.ellipsisStyle = data.ellipsisStyle;
  if (typeof data.smartQuotes === 'boolean') patch.smartQuotes = data.smartQuotes;
  applyingShared = true;
  try {
    update(patch);
  } finally {
    applyingShared = false;
  }
  writeSharedMeta({ at: data.updatedAt ?? 0, dirty });
}

// 드라이브에 올렸다고 표시한다(올리는 사이에 또 바꿨으면 그대로 둔다).
export function markSharedUploaded(at) {
  if (getShared().updatedAt === at) writeSharedMeta({ at, dirty: false });
}

// 설정값을 화면에 입힌다.
export function apply() {
  const root = document.documentElement;
  root.dataset.theme = current.theme;
  root.style.setProperty('--body-size', current.fontSize + 'px');
  root.style.setProperty('--body-line', current.lineHeight);
  root.style.setProperty('--body-font', current.bodyFont === 'sans' ? 'var(--sans)' : 'var(--serif)');
  root.style.setProperty('--accent', current.accent);
  document.body.classList.toggle('show-overlay', current.overlay);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', current.theme === 'light' ? '#F6F5F1' : '#17181B');
}

apply();

// ───────── 설정 창 ─────────

export function initPanel({ dialog, openButton }) {
  const form = dialog.querySelector('form');

  function fill() {
    for (const input of form.elements) {
      const key = input.name;
      if (!key || !(key in current)) continue;
      if (input.type === 'radio') input.checked = input.value === String(current[key]);
      else if (input.type === 'checkbox') input.checked = current[key];
      else input.value = current[key];
    }
    showValues();
    renderRules();
    renderSymbols();
  }

  // ── 자동 변환 규칙 ──
  const ruleList = dialog.querySelector('#ruleList');
  const ruleFrom = dialog.querySelector('#ruleFrom');
  const ruleTo = dialog.querySelector('#ruleTo');
  const ruleMsg = dialog.querySelector('#ruleMsg');

  function renderRules() {
    ruleList.replaceChildren(
      ...current.rules.map((rule) => {
        const row = document.createElement('label');
        row.className = 'row';
        const text = document.createElement('span');
        const from = document.createElement('code');
        from.textContent = rule.from;
        const to = document.createElement('b');
        to.textContent = rule.id === 'ellipsis' ? ELLIPSIS[current.ellipsisStyle] : rule.to;
        text.append(from, ' → ', to);
        row.append(text);
        if (rule.id !== 'ellipsis' && rule.id !== 'dash') {
          const del = document.createElement('button');
          del.type = 'button';
          del.className = 'mini-btn danger';
          del.textContent = '삭제';
          del.dataset.delRule = rule.id;
          row.append(del);
        }
        const sw = document.createElement('input');
        sw.type = 'checkbox';
        sw.className = 'switch';
        sw.checked = rule.on;
        sw.dataset.rule = rule.id;
        sw.setAttribute('aria-label', `${rule.from} 변환 켜기`);
        row.append(sw);
        return row;
      }),
    );
  }

  ruleList.addEventListener('change', (e) => {
    const id = e.target.dataset.rule;
    if (!id) return;
    update({ rules: current.rules.map((r) => (r.id === id ? { ...r, on: e.target.checked } : r)) });
  });
  ruleList.addEventListener('click', (e) => {
    const id = e.target.dataset.delRule;
    if (!id) return;
    e.preventDefault();
    update({ rules: current.rules.filter((r) => r.id !== id) });
    renderRules();
  });

  function addRule() {
    const from = ruleFrom.value.trim();
    const to = ruleTo.value.trim();
    ruleMsg.textContent = '';
    if (!from || !to) return (ruleMsg.textContent = '입력할 글자와 바뀔 글자를 둘 다 적어줘.');
    if (from === to) return (ruleMsg.textContent = '입력과 바뀔 글자가 같아.');
    if (current.rules.some((r) => r.from === from)) return (ruleMsg.textContent = `"${from}" 규칙은 이미 있어.`);
    update({ rules: [...current.rules, { id: 'u' + Date.now().toString(36), from, to, on: true }] });
    ruleFrom.value = '';
    ruleTo.value = '';
    renderRules();
  }
  dialog.querySelector('#ruleAdd').addEventListener('click', addRule);

  // ── 기호 바 편집 ──
  const symList = dialog.querySelector('#symList');
  const symNew = dialog.querySelector('#symNew');
  let symSel = -1; // 고른 기호의 순번

  function renderSymbols() {
    if (symSel >= current.symbols.length) symSel = -1;
    symList.replaceChildren(
      ...current.symbols.map((sym, i) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip' + (i === symSel ? ' on' : '');
        chip.textContent = sym;
        chip.dataset.i = i;
        return chip;
      }),
    );
    dialog.querySelector('#symLeft').disabled = symSel <= 0;
    dialog.querySelector('#symRight').disabled = symSel < 0 || symSel >= current.symbols.length - 1;
    dialog.querySelector('#symDel').disabled = symSel < 0;
  }

  function moveSymbol(dir) {
    const to = symSel + dir;
    if (symSel < 0 || to < 0 || to >= current.symbols.length) return;
    const list = [...current.symbols];
    [list[symSel], list[to]] = [list[to], list[symSel]];
    symSel = to;
    update({ symbols: list });
    renderSymbols();
  }

  symList.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const i = Number(chip.dataset.i);
    symSel = symSel === i ? -1 : i;
    renderSymbols();
  });
  dialog.querySelector('#symLeft').addEventListener('click', () => moveSymbol(-1));
  dialog.querySelector('#symRight').addEventListener('click', () => moveSymbol(1));
  dialog.querySelector('#symDel').addEventListener('click', () => {
    if (symSel < 0) return;
    update({ symbols: current.symbols.filter((_, i) => i !== symSel) });
    symSel = -1;
    renderSymbols();
  });
  function addSymbol() {
    const sym = symNew.value.trim();
    if (!sym || current.symbols.includes(sym)) return;
    update({ symbols: [...current.symbols, sym] });
    symNew.value = '';
    symSel = current.symbols.length - 1;
    renderSymbols();
  }
  dialog.querySelector('#symAdd').addEventListener('click', addSymbol);
  dialog.querySelector('#symReset').addEventListener('click', () => {
    symSel = -1;
    update({ symbols: [...DEFAULT_SYMBOLS] });
    renderSymbols();
  });

  // 추가 칸에서 엔터 = 추가 버튼
  for (const [input, add] of [[ruleFrom, addRule], [ruleTo, addRule], [symNew, addSymbol]]) {
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      add();
    });
  }

  function showValues() {
    form.querySelector('[data-show="fontSize"]').textContent = current.fontSize + 'px';
    form.querySelector('[data-show="lineHeight"]').textContent = current.lineHeight.toFixed(1);
    for (const sw of form.querySelectorAll('.swatch')) {
      sw.classList.toggle('on', sw.dataset.color.toLowerCase() === current.accent.toLowerCase());
    }
    // 끝까지 간 쪽의 ‹ › 버튼은 흐리게
    for (const btn of form.querySelectorAll('.step')) {
      const range = form.elements[btn.dataset.step];
      const limit = Number(btn.dataset.dir) < 0 ? range.min : range.max;
      btn.disabled = current[btn.dataset.step] === Number(limit);
    }
  }

  form.addEventListener('input', (e) => {
    const input = e.target;
    const key = input.name;
    if (!key) return;
    let value;
    if (input.type === 'checkbox') value = input.checked;
    else if (input.type === 'range') value = Number(input.value);
    else if (input.type === 'number') {
      value = Math.round(Number(input.value));
      if (!(value >= 100)) return; // 입력 도중의 빈 값·너무 작은 값은 무시
    } else value = input.value;
    update({ [key]: value });
    showValues();
    if (key === 'ellipsisStyle') renderRules();
  });

  // ‹ › 버튼: 한 번 누를 때마다 한 칸씩
  form.addEventListener('click', (e) => {
    const btn = e.target.closest('.step');
    if (!btn) return;
    const key = btn.dataset.step;
    const range = form.elements[key];
    const step = Number(range.step);
    let value = current[key] + Number(btn.dataset.dir) * step;
    value = Math.min(Number(range.max), Math.max(Number(range.min), value));
    value = Math.round(value * 10) / 10; // 1.9 + 0.1 = 2.0000001 같은 찌꺼기 정리
    update({ [key]: value });
    fill();
  });

  form.addEventListener('click', (e) => {
    const sw = e.target.closest('.swatch');
    if (!sw) return;
    update({ accent: sw.dataset.color });
    fill();
  });

  form.addEventListener('submit', (e) => e.preventDefault());

  openButton.addEventListener('click', () => {
    fill();
    dialog.showModal();
  });
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  // 창 바깥(어두운 부분)을 누르면 닫기
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
}
