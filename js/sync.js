// 드라이브 동기화.
//
// 드라이브의 "집필 앱" 폴더 안에 이렇게 둔다:
//   works.json     작품 목록 + 지운 작품·회차 표시
//   ch-<id>.json   회차 하나가 파일 하나 (바뀐 회차만 올리고 받기 위해)
//   state.json     마지막에 쓰던 작품·회차·커서 자리
//
// 회차마다 기기에 기억해 두는 것:
//   dirty      마지막으로 올린 뒤에 이 기기에서 고쳤는가
//   remoteId   드라이브 파일 번호
//   remoteVer  마지막으로 맞춘 드라이브 파일의 지문(md5). 드라이브 쪽 지문이 이것과 다르면 "다른 기기가 고쳤다"는 뜻.
//
// 규칙: 이 기기만 고침 → 올린다 / 드라이브만 바뀜 → 받는다 / 둘 다 바뀜 → 작가에게 묻는다(자동으로 덮어쓰지 않음).

import * as db from './db.js';
import * as drive from './drive.js';
import * as history from './history.js';
import * as settings from './settings.js';

const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const CH_PREFIX = 'ch-';
const uid = () => crypto.randomUUID();

// ───────── 동기화 기록 (문제가 생겼을 때 무슨 일이 있었는지 보기 위해) ─────────

const LOG_KEY = 'syncLog';
let logLines = [];
try {
  logLines = JSON.parse(localStorage.getItem(LOG_KEY)) ?? [];
} catch {
  logLines = [];
}
export function log(msg) {
  const t = new Date().toLocaleTimeString('en-GB'); // 22:09:01 모양
  logLines.push(`${t} ${msg}`);
  if (logLines.length > 300) logLines = logLines.slice(-300);
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(logLines));
  } catch {
    // 기록을 못 남겨도 동기화는 계속한다
  }
  logListeners.forEach((fn) => fn());
}
const logListeners = [];
export const onLog = (fn) => logListeners.push(fn);
export const getLog = () => logLines.join('\n');
const label = (ch) => `「${ch.title || '제목 없음'}」(${[...(ch.body ?? '')].length}자)`;

let hooks = {
  // 진행 상황을 화면에 알린다.
  progress: () => {},
  // 앱이 지금 들고 있는 회차면 앱이 직접 고치고 true를 돌려준다(기기 저장과 엇갈리지 않게).
  patchChapter: async () => false,
  // 위키 문서도 마찬가지(위키 화면에 열려 있는 문서)
  patchWiki: async () => false,
  patchNote: async () => false, // 작법 노트도 마찬가지
  patchMeeting: async () => false, // 회의 기록도 마찬가지
  patchTrend: async () => false, // 트렌드 자료도 마찬가지
  // 충돌: 'local'(이 기기 버전) 또는 'remote'(드라이브 버전)를 돌려준다.
  resolveConflict: async () => 'local',
};
export function init(h) {
  hooks = { ...hooks, ...h };
}

export const deviceId = (() => {
  let id = localStorage.getItem('deviceId');
  if (!id) {
    id = uid();
    localStorage.setItem('deviceId', id);
  }
  return id;
})();

// ───────── 기기에 적어 두는 동기화 장부 ─────────

async function getBook() {
  return {
    worksId: null, // 드라이브의 works.json 파일 번호
    worksVer: null, // 마지막으로 맞춘 works.json 지문
    worksDirty: true, // 작품 목록·지운 표시가 아직 안 올라갔는가
    stateId: null,
    deletedWorks: {}, // { 작품id: 지운 시각 }
    deletedChapters: {},
    deletedWiki: {},
    deletedNotes: {},
    deletedMeetings: {},
    deletedTrends: {},
    everSynced: false,
    ...((await db.getMeta('sync')) ?? {}),
  };
}
const setBook = (book) => db.setMeta('sync', book);

export async function markWorksDirty() {
  const book = await getBook();
  book.worksDirty = true;
  await setBook(book);
}

export async function addTombstone(kind, id) {
  const book = await getBook();
  const list = kind === 'work' ? book.deletedWorks : kind === 'wiki' ? book.deletedWiki : kind === 'note' ? book.deletedNotes : kind === 'meeting' ? book.deletedMeetings : kind === 'trend' ? book.deletedTrends : book.deletedChapters;
  list[id] = Date.now();
  book.worksDirty = true;
  await setBook(book);
}

