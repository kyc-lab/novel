// 되돌리기 기록(회차별 이전 버전)과, 충돌 났을 때 두 버전을 나란히 보여주는 창.
// 기록은 이 기기에만 저장한다(드라이브에는 안 올림). 회차마다 최근 50개까지.

import * as db from './db.js';

const MAX_PER_CHAPTER = 50;
const uid = () => crypto.randomUUID();
const $ = (sel) => document.querySelector(sel);

const fmtTime = (ts) =>
  new Date(ts).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

// ───────── 기록 남기기 ─────────

export async function add(ch, reason) {
  if (!ch || (!ch.body && !ch.title)) return;
  const list = (await db.getHistoryOf(ch.id)).sort((a, b) => b.at - a.at);
  // 바로 앞 기록과 내용이 같으면 또 남기지 않는다.
  if (list[0] && list[0].body === ch.body && list[0].title === ch.title) return;
  await db.put('history', {
    id: uid(),
    chapterId: ch.id,
    workId: ch.workId,
    title: ch.title,
    body: ch.body,
    at: Date.now(),
    reason,
  });
  for (const old of list.slice(MAX_PER_CHAPTER - 1)) await db.del('history', old.id);
}

export const listOf = async (chapterId) => (await db.getHistoryOf(chapterId)).sort((a, b) => b.at - a.at);

// ───────── 되돌리기 기록 창 ─────────

const histDlg = $('#historyDlg');
const histList = $('#histList');
const histInfo = $('#histInfo');
const histText = $('#histText');
const histRestore = $('#histRestore');
let histCtx = null; // { items, selected, count, onRestore }

function selectHistory(i) {
  histCtx.selected = i;
  const item = histCtx.items[i];
  for (const li of histList.children) li.classList.toggle('on', Number(li.dataset.i) === i);
  histInfo.textContent = `${fmtTime(item.at)} · ${item.reason} · ${histCtx.count(item.body)}자${item.title ? ` · 제목 「${item.title}」` : ''}`;
  histText.textContent = item.body;
  histText.scrollTop = 0;
  histRestore.disabled = false;
}

// chapter: 지금 회차, count: 글자수 세는 함수, onRestore(기록): 되돌리기를 눌렀을 때
export async function open({ chapter, count, onRestore }) {
  const items = await listOf(chapter.id);
  histCtx = { items, selected: -1, count, onRestore };
  histList.replaceChildren(
    ...items.map((item, i) => {
      const li = document.createElement('li');
      li.dataset.i = i;
      const btn = document.createElement('button');
      btn.type = 'button';
      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = fmtTime(item.at);
      const why = document.createElement('span');
      why.className = 'why';
      why.textContent = `${item.reason} · ${count(item.body)}자`;
      btn.append(when, why);
      li.append(btn);
      return li;
    }),
  );
  histText.textContent = '';
  histRestore.disabled = true;
  histInfo.textContent = items.length
    ? '왼쪽에서 버전을 고르면 내용이 보여.'
    : '아직 기록이 없어. 글을 쓰다 보면 10분마다, 그리고 임시저장할 때마다 쌓여.';
  histDlg.showModal();
  if (items.length) selectHistory(0);
}

histList.addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (li) selectHistory(Number(li.dataset.i));
});
histRestore.addEventListener('click', async () => {
  const item = histCtx?.items[histCtx.selected];
  if (!item) return;
  histDlg.close();
  await histCtx.onRestore(item);
});
histDlg.querySelector('[data-close]').addEventListener('click', () => histDlg.close());
histDlg.addEventListener('click', (e) => {
  if (e.target === histDlg) histDlg.close();
});

// ───────── 충돌 창: 두 버전 나란히 ─────────

const cfDlg = $('#conflictDlg');
let cfResolve = null;

// 두 글에서 앞뒤로 같은 부분을 빼고, 서로 다른 가운데 부분만 표시한다.
function showDiff(pre, text, other) {
  const max = Math.min(text.length, other.length);
  let p = 0;
  while (p < max && text[p] === other[p]) p++;
  let s = 0;
  while (s < max - p && text[text.length - 1 - s] === other[other.length - 1 - s]) s++;
  const mid = text.slice(p, text.length - s);
  const mark = document.createElement('mark');
  mark.textContent = mid || '(여기서 달라짐)';
  if (!mid) mark.className = 'empty';
  pre.replaceChildren(text.slice(0, p), mark, text.slice(text.length - s));
  // 다른 부분이 바로 보이게 스크롤
  requestAnimationFrame(() => (pre.scrollTop = Math.max(0, mark.offsetTop - pre.offsetTop - 60)));
}

// 'local'(이 기기 버전) 또는 'remote'(드라이브 버전)를 돌려준다. 고를 때까지 닫히지 않는다.
export function askConflict(mine, theirs, count) {
  return new Promise((resolve) => {
    cfResolve = resolve;
    $('#cfTitle').textContent = `「${mine.title || theirs.title || '제목 없음'}」 — 어느 버전을 쓸까?`;
    $('#cfLocalInfo').textContent = `${count(mine.body)}자 · ${fmtTime(mine.updatedAt)}`;
    $('#cfRemoteInfo').textContent = `${count(theirs.body)}자 · ${fmtTime(theirs.updatedAt)}`;
    showDiff($('#cfLocal'), mine.body, theirs.body);
    showDiff($('#cfRemote'), theirs.body, mine.body);
    if (!cfDlg.open) cfDlg.showModal();
  });
}

function pick(choice) {
  if (!cfResolve) return;
  const resolve = cfResolve;
  cfResolve = null;
  cfDlg.close();
  resolve(choice);
}
$('#cfUseLocal').addEventListener('click', () => pick('local'));
$('#cfUseRemote').addEventListener('click', () => pick('remote'));
cfDlg.addEventListener('cancel', (e) => e.preventDefault()); // Esc로 그냥 닫지 못하게(반드시 고르게)
