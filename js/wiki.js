// 작품 위키: 인물·장소·설정 같은 걸 문서로 정리해 두는 곳. 작품마다 따로 있다.
// 문서 하나 = { id, workId, title, category, body, createdAt, updatedAt, dirty }
// 본문에서 [[문서 제목]] 이라고 쓰면 그 문서로 가는 링크가 된다.

import * as db from './db.js';
import { askText, askConfirm } from './dialogs.js';
import * as status from './status.js';

const DEFAULT_CATS = ['인물', '장소', '세력', '설정', '사건', '기타'];
const NEW_CAT = '__new__';
const SAVE_DELAY = 400;
const uid = () => crypto.randomUUID();
const $ = (sel) => document.querySelector(sel);

const el = {
  root: $('#wiki'),
  search: $('#wikiSearch'),
  list: $('#wikiList'),
  btnNew: $('#wikiNew'),
  empty: $('#wikiEmpty'),
  box: $('#wikiDocBox'),
  back: $('#wikiBack'),
  title: $('#wikiTitle'),
  cat: $('#wikiCat'),
  toggle: $('#wikiToggle'),
  del: $('#wikiDel'),
  view: $('#wikiView'),
  body: $('#wikiBody'),
  hint: $('#wikiHint'),
};

let hooks = { onChange: () => {}, onDelete: () => {} };
let workId = null;
let docs = [];
let current = null;
let editing = false;
let dirty = false;
let saveTimer = null;
let statusUpto = Infinity; // 상태 칸의 "N화 기준" (Infinity = 최신)

// 지금 문서의 상태 기록을 바꿔서 바로 저장한다.
async function saveStatus(list) {
  await flush();
  current.status = list;
  current.updatedAt = Date.now();
  current.dirty = true;
  await db.put('wiki', current);
  hooks.onChange();
  renderView();
}

const findByTitle = (title) => docs.find((d) => d.title.trim() === title.trim());

// ───────── 저장 ─────────

function scheduleSave() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, SAVE_DELAY);
}

export async function flush() {
  clearTimeout(saveTimer);
  if (!dirty || !current) return;
  dirty = false;
  current.title = el.title.value.trim();
  current.body = el.body.value;
  current.category = el.cat.value === NEW_CAT ? current.category : el.cat.value;
  current.updatedAt = Date.now();
  current.dirty = true; // 드라이브에 아직 안 올라감
  await db.put('wiki', current);
  renderList();
  hooks.onChange();
}

// ───────── 목록 ─────────

function categories() {
  const used = docs.map((d) => d.category).filter(Boolean);
  const extra = [...new Set(used)].filter((c) => !DEFAULT_CATS.includes(c)).sort((a, b) => a.localeCompare(b, 'ko'));
  return [...DEFAULT_CATS, ...extra];
}

function renderList() {
  const q = el.search.value.trim().toLowerCase();
  const hit = (d) => !q || d.title.toLowerCase().includes(q) || d.body.toLowerCase().includes(q);
  const items = [];
  for (const cat of categories()) {
    const group = docs.filter((d) => d.category === cat && hit(d)).sort((a, b) => a.title.localeCompare(b.title, 'ko'));
    if (!group.length) continue;
    const head = document.createElement('li');
    head.className = 'wiki-cat';
    head.textContent = `${cat} ${group.length}`;
    items.push(head);
    for (const d of group) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.id = d.id;
      btn.className = d.id === current?.id ? 'on' : '';
      btn.textContent = d.title || '제목 없음';
      li.append(btn);
      items.push(li);
    }
  }
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'wiki-none';
    li.textContent = q ? '찾는 문서가 없어.' : '아직 문서가 없어. "＋ 새 문서"로 시작해.';
    items.push(li);
  }
  el.list.replaceChildren(...items);
}

// ───────── 문서 보기 ─────────

