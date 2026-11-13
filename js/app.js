import * as db from './db.js';
import { countChars, fmt } from './count.js';
import * as settings from './settings.js';
import { askText, askConfirm } from './dialogs.js';
import * as symbols from './symbols.js';

const SAVE_DELAY = 300; // 입력이 멈추고 이만큼(ms) 지나면 기기에 저장

const $ = (sel) => document.querySelector(sel);
const el = {
  btnMenu: $('#btnMenu'),
  chapNum: $('#chapNum'),
  chapTitle: $('#chapTitle'),
  saveStatus: $('#saveStatus'),
  sidebar: $('#sidebar'),
  workSelect: $('#workSelect'),
  btnWorkMenu: $('#btnWorkMenu'),
  workMenu: $('#workMenu'),
  chapList: $('#chapList'),
  btnNewChap: $('#btnNewChap'),
  editor: $('#editor'),
  progressFill: $('#progressFill'),
  countMain: $('#countMain'),
  countSub: $('#countSub'),
  countGoal: $('#countGoal'),
  backdrop: $('#backdrop'),
  overlayCount: $('#overlayCount'),
  btnFocus: $('#btnFocus'),
  btnFocusExit: $('#btnFocusExit'),
  btnSettings: $('#btnSettings'),
  settingsDlg: $('#settingsDlg'),
};

const state = {
  works: [],
  chapters: [], // 지금 연 작품의 회차들 (순서대로)
  workId: null,
  chapterId: null,
};

let saveTimer = null;
let cursorTimer = null;
let dirty = false;

const uid = () => crypto.randomUUID();
const currentChapter = () => state.chapters.find((c) => c.id === state.chapterId);
const isWide = () => window.matchMedia('(min-width: 801px)').matches;

// 설정의 "세는 기준"대로 센 글자수. (둘 다일 때 대표값은 공백 포함)
function mainCount(text) {
  const s = settings.get();
  return countChars(text, { spaces: s.countBasis !== 'without', newlines: s.countNewlines });
}

// ───────── 저장 ─────────

function setStatus(text, busy = false) {
  el.saveStatus.textContent = text;
  el.saveStatus.classList.toggle('busy', busy);
}

function scheduleSave() {
  dirty = true;
  setStatus('저장 중…', true);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, SAVE_DELAY);
}

// 아직 안 쓴 변경을 지금 바로 기기에 쓴다.
async function flush() {
  clearTimeout(saveTimer);
  if (!dirty) return;
  const ch = currentChapter();
  if (!ch) return;
  dirty = false;
  ch.body = el.editor.value;
  ch.title = el.chapTitle.value.trim();
  ch.chars = countChars(ch.body);
  ch.updatedAt = Date.now();
  try {
    await db.put('chapters', ch);
    if (!dirty) setStatus('기기에 저장됨');
    updateListItem(ch);
  } catch (err) {
    dirty = true;
    setStatus('저장 실패!', true);
    console.error(err);
  }
}

function saveCursor() {
  if (!state.workId || !state.chapterId) return;
  return db.setMeta('lastChapter:' + state.workId, {
    id: state.chapterId,
    cursor: el.editor.selectionStart,
    scroll: el.editor.scrollTop,
  });
}

function scheduleCursorSave() {
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(saveCursor, 500);
}

// ───────── 작품 ─────────

async function createWork(title) {
  const work = { id: uid(), title, createdAt: Date.now() };
  await db.put('works', work);
  state.works.push(work);
  return work;
}

async function openWork(workId) {
  await flush();
  state.workId = workId;
  await db.setMeta('lastWorkId', workId);
  state.chapters = (await db.getChaptersOf(workId)).sort((a, b) => a.order - b.order);
  if (!state.chapters.length) await createChapter();
  const last = await db.getMeta('lastChapter:' + workId);
  const target = state.chapters.find((c) => c.id === last?.id);
  renderWorks();
  if (target) await openChapter(target.id, last);
  else await openChapter(state.chapters.at(-1).id);
}

function renderWorks() {
  el.workSelect.replaceChildren(
    ...state.works.map((w) => {
      const opt = new Option(w.title, w.id);
      opt.selected = w.id === state.workId;
      return opt;
    }),
  );
}

