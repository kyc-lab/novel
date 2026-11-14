import * as db from './db.js';
import { countChars, fmt } from './count.js';
import * as settings from './settings.js';
import { askText, askConfirm, askChoice } from './dialogs.js';
import * as symbols from './symbols.js';
import * as drive from './drive.js';
import * as sync from './sync.js';
import * as history from './history.js';
import { makeChapterPdf } from './pdf.js';
import * as wiki from './wiki.js';
import * as ai from './ai.js';

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

let blockedMsg = ''; // 저장소를 못 열고 있을 때 보여줄 안내
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

function setStatus(text, kind = '') {
  el.saveStatus.textContent = text;
  el.saveStatus.classList.toggle('busy', kind === 'busy');
  el.saveStatus.classList.toggle('warn', kind === 'warn' || kind === 'action');
  el.saveStatus.classList.toggle('action', kind === 'action'); // 누르면 뭔가 되는 상태
}

// 저장·동기화 상태를 한 줄로 보여준다.
// 잠깐 보여 주는 알림(예: "회차 완료 · PDF 저장됨"). ms 뒤에 원래 상태 표시로 돌아간다.
let notice = '';
let noticeTimer = null;
function setNotice(text, ms) {
  notice = text;
  clearTimeout(noticeTimer);
  if (text) noticeTimer = setTimeout(() => setNotice('', 0), ms);
  refreshStatus();
}

function refreshStatus() {
  if (blockedMsg) return setStatus(blockedMsg, 'warn');
  if (notice) return setStatus(notice, 'busy');
  if (syncing) return setStatus(`동기화 중… ${syncNote}`, 'busy');
  if (saveFailed) return setStatus('기기 저장 실패!', 'warn');
  if (dirty) return setStatus('저장 중…', 'busy');
  if (!drive.wasConnected()) return setStatus('기기에 저장됨');
  if (!navigator.onLine) return setStatus('오프라인 · 최신이 아닐 수 있음', 'warn');
  if (!drive.isSignedIn()) {
    return reconnectJob ? setStatus('드라이브 다시 연결 중…', 'busy') : setStatus('드라이브 연결 필요 · 아무 데나 누르면 연결', 'action');
  }
  if (syncError) return setStatus(syncError + ' · 눌러서 다시', 'action');
  if (uploading) return setStatus('드라이브에 올리는 중…', 'busy');
  if (pending) return setStatus('드라이브에 아직 안 올라감', 'warn');
  setStatus(savedNow ? '저장 완료 · 닫아도 돼요' : '드라이브에 저장됨');
}

function scheduleSave() {
  dirty = true;
  savedNow = false;
  refreshStatus();
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
  ch.dirty = true; // 드라이브에 아직 안 올라감
  try {
    await db.put('chapters', ch);
    saveFailed = false;
    updateListItem(ch);
    markPending();
    autoSnapshot(ch).catch(console.error);
  } catch (err) {
    dirty = true;
    saveFailed = true;
    refreshStatus();
    console.error(err);
  }
}

async function saveCursor() {
  if (!state.workId || !state.chapterId) return;
  await db.setMeta('lastChapter:' + state.workId, {
    id: state.chapterId,
    cursor: el.editor.selectionStart,
    scroll: el.editor.scrollTop,
  });
  // "이 기기에서 마지막으로 쓰던 시각"은 작가가 직접 움직였을 때만 갱신한다(앱이 열리면서 저절로 바뀌면 안 됨).
  if (userMoved) {
    userMoved = false;
    await db.setMeta('posUpdatedAt', Date.now());
  }
}
let userMoved = false;

// ───────── 드라이브 동기화 ─────────

const PUSH_DELAY = 20000; // 기기에 저장하고 이만큼(ms) 지나면 드라이브에도 올린다
let syncing = false; // 전체 동기화 중(원고 잠금)
let syncNote = ''; // 동기화가 지금 뭘 하는 중인지
let uploading = false;
let pending = false; // 드라이브에 아직 안 올라간 게 있음
let savedNow = false; // 방금 임시저장을 눌러서 올림
let saveFailed = false;
let syncError = '';
let pushTimer = null;
let firstSync = true; // 앱을 연 뒤 첫 동기화(이때만 다른 기기의 마지막 자리로 이동)