// 한 줄 안의 [[링크]]를 누를 수 있는 글자로 바꿔서 node에 붙인다.
function appendInline(node, text) {
  const re = /\[\[([^\[\]|]+)(?:\|([^\[\]]+))?\]\]/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    node.append(text.slice(last, m.index));
    const a = document.createElement('a');
    const target = m[1].trim();
    a.href = '#';
    a.dataset.wiki = target;
    a.textContent = (m[2] ?? m[1]).trim();
    if (!findByTitle(target)) {
      a.className = 'missing';
      a.title = '아직 없는 문서 — 누르면 새로 만들어';
    }
    node.append(a);
    last = m.index + m[0].length;
  }
  node.append(text.slice(last));
}

// 본문을 읽기 좋은 모양으로: # 큰 제목, ## 작은 제목, - 목록, 빈 줄로 문단 나누기
function renderView() {
  const out = [];
  let ul = null;
  for (const raw of current.body.replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!ul) {
        ul = document.createElement('ul');
        out.push(ul);
      }
      const li = document.createElement('li');
      appendInline(li, bullet[1]);
      ul.append(li);
      continue;
    }
    ul = null;
    const head = /^(#{1,2})\s+(.*)$/.exec(line);
    if (head) {
      const h = document.createElement(head[1].length === 1 ? 'h3' : 'h4');
      appendInline(h, head[2]);
      out.push(h);
    } else if (!line.trim()) {
      const gap = document.createElement('div');
      gap.className = 'gap';
      out.push(gap);
    } else {
      const p = document.createElement('p');
      appendInline(p, line);
      out.push(p);
    }
  }
  if (!current.body.trim()) {
    const p = document.createElement('p');
    p.className = 'wiki-none';
    p.textContent = '내용이 비어 있어. "고치기"를 눌러서 써 봐.';
    out.push(p);
  }
  // 인물 문서(또는 상태 기록이 있는 문서)는 아래에 "상태" 칸을 붙인다.
  if (current.category === '인물' || current.status?.length) {
    out.push(
      status.renderSection(current, {
        upto: statusUpto,
        onUpto: (n) => {
          statusUpto = n;
          renderView();
        },
        onAdd: (entry) => saveStatus([...(current.status ?? []), entry]),
        onDelete: (id) => saveStatus((current.status ?? []).filter((e) => e.id !== id)),
      }),
    );
  }
  el.view.replaceChildren(...out);
}

function renderDoc() {
  el.root.classList.toggle('doc-open', !!current);
  el.empty.hidden = !!current;
  el.box.hidden = !current;
  if (!current) return;

  el.title.value = current.title;
  el.title.readOnly = !editing;
  el.cat.replaceChildren(
    ...categories().map((c) => new Option(c, c, false, c === current.category)),
    new Option('＋ 새 분류…', NEW_CAT),
  );
  el.cat.disabled = !editing;
  el.body.value = current.body;
  el.body.hidden = !editing;
  el.view.hidden = editing;
  el.hint.hidden = !editing;
  el.del.hidden = !editing;
  el.toggle.textContent = editing ? '다 썼어' : '고치기';
  el.toggle.classList.toggle('primary', editing);
  if (!editing) renderView();
}

async function select(id, { edit = false } = {}) {
  await flush();
  current = docs.find((d) => d.id === id) ?? null;
  statusUpto = Infinity;
  editing = edit;
  if (current) await db.setMeta('wikiLast:' + workId, current.id);
  renderList();
  renderDoc();
}

async function create(title = '') {
  await flush();
  const doc = {
    id: uid(),
    workId,
    title,
    category: current?.category ?? DEFAULT_CATS[0],
    body: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    dirty: true,
  };
  await db.put('wiki', doc);
  docs.push(doc);
  hooks.onChange();
  await select(doc.id, { edit: true });
  (title ? el.body : el.title).focus();
}

// ───────── 바깥에서 부르는 것 ─────────

