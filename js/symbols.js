// 기호 바(누르면 커서 자리에 기호 삽입)와 자동 변환("..." → 말줄임표 등).

import * as settings from './settings.js';

// 짝 기호: 여는 것 → 닫는 것. 이런 기호는 넣은 뒤 커서를 가운데에 둔다.
const PAIRS = {
  '「': '」', '『': '』', '“': '”', '‘': '’', '《': '》', '〈': '〉',
  '(': ')', '[': ']', '【': '】', '"': '"', "'": "'",
};

function splitPair(sym) {
  const chars = [...sym];
  return chars.length === 2 && PAIRS[chars[0]] === chars[1] ? chars : null;
}

let editor;
let applying = false; // 우리가 직접 글자를 바꾸는 중(이때 생기는 입력 신호는 무시)
let lastConv = null; // 방금 한 자동 변환 — 바로 백스페이스 누르면 되돌리기 위해 기억

// start~end 구간을 text로 바꾼다. Ctrl+Z(실행 취소)가 살아 있도록 브라우저 편집 명령을 쓴다.
function replaceRange(start, end, text) {
  editor.focus();
  editor.setSelectionRange(start, end);
  applying = true;
  let ok = false;
  try {
    ok = document.execCommand('insertText', false, text);
  } catch {
    ok = false;
  }
  if (!ok) {
    editor.setRangeText(text, start, end, 'end');
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  }
  applying = false;
}

function insertSymbol(sym) {
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const pair = splitPair(sym);
  lastConv = null;
  if (pair) {
    // 글자를 골라 둔 상태면 그 글자를 감싼다.
    const inner = editor.value.slice(start, end);
    replaceRange(start, end, pair[0] + inner + pair[1]);
    const pos = start + pair[0].length + inner.length;
    editor.setSelectionRange(pos, pos);
  } else {
    replaceRange(start, end, sym);
  }
}

// 켜져 있는 변환 규칙. 긴 입력부터 맞춰 본다.
function activeRules() {
  const s = settings.get();
  return s.rules
    .filter((r) => r.on)
    .map((r) => ({
      from: r.from,
      to: r.id === 'ellipsis' ? settings.ELLIPSIS[s.ellipsisStyle] : r.to,
      ellipsis: r.id === 'ellipsis',
    }))
    .filter((r) => r.from && r.to)
    .sort((a, b) => b.from.length - a.from.length);
}

function onInput(e) {
  if (applying) return;
  const prevConv = lastConv;
  lastConv = null;
  if (e.isComposing) return; // 한글 조합 중에는 건드리지 않는다
  const type = e.inputType ?? '';
  if (type.startsWith('delete') || type.startsWith('history')) return;
  if (type === 'insertFromPaste' || type === 'insertFromDrop') return;
  if (editor.selectionStart !== editor.selectionEnd) return;

  const pos = editor.selectionStart;
  const before = editor.value.slice(Math.max(0, pos - 30), pos);

  // 말줄임표 늘리기: 점 세 개가 ⋯ 로 바뀐 바로 다음에 점을 하나 더 치면 ⋯⋯ (점 여섯 개)
  if (prevConv?.ellipsis && pos === prevConv.cursor + 1) {
    const unit = prevConv.to;
    if (editor.value.slice(prevConv.start, pos) === unit + '.') {
      replaceRange(prevConv.start, pos, unit + unit);
      // 여기서 백스페이스를 누르면 한 단계 전(⋯.)으로
      lastConv = { start: prevConv.start, to: unit + unit, cursor: prevConv.start + 2, from: unit + '.' };
      return;
    }
  }

  for (const rule of activeRules()) {
    if (!before.endsWith(rule.from)) continue;
    const start = pos - rule.from.length;
    replaceRange(start, pos, rule.to);
    lastConv = { start, to: rule.to, cursor: start + rule.to.length, from: rule.from, ellipsis: rule.ellipsis };
    return;
  }

  // 따옴표 자동 짝: 키보드의 곧은 따옴표(" ')를 치면
  //  - 앞이 비었거나 띄어쓰기·줄바꿈·여는 괄호 → “” 를 한 번에 넣고 커서를 가운데에
  //  - 커서 바로 뒤에 닫는 따옴표가 이미 있음 → 새로 넣지 않고 그 뒤로 넘어감
  //  - 그 밖(글자 바로 뒤) → 닫는 따옴표만
  if (!settings.get().smartQuotes) return;
  const ch = before.at(-1);
  if (ch !== '"' && ch !== "'") return;
  const [openQ, closeQ] = ch === '"' ? ['“', '”'] : ['‘', '’'];
  const start = pos - 1;

  if (editor.value[pos] === closeQ) {
    replaceRange(start, pos + 1, closeQ);
    return;
  }
  const prev = before.at(-2);
  if (prev === undefined || /[\s([{「『“‘《〈―—]/.test(prev)) {
    replaceRange(start, pos, openQ + closeQ);
    editor.setSelectionRange(pos, pos);
    lastConv = { start, to: openQ + closeQ, cursor: pos, from: ch };
  } else {
    replaceRange(start, pos, closeQ);
    lastConv = { start, to: closeQ, cursor: pos, from: ch };
  }
}

// 변환 직후 백스페이스 한 번 → 원래 입력으로.
function onBeforeInput(e) {
  if (e.inputType !== 'deleteContentBackward' || !lastConv) return;
  const conv = lastConv;
  lastConv = null;
  const pos = editor.selectionStart;
  if (pos !== editor.selectionEnd || pos !== conv.cursor) return;
  const end = conv.start + conv.to.length;
  if (editor.value.slice(conv.start, end) !== conv.to) return;
  e.preventDefault();
  replaceRange(conv.start, end, conv.from);
}

export function init({ editor: editorEl, bar }) {
  editor = editorEl;

  let shown = null;
  function render() {
    const symbols = settings.get().symbols;
    if (shown === symbols) return;
    shown = symbols;
    bar.replaceChildren(
      ...symbols.map((sym) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = sym;
        btn.dataset.sym = sym;
        return btn;
      }),
    );
    bar.hidden = symbols.length === 0;
  }
  render();
  settings.onChange(render);

  // 버튼을 눌러도 원고의 커서(와 폰 키보드)가 사라지지 않게
  bar.addEventListener('mousedown', (e) => e.preventDefault());
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn) insertSymbol(btn.dataset.sym);
  });

  editor.addEventListener('input', onInput);
  editor.addEventListener('beforeinput', onBeforeInput);
}