const canSync = () => drive.wasConnected() && navigator.onLine && drive.isSignedIn();

// ── 드라이브 자동 재연결 ──
// 구글 출입증은 1시간짜리라 앱을 다시 열면 대개 만료돼 있다. 설정에 들어가지 않아도 알아서 다시 받는다.
//  1) 앱을 열자마자 조용히 시도 (브라우저가 이 앱의 팝업을 허용해 둔 경우 바로 성공)
//  2) 브라우저가 막으면, 앱 안 아무 데나 처음 누르는 순간 다시 시도 (누른 직후에는 팝업이 허용됨)
const needsReconnect = () => drive.wasConnected() && !drive.isSignedIn() && navigator.onLine;
let reconnectJob = null;
let reconnectArmed = false;

// 다시 연결하고 바로 동기화. 이미 진행 중이면 그 결과를 같이 기다린다.
function reconnect() {
  reconnectJob ??= (async () => {
    try {
      await drive.signIn();
      syncError = '';
      await runSync();
      return true;
    } catch (err) {
      sync.log(`자동 재연결 실패: ${err.message}`);
      return false;
    } finally {
      reconnectJob = null;
      refreshStatus();
    }
  })();
  return reconnectJob;
}

async function autoReconnect() {
  if (!needsReconnect()) return;
  if (await reconnect()) return;
  if (reconnectArmed || !needsReconnect()) return;
  reconnectArmed = true;
  document.addEventListener(
    'click',
    function onFirstClick() {
      document.removeEventListener('click', onFirstClick, true);
      reconnectArmed = false;
      if (needsReconnect()) reconnect();
    },
    true,
  );
}

function markPending() {
  pending = drive.wasConnected();
  refreshStatus();
  clearTimeout(pushTimer);
  if (pending) pushTimer = setTimeout(pushNow, PUSH_DELAY);
}

const currentPosition = () => ({
  workId: state.workId,
  chapterId: state.chapterId,
  cursor: el.editor.selectionStart,
  scroll: el.editor.scrollTop,
});

// 바뀐 것만 드라이브에 올린다(원고 입력은 안 막음). 성공하면 true.
async function pushNow() {
  clearTimeout(pushTimer);
  if (syncing || uploading) return false;
  await flush();
  await wiki.flush();
  clearTimeout(pushTimer);
  if (!canSync()) {
    refreshStatus();
    return false;
  }
  uploading = true;
  refreshStatus();
  let needFull = false;
  try {
    const res = await sync.pushDirty(currentPosition());
    needFull = res.conflict;
    syncError = '';
    if (!needFull) pending = await sync.hasPending();
  } catch (err) {
    sync.log(`올리기 실패: ${err.message}`);
    if (!(err instanceof drive.NeedSignIn)) {
      syncError = '드라이브 올리기 실패';
      console.error(err);
    }
  } finally {
    uploading = false;
    refreshStatus();
  }
  if (needFull) return runSync(); // 다른 기기가 먼저 고쳤다 → 전체 동기화로 맞춘다
  return !pending && !syncError && canSync();
}

// 드라이브와 전체를 맞춘다. 그동안 원고 입력을 잠근다(덮어쓰기 사고 방지). 성공하면 true.
async function runSync() {
  if (syncing) return false;
  if (!canSync()) {
    refreshStatus();
    return false;
  }
  syncing = true;
  syncNote = '';
  savedNow = false;
  document.body.classList.add('syncing');
  el.editor.readOnly = true;
  el.chapTitle.readOnly = true;
  $('#wikiBody').readOnly = true;
  refreshStatus();
  let ok = false;
  try {
    await flush();
    await wiki.flush();
    await saveCursor();
    const res = await sync.syncAll();
    syncNote = '화면 맞추는 중';
    refreshStatus();
    await reloadFromDb(res);
    await wiki.reload(); // 위키 화면도 받아온 내용으로 맞춘다
    await sync.pushDirty(firstSync ? null : currentPosition());
    pending = await sync.hasPending();
    syncError = '';
    firstSync = false;
    ok = true;
  } catch (err) {
    sync.log(`실패: ${err.message}`);
    if (!(err instanceof drive.NeedSignIn)) {
      syncError = '동기화 실패';
      console.error(err);
    }
  } finally {
    syncing = false;
    document.body.classList.remove('syncing');
    el.editor.readOnly = false;
    el.chapTitle.readOnly = false;
    $('#wikiBody').readOnly = false;
    refreshStatus();
  }
  return ok;
}