export function init(h = {}) {
  hooks = { ...hooks, ...h };

  el.search.addEventListener('input', renderList);
  el.btnNew.addEventListener('click', () => create());
  el.list.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-id]');
    if (btn) select(btn.dataset.id);
  });
  el.back.addEventListener('click', async () => {
    await flush();
    current = null;
    renderList();
    renderDoc();
  });

  el.toggle.addEventListener('click', async () => {
    await flush();
    editing = !editing;
    renderDoc();
    if (editing) el.body.focus();
  });
  el.title.addEventListener('input', scheduleSave);
  el.body.addEventListener('input', scheduleSave);
  el.cat.addEventListener('change', async () => {
    if (el.cat.value === NEW_CAT) {
      const name = await askText('새 분류 이름');
      if (name) current.category = name;
      dirty = true;
      await flush();
      renderDoc();
      return;
    }
    scheduleSave();
  });

  el.del.addEventListener('click', async () => {
    const ok = await askConfirm(`「${current.title || '제목 없음'}」 문서를 지울까?\n되돌릴 수 없어.`, '지우기', true);
    if (!ok) return;
    clearTimeout(saveTimer);
    dirty = false;
    const id = current.id;
    await db.del('wiki', id);
    docs = docs.filter((d) => d.id !== id);
    current = null;
    editing = false;
    await hooks.onDelete(id);
    renderList();
    renderDoc();
  });

  // 본문 속 [[링크]] 누르기: 있으면 그 문서로, 없으면 그 제목으로 새 문서
  el.view.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-wiki]');
    if (!a) return;
    e.preventDefault();
    const target = findByTitle(a.dataset.wiki);
    if (target) select(target.id);
    else create(a.dataset.wiki);
  });
}

// 위키 화면을 연다(작품이 바뀌었으면 그 작품의 문서를 읽어 온다).
export async function open(id) {
  await flush();
  workId = id;
  docs = await db.getWikiOf(id);
  const last = await db.getMeta('wikiLast:' + id);
  current = docs.find((d) => d.id === last) ?? null;
  editing = false;
  el.search.value = '';
  renderList();
  renderDoc();
}

// 동기화가 "올렸다"는 꼬리표를 붙일 때: 지금 들고 있는 문서면 여기서 직접 고쳐 저장하고 true.
export async function patch(id, fn) {
  const doc = docs.find((d) => d.id === id);
  if (!doc) return false;
  fn(doc);
  await db.put('wiki', doc);
  return true;
}

// 다른 기기에서 받아온 뒤 화면을 다시 맞춘다.
// 위키 바깥(회차 완료 검토 등)에서 한 작품의 문서들을 고칠 때 쓴다.
// fn(docs) 안에서 문서를 고치거나 새 문서를 배열에 넣고, 바뀐 문서 목록을 돌려준다.
export async function mutate(targetWorkId, fn) {
  await flush();
  const open = targetWorkId === workId;
  const list = open ? docs : await db.getWikiOf(targetWorkId);
  const changed = fn(list, { newDoc: (props) => ({ id: uid(), workId: targetWorkId, title: '', category: '기타', body: '', status: [], createdAt: Date.now(), ...props }) });
  for (const d of changed) {
    if (!list.includes(d)) list.push(d);
    d.updatedAt = Date.now();
    d.dirty = true;
    await db.put('wiki', d);
  }
  if (open && !el.root.hidden) {
    renderList();
    renderDoc();
  }
  if (changed.length) hooks.onChange();
  return changed;
}

// 한 작품의 위키 문서들(읽기만)
export const docsOf = async (targetWorkId) => (targetWorkId === workId ? docs : db.getWikiOf(targetWorkId));

export async function reload() {
  if (!workId || dirty) return;
  docs = await db.getWikiOf(workId);
  current = current ? docs.find((d) => d.id === current.id) ?? null : null;
  renderList();
  renderDoc();
}
