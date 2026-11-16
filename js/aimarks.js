// 본문에 넣은 AI 문장을 보라색 밑줄로 표시한다. 작가가 그 부분을 고치면 밑줄이 사라진다.
// 원고 칸(textarea)은 글자 일부에 꾸밈을 못 넣어서, 바로 뒤에 같은 글을 투명하게 깔고 밑줄만 보이게 한다.
// 표시할 구간은 회차의 ch.aiMarks = [[시작, 끝], …] 에 저장한다.

let editor;
let mirror;
let getChapter;
let prev = '';
let raf = 0;

const marksOf = () => getChapter()?.aiMarks ?? [];

function render() {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => {
    const marks = marksOf();
    if (!marks.length) {
      mirror.hidden = true;
      mirror.replaceChildren();
      return;
    }
    const text = editor.value;
    const parts = [];
    let at = 0;
    for (const [a, b] of [...marks].sort((x, y) => x[0] - y[0])) {
      if (a > at) parts.push(text.slice(at, a));
      const m = document.createElement('mark');
      m.textContent = text.slice(Math.max(a, at), b);
      parts.push(m);
      at = Math.max(at, b);
    }
    parts.push(text.slice(at) + '\n');
    mirror.replaceChildren(...parts);
    mirror.hidden = false;
    mirror.scrollTop = editor.scrollTop;
  });
}

// 글이 바뀌면: 바뀐 곳보다 뒤에 있는 구간은 밀어 주고, 바뀐 곳과 겹치는 구간(작가가 고친 AI 문장)은 지운다.
function onInput() {
  const ch = getChapter();
  const now = editor.value;
  const marks = ch?.aiMarks;
  if (marks?.length) {
    let p = 0;
    const max = Math.min(prev.length, now.length);
    while (p < max && prev[p] === now[p]) p++;
    let s = 0;
    while (s < max - p && prev[prev.length - 1 - s] === now[now.length - 1 - s]) s++;
    const oldEnd = prev.length - s; // 예전 글에서 바뀐 구간 [p, oldEnd)
    const delta = now.length - prev.length;
    const next = [];
    for (const [a, b] of marks) {
      if (oldEnd <= a) next.push([a + delta, b + delta]); // 구간보다 앞에서 바뀜(바로 앞에 끼워 넣은 것 포함) → 밀어 줌
      else if (p >= b) next.push([a, b]); // 구간보다 뒤에서 바뀜 → 그대로
      // 그 밖(겹침) = 작가가 고친 것 → 표시 없앰
    }
    ch.aiMarks = next;
  }
  prev = now;
  render();
}

export function init({ editor: ed, mirror: mi, getChapter: gc }) {
  editor = ed;
  mirror = mi;
  getChapter = gc;
  editor.addEventListener('input', onInput);
  editor.addEventListener('scroll', () => (mirror.scrollTop = editor.scrollTop), { passive: true });
  new ResizeObserver(render).observe(editor);
}

// 회차를 새로 열었거나, 본문을 통째로 바꿨을 때
export function reset({ clear = false } = {}) {
  const ch = getChapter();
  if (clear && ch) ch.aiMarks = [];
  prev = editor.value;
  render();
}

// 방금 [start, end) 에 넣은 글을 AI 문장으로 표시
export function add(start, end) {
  const ch = getChapter();
  if (!ch || end <= start) return;
  ch.aiMarks = [...(ch.aiMarks ?? []), [start, end]];
  prev = editor.value;
  render();
}