// 동기화가 끝난 뒤 기기에 저장된 내용으로 화면을 다시 맞춘다.
async function reloadFromDb(res) {
  state.works = (await db.getAll('works')).sort((a, b) => a.createdAt - b.createdAt);
  if (!state.works.length) await createWork('새 작품');

  // 앱을 막 열었고, 다른 기기에서 더 나중에 쓰던 자리가 있으면 거기로 간다.
  const rs = res.remoteState;
  const myPosAt = (await db.getMeta('posUpdatedAt')) ?? 0;
  if (firstSync && rs && rs.device !== sync.deviceId && rs.updatedAt > myPosAt && state.works.some((w) => w.id === rs.workId)) {
    await db.setMeta('lastChapter:' + rs.workId, { id: rs.chapterId, cursor: rs.cursor, scroll: rs.scroll });
    state.chapterId = null;
    await openWork(rs.workId);
    return;
  }

  if (!state.works.some((w) => w.id === state.workId)) {
    state.chapterId = null;
    await openWork(state.works[0].id);
    return;
  }

  const cursor = el.editor.selectionStart;
  const scroll = el.editor.scrollTop;
  state.chapters = (await db.getChaptersOf(state.workId)).sort((a, b) => a.order - b.order);
  if (!state.chapters.length) await createChapter();
  renderWorks();
  const ch = currentChapter();
  if (!ch) {
    state.chapterId = null;
    await openChapter(state.chapters.at(-1).id);
    return;
  }
  // 지금 보던 회차가 드라이브 버전으로 바뀌었으면 화면도 바꾼다.
  if (ch.body !== el.editor.value) {
    snapBase = { ...ch };
    el.editor.value = ch.body;
    const pos = Math.min(cursor, ch.body.length);
    el.editor.setSelectionRange(pos, pos);
    el.editor.scrollTop = scroll;
  }
  el.chapTitle.value = ch.title;
  el.chapNum.textContent = state.chapters.indexOf(ch) + 1 + '화';
  renderChapters();
  updateCounts();
}

const fmtTime = (ts) =>
  new Date(ts).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

sync.init({
  progress(text) {
    syncNote = text;
    refreshStatus();
  },
  // 지금 화면에 올라와 있는 회차는 앱이 직접 고쳐서 저장한다.
  async patchChapter(id, fn) {
    const ch = state.chapters.find((c) => c.id === id);
    if (!ch) return false;
    fn(ch);
    await db.put('chapters', ch);
    return true;
  },
  // 두 기기에서 같은 회차를 따로 고쳤을 때: 작가가 고른다.
  patchWiki: (id, fn) => wiki.patch(id, fn),
  resolveConflict: (mine, theirs) => history.askConflict(mine, theirs, countLabel),
});

const countLabel = (text) => fmt(mainCount(text));

// ───────── 되돌리기 기록 ─────────

const SNAP_EVERY = 10 * 60 * 1000; // 쓰는 동안 이 간격으로 자동 기록
let snapBase = null; // 회차를 열었을 때의 모습(고치기 시작하면 "편집 시작 전"으로 남긴다)
let lastSnapAt = 0;

async function autoSnapshot(ch) {
  if (snapBase && snapBase.id === ch.id) {
    const base = snapBase;
    snapBase = null;
    lastSnapAt = Date.now();
    await history.add(base, '편집 시작 전');
  } else if (Date.now() - lastSnapAt > SNAP_EVERY) {
    lastSnapAt = Date.now();
    await history.add(ch, '자동 기록');
  }
}

$('#btnHistory').addEventListener('click', async () => {
  await flush();
  const ch = currentChapter();
  if (!ch) return;
  history.open({
    chapter: ch,
    count: countLabel,
    async onRestore(item) {
      await flush();
      await history.add(currentChapter(), '되돌리기 직전'); // 되돌린 걸 다시 되돌릴 수 있게
      el.editor.value = item.body;
      el.chapTitle.value = item.title;
      el.editor.setSelectionRange(item.body.length, item.body.length);
      updateCounts();
      scheduleSave();
    },
  });
});