// 드라이브에 아직 안 올라간 게 있는가
export async function hasPending() {
  const book = await getBook();
  if (book.worksDirty) return true;
  if (settings.getShared().dirty) return true;
  for (const kind of KINDS) if ((await db.getAll(kind.store)).some((x) => x.dirty)) return true;
  return false;
}

// ───────── 드라이브 파일 다루기 ─────────

async function listRemote(folder) {
  const files = new Map();
  const q = encodeURIComponent(`'${folder}' in parents and trashed = false`);
  let pageToken = '';
  do {
    const res = await drive.call(
      `/files?q=${q}&orderBy=createdTime&pageSize=1000&fields=nextPageToken,files(id,name,md5Checksum,modifiedTime)` +
        (pageToken ? `&pageToken=${pageToken}` : ''),
    );
    // 같은 이름이 둘이면 먼저 만들어진 쪽을 쓴다.
    for (const f of res.files) if (!files.has(f.name)) files.set(f.name, f);
    pageToken = res.nextPageToken ?? '';
  } while (pageToken);
  return files;
}

function createFile(folder, name, data) {
  const boundary = 'jipil' + Date.now();
  const meta = { name, parents: [folder], mimeType: 'application/json' };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(data)}\r\n--${boundary}--`;
  return drive.call('/files?uploadType=multipart&fields=id,md5Checksum', {
    base: UPLOAD,
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
}

function updateFile(id, data) {
  return drive.call(`/files/${id}?uploadType=media&fields=id,md5Checksum`, {
    base: UPLOAD,
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

const download = (id) => drive.call(`/files/${id}?alt=media`);

const trash = (id) =>
  drive
    .call(`/files/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    })
    .catch((err) => {
      if (err.status !== 404) throw err;
    });