async function onWorkMenu(act) {
  el.workMenu.hidden = true;
  const work = state.works.find((w) => w.id === state.workId);
  if (act === 'new') {
    const title = await askText('새 작품 제목');
    if (!title) return;
    const w = await createWork(title);
    await openWork(w.id);
  } else if (act === 'rename') {
    const title = await askText('작품 제목', work.title);
    if (!title) return;
    work.title = title;
    await db.put('works', work);
    renderWorks();
  } else if (act === 'delete') {
    const ok = await askConfirm(
      `「${work.title}」 작품과 회차 ${state.chapters.length}개를 전부 지울까?\n되돌릴 수 없어.`,
      '지우기',
      true,
    );
    if (!ok) return;
    dirty = false;
    clearTimeout(saveTimer);
    for (const c of state.chapters) await db.del('chapters', c.id);
    await db.del('works', work.id);
    state.works = state.works.filter((w) => w.id !== work.id);
    if (!state.works.length) await createWork('새 작품');
    await openWork(state.works[0].id);
  }
}

// ───────── 회차 ─────────

async function createChapter() {
  const order = state.chapters.reduce((m, c) => Math.max(m, c.order), 0) + 1;
  const ch = {
    id: uid(),
    workId: state.workId,
    order,
    title: '',
    body: '',
    chars: 0,
    done: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await db.put('chapters', ch);
  state.chapters.push(ch);
  return ch;
}

async function openChapter(id, restore) {
  await flush();
  await saveCursor();
  state.chapterId = id;
  const ch = currentChapter();
  el.editor.value = ch.body;
  el.chapTitle.value = ch.title;
  el.chapNum.textContent = state.chapters.indexOf(ch) + 1 + '화';
  const pos = Math.min(restore?.cursor ?? ch.body.length, ch.body.length);
  el.editor.setSelectionRange(pos, pos);
  if (isWide()) el.editor.focus();
  el.editor.scrollTop = restore?.scroll ?? el.editor.scrollHeight;
  renderChapters();
  updateCounts();
  setStatus('기기에 저장됨');
  await saveCursor();
}

function renderChapters() {
  el.chapList.replaceChildren(
    ...state.chapters.map((ch, i) => {
      const li = document.createElement('li');
      li.className = 'chap-item' + (ch.id === state.chapterId ? ' active' : '');
      li.dataset.id = ch.id;

      const open = document.createElement('button');
      open.className = 'chap-open';
      open.dataset.act = 'open';
      const line1 = document.createElement('span');
      line1.className = 'line1';
      const no = document.createElement('span');
      no.className = 'no';
      no.textContent = i + 1 + '화';
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = ch.title || '제목 없음';
      line1.append(no, title);
      const line2 = document.createElement('span');
      line2.className = 'line2';
      line2.textContent = fmt(mainCount(ch.body)) + '자';
      open.append(line1, line2);

      const done = document.createElement('button');
      done.className = 'chap-done' + (ch.done ? ' on' : '');
      done.dataset.act = 'done';
      done.textContent = ch.done ? '✔' : '○';
      done.title = ch.done ? '완료됨 (누르면 해제)' : '완료 표시';

      const del = document.createElement('button');
      del.className = 'chap-del';
      del.dataset.act = 'delete';
      del.textContent = '✕';
      del.title = '회차 삭제';

      li.append(open, done, del);
      return li;
    }),
  );
  el.chapList.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}

// 목록에서 한 줄만 가볍게 갱신 (글 쓰는 동안 계속 불리므로)
function updateListItem(ch) {
  const li = el.chapList.querySelector(`[data-id="${ch.id}"]`);
  if (!li) return;
  li.querySelector('.title').textContent = ch.title || '제목 없음';
  li.querySelector('.line2').textContent = fmt(mainCount(ch.body)) + '자';
}

async function onChapterClick(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.chap-item').dataset.id;
  const ch = state.chapters.find((c) => c.id === id);
  const act = btn.dataset.act;

  if (act === 'open') {
    if (id !== state.chapterId) await openChapter(id);
    closeSidebar();
  } else if (act === 'done') {
    await flush();
    ch.done = !ch.done;
    await db.put('chapters', ch);
    renderChapters();
  } else if (act === 'delete') {
    const no = state.chapters.indexOf(ch) + 1;
    const chars = fmt(mainCount(id === state.chapterId ? el.editor.value : ch.body));
    const ok = await askConfirm(
      `${no}화 「${ch.title || '제목 없음'}」(${chars}자)를 지울까?\n되돌릴 수 없어.`,
      '지우기',
      true,
    );
    if (!ok) return;
    if (id === state.chapterId) {
      dirty = false;
      clearTimeout(saveTimer);
    }
    await db.del('chapters', id);
    const idx = state.chapters.indexOf(ch);
    state.chapters.splice(idx, 1);
    if (!state.chapters.length) await createChapter();
    if (id === state.chapterId) {
      state.chapterId = null;
      await openChapter(state.chapters[Math.min(idx, state.chapters.length - 1)].id);
    } else {
      el.chapNum.textContent = state.chapters.indexOf(currentChapter()) + 1 + '화';
      renderChapters();
    }
  }
}

// ───────── 글자수 ─────────

function updateCounts() {
  const text = el.editor.value;
  const s = settings.get();
  const withSpaces = countChars(text, { spaces: true, newlines: s.countNewlines });
  const noSpaces = countChars(text, { spaces: false, newlines: s.countNewlines });
  const main = s.countBasis === 'without' ? noSpaces : withSpaces;
  el.countMain.textContent =
    s.countBasis === 'without' ? `공백 제외 ${fmt(noSpaces)}자` : `공백 포함 ${fmt(withSpaces)}자`;
  el.countSub.textContent = s.countBasis === 'both' ? `공백 제외 ${fmt(noSpaces)}자` : '';
  el.countGoal.textContent = `목표 ${fmt(s.goal)}자 · ${Math.floor((main / s.goal) * 100)}%`;
  el.countGoal.classList.toggle('reached', main >= s.goal);
  el.progressFill.style.width = Math.min(100, (main / s.goal) * 100) + '%';
  el.overlayCount.textContent = `${fmt(main)} / ${fmt(s.goal)}`;
}

// ───────── 집중 모드 ─────────

function setFocusMode(on) {
  document.body.classList.toggle('focus', on);
  if (on) {
    closeSidebar();
    el.editor.focus();
  }
}

// ───────── 폰용 목록 서랍 ─────────

function openSidebar() {
  el.sidebar.classList.add('open');
  el.backdrop.hidden = false;
}
function closeSidebar() {
  el.sidebar.classList.remove('open');
  el.backdrop.hidden = true;
}

// ───────── 연결 ─────────

el.editor.addEventListener('input', () => {
  updateCounts();
  scheduleSave();
  scheduleCursorSave();
});
for (const type of ['keyup', 'click', 'select', 'scroll']) {
  el.editor.addEventListener(type, scheduleCursorSave, { passive: true });
}
el.chapTitle.addEventListener('input', scheduleSave);
el.chapTitle.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) el.editor.focus();
});