function scheduleCursorSave() {
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(saveCursor, 500);
}

// ───────── 작품 ─────────

async function createWork(title) {
  const work = { id: uid(), title, createdAt: Date.now(), updatedAt: Date.now() };
  await db.put('works', work);
  state.works.push(work);
  await sync.markWorksDirty();
  markPending();
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
    work.updatedAt = Date.now();
    await db.put('works', work);
    await sync.markWorksDirty();
    markPending();
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
    for (const c of state.chapters) {
      await db.del('chapters', c.id);
      await sync.addTombstone('chapter', c.id);
    }
    for (const doc of await db.getWikiOf(work.id)) {
      await db.del('wiki', doc.id);
      await sync.addTombstone('wiki', doc.id);
    }
    await db.del('works', work.id);
    await sync.addTombstone('work', work.id);
    markPending();
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
    dirty: true,
  };
  await db.put('chapters', ch);
  state.chapters.push(ch);
  markPending();
  return ch;
}

async function openChapter(id, restore) {
  await flush();
  await saveCursor();
  state.chapterId = id;
  const ch = currentChapter();
  snapBase = { ...ch };
  el.editor.value = ch.body;
  el.chapTitle.value = ch.title;
  el.chapNum.textContent = state.chapters.indexOf(ch) + 1 + '화';
  const pos = Math.min(restore?.cursor ?? ch.body.length, ch.body.length);
  el.editor.setSelectionRange(pos, pos);
  if (isWide()) el.editor.focus();
  el.editor.scrollTop = restore?.scroll ?? el.editor.scrollHeight;
  renderChapters();
  updateCounts();
  refreshStatus();
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
    userMoved = true;
    if (id !== state.chapterId) await openChapter(id);
    closeSidebar();
  } else if (act === 'done') {
    await flush();
    ch.done = !ch.done;
    ch.updatedAt = Date.now();
    ch.dirty = true;
    await db.put('chapters', ch);
    markPending();
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
    await sync.addTombstone('chapter', id);
    markPending();
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
  userMoved = true;
  scheduleCursorSave();
});
for (const type of ['keyup', 'click', 'select', 'scroll']) {
  el.editor.addEventListener(
    type,
    () => {
      if (type === 'keyup' || type === 'click') userMoved = true;
      scheduleCursorSave();
    },
    { passive: true },
  );
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
  userMoved = true;
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
    saveCursor();
    if (pending) pushNow(); // 나가는 김에 드라이브에도 올려 본다(pushNow가 기기 저장도 같이 함)
    else flush();
  } else if (needsReconnect()) {
    autoReconnect();
  } else {
    runSync(); // 다른 앱 보다가 돌아오면 먼저 드라이브 확인
  }
});
window.addEventListener('online', () => (needsReconnect() ? autoReconnect() : runSync()));
window.addEventListener('offline', refreshStatus);

// 임시저장: 지금 바로 드라이브에 올린다.
$('#btnSaveNow').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await flush();
    await history.add(currentChapter(), '임시저장');
    lastSnapAt = Date.now();
    if (!drive.wasConnected() || !drive.isSignedIn()) {
      if (!navigator.onLine) return refreshStatus();
      // 버튼을 누른 직후라 로그인 창을 띄울 수 있다
      if (drive.wasConnected()) await reconnect();
      else await drive.signIn();
    }
    const ok = firstSync ? (await runSync()) && (await pushNow()) : await pushNow();
    savedNow = ok;
  } catch (err) {
    syncError = err.message;
  } finally {
    btn.disabled = false;
    refreshStatus();
  }
});

// 설정 창의 AI 칸(담당 회사, 키, 모델, 연결 시험)
const aiPanel = ai.initPanel(el.settingsDlg);
el.btnSettings.addEventListener('click', aiPanel.render);

// 자동 변환 규칙을 바꾸면 드라이브에 올릴 게 생긴 것(다른 기기와 공유)
settings.onSharedChange(() => markPending());

// ───────── 위키 화면 ─────────

wiki.init({
  // 문서를 고치면 드라이브에 올릴 게 생긴 것
  onChange: () => markPending(),
  async onDelete(id) {
    await sync.addTombstone('wiki', id);
    markPending();
  },
});