// 드라이브 파일의 지금 지문. 파일이 없거나 휴지통이면 null.
async function currentVer(id) {
  try {
    const f = await drive.call(`/files/${id}?fields=md5Checksum,trashed`);
    return f.trashed ? null : f.md5Checksum;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

// ───────── 회차 · 위키 문서 (둘 다 "하나가 파일 하나"라서 같은 방식으로 맞춘다) ─────────

const KINDS = [
  {
    name: '회차',
    store: 'chapters',
    prefix: CH_PREFIX, // 드라이브 파일 이름 ch-<id>.json
    tomb: 'deletedChapters',
    hook: 'patchChapter',
    // 드라이브에 올리는 모양(동기화용 꼬리표는 뺀다)
    toRemote: (ch) => ({
      id: ch.id,
      workId: ch.workId,
      order: ch.order,
      title: ch.title,
      body: ch.body,
      done: ch.done,
      createdAt: ch.createdAt,
      updatedAt: ch.updatedAt,
      pdfId: ch.pdfId ?? null, // 회차 완료 때 올린 PDF 파일 번호(다른 기기에서 다시 완료해도 같은 파일을 고치게)
      txtId: ch.txtId ?? null, // 같이 올린 원문(txt) 파일 번호
      summary: ch.summary ?? '', // 회차 완료 검토에서 작가가 확정한 줄거리 요약
      review: ch.review ?? null, // 'done'(검토함) / 'later'(나중에 검토)
      check: ch.check ?? null, // 작가가 확정한 점검 결과
      aiMarks: ch.aiMarks ?? [], // 본문 속 AI 문장 위치(보라색 밑줄)
    }),
    same: (a, b) =>
      a.body === b.body && a.title === b.title && !!a.done === !!b.done && a.order === b.order && a.workId === b.workId &&
      (a.summary ?? '') === (b.summary ?? '') && (a.review ?? null) === (b.review ?? null) &&
      JSON.stringify(a.check ?? null) === JSON.stringify(b.check ?? null) && JSON.stringify(a.aiMarks ?? []) === JSON.stringify(b.aiMarks ?? []),
  },
  {
    name: '위키',
    store: 'wiki',
    prefix: 'wk-', // wk-<id>.json
    tomb: 'deletedWiki',
    hook: 'patchWiki',
    toRemote: (d) => ({
      id: d.id,
      workId: d.workId,
      title: d.title,
      category: d.category,
      body: d.body,
      status: d.status ?? [], // 인물 상태 기록(설정집)
      hook: d.hook ?? null, // 떡밥 문서면 { first, resolved }
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    }),
    same: (a, b) =>
      a.body === b.body && a.title === b.title && a.category === b.category && a.workId === b.workId &&
      JSON.stringify(a.status ?? []) === JSON.stringify(b.status ?? []) && JSON.stringify(a.hook ?? null) === JSON.stringify(b.hook ?? null),
  },
  {
    name: '작법',
    store: 'notes',
    prefix: 'nt-', // nt-<id>.json — 작품과 상관없는 작법 노트 팁
    tomb: 'deletedNotes',
    hook: 'patchNote',
    toRemote: (n) => {
      const { remoteId, remoteVer, dirty, ...rest } = n; // 동기화용 꼬리표만 빼고 그대로
      return rest;
    },
    same: (a, b) => {
      const strip = ({ remoteId, remoteVer, dirty, updatedAt, ...rest }) => stable(rest);
      return strip(a) === strip(b);
    },
  },
  {
    name: '회의',
    store: 'meetings',
    prefix: 'mt-', // mt-<id>.json — 전개 회의 기록(지시서·전개안·정리·작가 선택·메모)
    tomb: 'deletedMeetings',
    hook: 'patchMeeting',
    toRemote: (m) => {
      const { remoteId, remoteVer, dirty, ...rest } = m;
      return rest;
    },
    same: (a, b) => {
      const strip = ({ remoteId, remoteVer, dirty, updatedAt, ...rest }) => stable(rest);
      return strip(a) === strip(b);
    },
  },
  {
    name: '트렌드',
    store: 'trends',
    prefix: 'tr-', // tr-<id>.json — 문피아 무료·유료 상위 50 같은 트렌드 자료(작품과 상관없음)
    tomb: 'deletedTrends',
    hook: 'patchTrend',
    toRemote: (t) => {
      const { remoteId, remoteVer, dirty, ...rest } = t;
      return rest;
    },
    same: (a, b) => {
      const strip = ({ remoteId, remoteVer, dirty, updatedAt, ...rest }) => stable(rest);
      return strip(a) === strip(b);
    },
  },
];

async function patchItem(kind, id, fn) {
  if (await hooks[kind.hook](id, fn)) return;
  const rec = await db.get(kind.store, id);
  if (!rec) return;
  fn(rec);
  await db.put(kind.store, rec);
}

// 하나를 올린다. 저장 직전에 드라이브 버전을 한 번 더 확인해서, 그 사이 다른 기기가 고쳤으면 올리지 않고 'conflict'.
async function pushItem(kind, item, folder) {
  const sentAt = item.updatedAt;
  const data = kind.toRemote(item);
  const fileName = `${kind.prefix}${item.id}.json`;
  let res;
  if (item.remoteId) {
    const ver = await currentVer(item.remoteId);
    if (ver && ver !== item.remoteVer) {
      log(`올리려는데 드라이브 쪽이 먼저 바뀜 · ${kind.name} ${label(item)}`);
      return 'conflict';
    }
    res = ver ? await updateFile(item.remoteId, data) : await createFile(folder, fileName, data);
  } else {
    res = await createFile(folder, fileName, data);
  }
  log(`올림 · ${kind.name} ${label(item)}`);
  await patchItem(kind, item.id, (rec) => {
    rec.remoteId = res.id;
    rec.remoteVer = res.md5Checksum;
    if (rec.updatedAt === sentAt) rec.dirty = false; // 올리는 사이에 또 고쳤으면 dirty 유지
  });
  return 'ok';
}

async function storeRemote(kind, data, file) {
  log(`받음 · ${kind.name} ${label(data)}`);
  await db.put(kind.store, { ...data, remoteId: file.id, remoteVer: file.md5Checksum, dirty: false });
}

const addHistory = (ch, reason) => history.add(ch, reason);

// ───────── 작품 목록 ─────────

const worksPayload = (works, book) => ({
  works: works
    .map((w) => ({
      id: w.id,
      title: w.title,
      genre: w.genre ?? '', // 작법 팁을 고르는 장르(예: 현판 › 헌터 › 회빙환)
      createdAt: w.createdAt,
      updatedAt: w.updatedAt ?? w.createdAt,
      folderId: w.folderId ?? null, // 완료 회차(PDF·txt)를 모아 두는 이 작품의 드라이브 폴더
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1)),
  deletedWorks: book.deletedWorks ?? {},
  deletedChapters: book.deletedChapters ?? {},
  deletedWiki: book.deletedWiki ?? {},
  deletedNotes: book.deletedNotes ?? {},
  deletedMeetings: book.deletedMeetings ?? {},
  deletedTrends: book.deletedTrends ?? {},
});
const stable = (obj) => JSON.stringify(obj, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v));

// 새 기기에서 처음 동기화할 때, 앱이 자동으로 만든 빈 "새 작품"은 치운다(드라이브에 쓸데없는 작품이 쌓이지 않게).
async function dropPristineWorks() {
  const works = await db.getAll('works');
  const chapters = await db.getAll('chapters');
  const wikiDocs = await db.getAll('wiki');
  for (const w of works) {
    const mine = chapters.filter((c) => c.workId === w.id);
    const hasWiki = wikiDocs.some((d) => d.workId === w.id);
    if (w.title === '새 작품' && !hasWiki && mine.every((c) => !c.body && !c.title && !c.remoteId)) {
      for (const c of mine) await db.del('chapters', c.id);
      await db.del('works', w.id);
    }
  }
}

// ───────── 기기끼리 공유하는 설정 (자동 변환 규칙) — settings.json ─────────
// 규칙은 통째로 "더 나중에 바꾼 쪽"을 따른다. 시각이 같은데 내용이 다르면(둘 다 예전부터 따로 고쳐 둔 경우) 합친다.

const SETTINGS_FILE = 'settings.json';
const sharedPayload = (s) => ({ rules: s.rules, ellipsisStyle: s.ellipsisStyle, smartQuotes: s.smartQuotes, updatedAt: s.updatedAt });
const sharedSame = (a, b) =>
  stable({ r: a.rules, e: a.ellipsisStyle, q: a.smartQuotes }) === stable({ r: b.rules, e: b.ellipsisStyle, q: b.smartQuotes });

async function uploadShared(book, folder, data) {
  const res = book.settingsId ? await updateFile(book.settingsId, data) : await createFile(folder, SETTINGS_FILE, data);
  book.settingsId = res.id;
  book.settingsVer = res.md5Checksum;
  settings.markSharedUploaded(data.updatedAt);
  log('올림 · 변환 규칙');
}

async function syncShared(book, folder, file) {
  const mine = settings.getShared();
  if (!file) {
    book.settingsId = null;
    await uploadShared(book, folder, sharedPayload(mine));
    return;
  }
  book.settingsId = file.id;
  if (file.md5Checksum === book.settingsVer) {
    if (mine.dirty) await uploadShared(book, folder, sharedPayload(mine));
    return;
  }
  const theirs = await download(file.id);
  const theirAt = theirs.updatedAt ?? 0;
  if (sharedSame(mine, theirs)) {
    settings.applyShared({ ...theirs, updatedAt: Math.max(theirAt, mine.updatedAt) });
    book.settingsVer = file.md5Checksum;
  } else if (theirAt > mine.updatedAt && mine.updatedAt !== 1) {
    // (시각 1 = 이 기능이 생기기 전에 이 기기에서 따로 고쳐 둔 규칙 → 덮어쓰지 않고 아래에서 합친다)
    settings.applyShared(theirs);
    book.settingsVer = file.md5Checksum;
    log('받음 · 변환 규칙');
  } else if (theirAt < mine.updatedAt) {
    await uploadShared(book, folder, sharedPayload(mine));
  } else {
    // 어느 쪽이 나중인지 가릴 수 없음 → 합친다(이 기기 규칙 + 저쪽에만 있는 규칙)
    const extra = (theirs.rules ?? []).filter((r) => !mine.rules.some((m) => m.from === r.from));
    const merged = { ...sharedPayload(mine), rules: [...mine.rules, ...extra], updatedAt: Date.now() };
    settings.applyShared(merged, { dirty: true });
    await uploadShared(book, folder, sharedPayload(settings.getShared()));
    log('합침 · 변환 규칙');
  }
}

// ───────── 전체 동기화 (앱을 열 때 · 돌아올 때) ─────────
// 부르는 쪽에서 원고 입력을 잠가 두고 부른다.

export async function syncAll() {
  const started = Date.now();
  log('── 전체 동기화 시작');
  hooks.progress('드라이브 확인');
  const folder = await drive.ensureFolder();
  const remote = await listRemote(folder);
  const book = await getBook();
  const result = { pulled: 0, pushed: 0, conflicts: 0, remoteState: null };
  const countOf = (kind) => [...remote.keys()].filter((n) => n.startsWith(kind.prefix)).length;
  log(`드라이브 파일 ${remote.size}개 (${KINDS.map((k) => `${k.name} ${countOf(k)}개`).join(', ')})`);

  // 1) 작품 목록 합치기
  const worksFile = remote.get('works.json');
  let remoteWorks = null;
  if (worksFile) {
    remoteWorks = await download(worksFile.id);
    if (!book.everSynced) await dropPristineWorks();
    Object.entries(remoteWorks.deletedWorks ?? {}).forEach(([id, at]) => (book.deletedWorks[id] ??= at));
    Object.entries(remoteWorks.deletedChapters ?? {}).forEach(([id, at]) => (book.deletedChapters[id] ??= at));
    Object.entries(remoteWorks.deletedWiki ?? {}).forEach(([id, at]) => (book.deletedWiki[id] ??= at));
    Object.entries(remoteWorks.deletedNotes ?? {}).forEach(([id, at]) => (book.deletedNotes[id] ??= at));
    Object.entries(remoteWorks.deletedMeetings ?? {}).forEach(([id, at]) => (book.deletedMeetings[id] ??= at));
    Object.entries(remoteWorks.deletedTrends ?? {}).forEach(([id, at]) => (book.deletedTrends[id] ??= at));
    const localWorks = new Map((await db.getAll('works')).map((w) => [w.id, w]));
    for (const rw of remoteWorks.works ?? []) {
      if (book.deletedWorks[rw.id]) continue;
      const lw = localWorks.get(rw.id);
      if (!lw || (rw.updatedAt ?? 0) > (lw.updatedAt ?? lw.createdAt ?? 0)) await db.put('works', rw);
    }
  }

  // 2) 지운 표시를 이 기기에 적용
  for (const w of await db.getAll('works')) if (book.deletedWorks[w.id]) await db.del('works', w.id);
  for (const kind of KINDS) {
    for (const x of await db.getAll(kind.store)) {
      if (book[kind.tomb][x.id] || book.deletedWorks[x.workId]) {
        if (x.dirty) await addHistory(x, '다른 기기에서 지워짐');
        await db.del(kind.store, x.id);
      }
    }
  }

  // 3) 회차 · 위키 문서 맞추기
  for (const kind of KINDS) {
    const total = countOf(kind);
    let step = 0;
    const local = new Map((await db.getAll(kind.store)).map((x) => [x.id, x]));
    const seen = new Set();
    for (const [name, file] of remote) {
      if (!name.startsWith(kind.prefix)) continue;
      const id = name.slice(kind.prefix.length, -'.json'.length);
      seen.add(id);
      hooks.progress(`${kind.name} 확인 ${++step}/${total}`);
      if (book[kind.tomb][id]) {
        await trash(file.id);
        continue;
      }
      const mine = local.get(id);

      if (!mine) {
        const data = await download(file.id);
        if (book.deletedWorks[data.workId]) await trash(file.id);
        else {
          await storeRemote(kind, data, file);
          result.pulled++;
        }
        continue;
      }

      const remoteChanged = file.md5Checksum !== mine.remoteVer || file.id !== mine.remoteId;
      if (!remoteChanged) {
        if (mine.dirty && (await pushItem(kind, mine, folder)) === 'ok') result.pushed++;
        continue;
      }

      const data = await download(file.id);
      if (!mine.dirty) {
        if (!kind.same(mine, data)) await addHistory(mine, '다른 기기 버전을 받기 전');
        await storeRemote(kind, data, file);
        result.pulled++;
      } else if (kind.same(mine, data)) {
        await patchItem(kind, id, (rec) => Object.assign(rec, { remoteId: file.id, remoteVer: file.md5Checksum, dirty: false }));
      } else {
        // 둘 다 바뀜 → 작가가 고른다. 안 고른 쪽은 되돌리기 기록에 남긴다.
        result.conflicts++;
        log(`충돌 · ${kind.name} ${label(mine)} ↔ 드라이브 ${label(data)} — 작가 선택 대기`);
        hooks.progress('어느 버전을 쓸지 골라줘');
        const choice = await hooks.resolveConflict(mine, data, kind.name);
        log(`선택: ${choice === 'remote' ? '드라이브 버전' : '이 기기 버전'}`);
        if (choice === 'remote') {
          await addHistory(mine, '충돌 · 이 기기 버전');
          await storeRemote(kind, data, file);
          result.pulled++;
        } else {
          await addHistory(data, '충돌 · 드라이브 버전');
          const fresh = { ...mine, remoteId: file.id, remoteVer: file.md5Checksum };
          await patchItem(kind, id, (rec) => Object.assign(rec, { remoteId: file.id, remoteVer: file.md5Checksum }));
          if ((await pushItem(kind, fresh, folder)) === 'ok') result.pushed++;
        }
      }
    }
    // 드라이브에 파일이 없는 것 → 새로 올린다(처음 올리는 것, 또는 드라이브에서 누가 파일을 지운 경우)
    for (const [id, mine] of local) {
      if (seen.has(id)) continue;
      hooks.progress(`새 ${kind.name} 올리는 중`);
      if ((await pushItem(kind, { ...mine, remoteId: null, remoteVer: null }, folder)) === 'ok') result.pushed++;
    }
  }

  // 4) 작품 목록 올리기(드라이브 것과 다를 때만)
  const merged = worksPayload(await db.getAll('works'), book);
  const remoteSame = remoteWorks && stable(worksPayload(remoteWorks.works ?? [], remoteWorks)) === stable(merged);
  if (remoteSame) {
    book.worksId = worksFile.id;
    book.worksVer = worksFile.md5Checksum;
  } else {
    const res = worksFile ? await updateFile(worksFile.id, merged) : await createFile(folder, 'works.json', merged);
    book.worksId = res.id;
    book.worksVer = res.md5Checksum;
  }
  book.worksDirty = false;

  // 4-2) 자동 변환 규칙 맞추기
  await syncShared(book, folder, remote.get(SETTINGS_FILE));

  // 5) 마지막에 쓰던 자리
  const stateFile = remote.get('state.json');
  if (stateFile) {
    book.stateId = stateFile.id;
    result.remoteState = await download(stateFile.id).catch(() => null);
  }

  book.everSynced = true;
  await setBook(book);
  log(`── 끝: 받음 ${result.pulled}, 올림 ${result.pushed}, 충돌 ${result.conflicts}, ${((Date.now() - started) / 1000).toFixed(1)}초`);
  return result;
}

// ───────── 올리기만 (자동 업로드 · 임시저장) ─────────
// 원고 입력을 막지 않는다. 다른 기기가 먼저 고친 게 보이면 올리지 않고 { conflict: true } → 부르는 쪽이 전체 동기화를 돌린다.

export async function pushDirty(position) {
  const folder = await drive.ensureFolder();
  const book = await getBook();
  if (!book.everSynced) return { conflict: true }; // 한 번도 안 맞춰 봤으면 전체 동기화부터

  let pushed = 0;
  for (const kind of KINDS) {
    for (const item of await db.getAll(kind.store)) {
      if (!item.dirty) continue;
      if ((await pushItem(kind, item, folder)) === 'conflict') return { conflict: true, pushed };
      pushed++;
    }
  }

  const fresh = await getBook();
  if (fresh.worksDirty) {
    if (fresh.worksId && (await currentVer(fresh.worksId)) !== fresh.worksVer) return { conflict: true, pushed };
    const payload = worksPayload(await db.getAll('works'), fresh);
    const res = fresh.worksId ? await updateFile(fresh.worksId, payload) : await createFile(folder, 'works.json', payload);
    Object.assign(fresh, { worksId: res.id, worksVer: res.md5Checksum, worksDirty: false });
    // 지운 회차·위키 문서의 드라이브 파일은 휴지통으로
    const remote = await listRemote(folder);
    for (const kind of KINDS) {
      for (const id of Object.keys(fresh[kind.tomb])) {
        const f = remote.get(`${kind.prefix}${id}.json`);
        if (f) await trash(f.id);
      }
    }
    await setBook(fresh);
  }

  // 자동 변환 규칙을 바꿨으면 올린다. 그 사이 다른 기기가 먼저 바꿨으면 전체 동기화에서 맞춘다.
  if (settings.getShared().dirty) {
    const book3 = await getBook();
    if (book3.settingsId && (await currentVer(book3.settingsId)) !== book3.settingsVer) return { conflict: true, pushed };
    await uploadShared(book3, folder, sharedPayload(settings.getShared()));
    await setBook(book3);
  }

  if (position) {
    const data = { ...position, device: deviceId, updatedAt: Date.now() };
    const book2 = await getBook();
    let res;
    try {
      res = book2.stateId ? await updateFile(book2.stateId, data) : await createFile(folder, 'state.json', data);
    } catch (err) {
      if (err.status !== 404) throw err;
      res = await createFile(folder, 'state.json', data);
    }
    if (res.id !== book2.stateId) await setBook({ ...(await getBook()), stateId: res.id });
  }
  return { conflict: false, pushed };
}