el.workSelect.addEventListener('change', () => openWork(el.workSelect.value));
el.btnWorkMenu.addEventListener('click', () => (el.workMenu.hidden = !el.workMenu.hidden));
el.workMenu.addEventListener('click', (e) => {
  const act = e.target.closest('button')?.dataset.act;
  if (act) onWorkMenu(act);
});

el.chapList.addEventListener('click', onChapterClick);
el.btnNewChap.addEventListener('click', async () => {
  await flush();
  const ch = await createChapter();
  await openChapter(ch.id);
  closeSidebar();
  el.editor.focus();
});

el.btnMenu.addEventListener('click', openSidebar);
el.backdrop.addEventListener('click', closeSidebar);

el.btnFocus.addEventListener('click', () => setFocusMode(true));
el.btnFocusExit.addEventListener('click', () => setFocusMode(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.settingsDlg.open) setFocusMode(false);
});

settings.initPanel({ dialog: el.settingsDlg, openButton: el.btnSettings });
symbols.init({ editor: el.editor, bar: $('#symbolBar') });
// 설정이 바뀌면 글자수 표시를 새 기준으로 다시 그린다.
settings.onChange(() => {
  updateCounts();
  renderChapters();
});

// 다른 앱으로 넘어가거나 창을 닫을 때 마지막 한 글자까지 저장
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    flush();
    saveCursor();
  }
});
window.addEventListener('pagehide', () => {
  flush();
  saveCursor();
});

// ───────── 시작 ─────────

async function init() {
  state.works = (await db.getAll('works')).sort((a, b) => a.createdAt - b.createdAt);
  if (!state.works.length) await createWork('새 작품');
  const lastWorkId = await db.getMeta('lastWorkId');
  const start = state.works.find((w) => w.id === lastWorkId) ?? state.works[0];
  await openWork(start.id);
  // 브라우저가 공간이 모자랄 때 원고를 멋대로 지우지 않게 부탁해 둔다.
  navigator.storage?.persist?.();
}

// 오프라인에서도 앱이 열리게 하는 서비스 워커 등록
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.error('서비스 워커 등록 실패', err));
}

init().catch((err) => {
  console.error(err);
  setStatus('열기 실패 — 새로고침 해줘', true);
});