async function setWikiMode(on) {
  if (on) {
    await flush();
    const work = state.works.find((w) => w.id === state.workId);
    $('#wikiLabel').textContent = `${work.title} · 위키`;
    await wiki.open(state.workId);
  } else {
    await wiki.flush();
  }
  document.body.classList.toggle('mode-wiki', on);
  $('#wiki').hidden = !on;
  $('#btnWiki').textContent = on ? '원고로' : '위키';
  if (on) setFocusMode(false);
}
$('#btnWiki').addEventListener('click', () => setWikiMode(!document.body.classList.contains('mode-wiki')));

// ───────── 회차 완료: PDF로 만들어 드라이브에 저장하고 완료 표시 ─────────

const safeName = (s) => s.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

$('#btnDone').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  await flush();
  const ch = currentChapter();
  if (!ch) return;
  const no = state.chapters.indexOf(ch) + 1;
  const work = state.works.find((w) => w.id === state.workId);
  if (!ch.body.trim()) {
    await askConfirm('아직 본문이 비어 있어서 완료할 수 없어.', '알겠어');
    return;
  }
  const online = navigator.onLine && drive.wasConnected();
  const ok = await askConfirm(
    `${no}화 「${ch.title || '제목 없음'}」(${countLabel(ch.body)}자)를 완료할까?\n\n` +
      (online
        ? `PDF와 원문(txt)을 드라이브의 "집필 앱 › 완료 회차 › ${safeName(work.title)}" 폴더에 저장해.`
        : '지금은 드라이브에 연결돼 있지 않아서, PDF와 원문(txt)을 이 기기에 내려받아.'),
    '회차 완료',
  );
  if (!ok) return;

  btn.disabled = true;
  try {
    setNotice('PDF 만드는 중…', 60000);
    const { blob, pages } = await makeChapterPdf({
      workTitle: work.title,
      no,
      title: ch.title,
      body: ch.body,
      fontFamily: settings.get().bodyFont === 'sans' ? 'Noto Sans KR' : 'Noto Serif KR',
    });
    // PDF와 원문(txt)은 같은 이름으로, 작품별 폴더에 같이 저장한다.
    const name = safeName(`${work.title}_${String(no).padStart(3, '0')}화${ch.title ? '_' + ch.title : ''}`);
    // 메모장에서도 한글이 안 깨지게 맨 앞에 표식(BOM)을 붙인다.
    const txt = new Blob(['﻿', `${work.title}\n${no}화${ch.title ? ' ' + ch.title : ''}\n\n${ch.body}\n`], { type: 'text/plain' });
    const saveLocal = () => {
      downloadBlob(blob, name + '.pdf');
      downloadBlob(txt, name + '.txt');
    };

    let where = '이 기기에 내려받음';
    if (online) {
      if (!drive.isSignedIn()) await reconnect(); // 버튼을 누른 직후라 로그인 창을 띄울 수 있다
      if (drive.isSignedIn()) {
        setNotice('드라이브에 올리는 중…', 60000);
        const root = await drive.ensureSubfolder('완료 회차');
        const folder = await drive.ensureFolderIn(root, safeName(work.title), work.folderId);
        if (folder !== work.folderId) {
          work.folderId = folder;
          work.updatedAt = Date.now();
          await db.put('works', work);
          await sync.markWorksDirty();
        }
        ch.pdfId = await drive.uploadFile({ name: name + '.pdf', parent: folder, mimeType: 'application/pdf', blob, fileId: ch.pdfId });
        ch.txtId = await drive.uploadFile({ name: name + '.txt', parent: folder, mimeType: 'text/plain', blob: txt, fileId: ch.txtId });
        where = '드라이브에 저장됨';
      } else saveLocal();
    } else saveLocal();

    ch.done = true;
    ch.updatedAt = Date.now();
    ch.dirty = true;
    await db.put('chapters', ch);
    await history.add(ch, '회차 완료');
    renderChapters();
    markPending();
    setNotice(`회차 완료 · PDF ${pages}쪽 + 원문 ${where}`, 6000);
    pushNow();
  } catch (err) {
    console.error(err);
    sync.log(`회차 완료 실패: ${err.message}`);
    setNotice('', 0);
    await askConfirm(`회차 완료를 못 했어.\n${err.message}`, '알겠어');
  } finally {
    btn.disabled = false;
  }
});

// 상태 글자를 눌렀을 때: 연결이 필요하면 연결, 실패했으면 다시 시도.
el.saveStatus.addEventListener('click', async () => {
  if (!el.saveStatus.classList.contains('action')) return;
  try {
    if (!drive.isSignedIn()) {
      await reconnect();
      return;
    }
    syncError = '';
    await runSync();
  } catch (err) {
    syncError = err.message;
    refreshStatus();
  }
});
window.addEventListener('pagehide', () => {
  flush();
  saveCursor();
});

// ───────── 시작 ─────────

// 앱이 다른 창(예전 버전)에도 열려 있으면 원고 저장소를 못 연다. 그 창을 닫으면 저절로 이어진다.
db.onBlocked(() => {
  blockedMsg = '앱이 다른 창에도 열려 있어 · 그 창을 닫아줘';
  el.editor.readOnly = true;
  refreshStatus();
});

async function init() {
  state.works = (await db.getAll('works')).sort((a, b) => a.createdAt - b.createdAt);
  if (blockedMsg) {
    blockedMsg = '';
    el.editor.readOnly = false;
  }
  if (!state.works.length) await createWork('새 작품');
  const lastWorkId = await db.getMeta('lastWorkId');
  const start = state.works.find((w) => w.id === lastWorkId) ?? state.works[0];
  await openWork(start.id);
  // 브라우저가 공간이 모자랄 때 원고를 멋대로 지우지 않게 부탁해 둔다.
  navigator.storage?.persist?.();
  // 기기에 있는 원고로 먼저 열고, 바로 드라이브를 확인한다.
  if (drive.wasConnected()) {
    pending = await sync.hasPending();
    refreshStatus();
    drive.preload();
    if (needsReconnect()) await autoReconnect();
    else await runSync();
  }
}

// ───────── 구글 드라이브 연결 (설정 창) ─────────

const driveStatus = $('#driveStatus');
const driveBtn = $('#driveBtn');
const driveMsg = $('#driveMsg');

function renderDrive() {
  if (drive.isSignedIn()) {
    driveStatus.textContent = `연결됨 · ${drive.userEmail()}`;
    driveBtn.textContent = '연결 끊기';
  } else if (drive.wasConnected()) {
    driveStatus.textContent = `다시 연결 필요 · ${drive.userEmail()}`;
    driveBtn.textContent = '다시 연결';
  } else {
    driveStatus.textContent = '연결 안 됨';
    driveBtn.textContent = '연결';
  }
}

driveBtn.addEventListener('click', async () => {
  driveMsg.textContent = '';
  if (drive.isSignedIn()) {
    drive.signOut();
    return;
  }
  driveBtn.disabled = true;
  try {
    await drive.signIn();
    await drive.ensureFolder();
    $('#settingsDlg').close();
    await runSync(); // 연결하자마자 드라이브와 맞춘다
  } catch (err) {
    driveMsg.textContent = err.message;
  } finally {
    driveBtn.disabled = false;
    renderDrive();
  }
});
drive.onChange(renderDrive);
renderDrive();

// 동기화 기록: 펼칠 때 최신 내용으로 채운다.
function renderSyncLog() {
  if (!$('#syncLogBox').open) return;
  const pre = $('#syncLog');
  pre.textContent = sync.getLog() || '아직 기록이 없어.';
  pre.scrollTop = pre.scrollHeight;
}
$('#syncLogBox').addEventListener('toggle', renderSyncLog);
sync.onLog(renderSyncLog); // 펼쳐 둔 채로 있어도 새 기록이 바로 보이게
el.btnSettings.addEventListener('click', renderSyncLog);
$('#syncLogCopy').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  renderSyncLog();
  try {
    await navigator.clipboard.writeText(sync.getLog());
    btn.textContent = '복사됨';
  } catch {
    btn.textContent = '복사 실패 — 직접 드래그해서 복사해줘';
  }
  setTimeout(() => (btn.textContent = '기록 복사'), 2000);
});

// 오프라인에서도 앱이 열리게 하는 서비스 워커 등록
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.error('서비스 워커 등록 실패', err));
}

init().catch((err) => {
  console.error(err);
  setStatus('열기 실패 — 새로고침 해줘', 'warn');
});
