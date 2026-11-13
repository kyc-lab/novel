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
}
export const getLog = () => logLines.join('\n');
const label = (ch) => `「${ch.title || '제목 없음'}」(${[...(ch.body ?? '')].length}자)`;

let hooks = {
  // 진행 상황을 화면에 알린다.
  progress: () => {},
  // 앱이 지금 들고 있는 회차면 앱이 직접 고치고 true를 돌려준다(기기 저장과 엇갈리지 않게).
  patchChapter: async () => false,
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
  (kind === 'work' ? book.deletedWorks : book.deletedChapters)[id] = Date.now();
  book.worksDirty = true;
  await setBook(book);
}

// 드라이브에 아직 안 올라간 게 있는가
export async function hasPending() {
  const book = await getBook();
  if (book.worksDirty) return true;
  return (await db.getAll('chapters')).some((c) => c.dirty);
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

// ───────── 회차 ─────────

// 드라이브에 올리는 모양(동기화용 꼬리표는 뺀다)
const toRemote = (ch) => ({
  id: ch.id,
  workId: ch.workId,
  order: ch.order,
  title: ch.title,
  body: ch.body,
  done: ch.done,
  createdAt: ch.createdAt,
  updatedAt: ch.updatedAt,
});

const sameContent = (a, b) =>
  a.body === b.body && a.title === b.title && !!a.done === !!b.done && a.order === b.order && a.workId === b.workId;

async function patchChapter(id, fn) {
  if (await hooks.patchChapter(id, fn)) return;
  const rec = await db.get('chapters', id);
  if (!rec) return;
  fn(rec);
  await db.put('chapters', rec);
}

// 회차 하나를 올린다. 저장 직전에 드라이브 버전을 한 번 더 확인해서, 그 사이 다른 기기가 고쳤으면 올리지 않고 'conflict'.
async function pushChapter(ch, folder) {
  const sentAt = ch.updatedAt;
  const data = toRemote(ch);
  let res;
  if (ch.remoteId) {
    const ver = await currentVer(ch.remoteId);
    if (ver && ver !== ch.remoteVer) {
      log(`올리려는데 드라이브 쪽이 먼저 바뀜 ${label(ch)}`);
      return 'conflict';
    }
    res = ver ? await updateFile(ch.remoteId, data) : await createFile(folder, `${CH_PREFIX}${ch.id}.json`, data);
  } else {
    res = await createFile(folder, `${CH_PREFIX}${ch.id}.json`, data);
  }
  log(`올림 ${label(ch)}`);
  await patchChapter(ch.id, (rec) => {
    rec.remoteId = res.id;
    rec.remoteVer = res.md5Checksum;
    if (rec.updatedAt === sentAt) rec.dirty = false; // 올리는 사이에 또 고쳤으면 dirty 유지
  });
  return 'ok';
}

async function storeRemoteChapter(data, file) {
  log(`받음 ${label(data)}`);
  await db.put('chapters', { ...data, remoteId: file.id, remoteVer: file.md5Checksum, dirty: false });
}

export async function addHistory(ch, reason) {
  if (!ch.body && !ch.title) return;
  await db.put('history', {
    id: uid(),
    chapterId: ch.id,
    workId: ch.workId,
    title: ch.title,
    body: ch.body,
    at: Date.now(),
    reason,
  });
}

// ───────── 작품 목록 ─────────

const worksPayload = (works, book) => ({
  works: works
    .map((w) => ({ id: w.id, title: w.title, createdAt: w.createdAt, updatedAt: w.updatedAt ?? w.createdAt }))
    .sort((a, b) => (a.id < b.id ? -1 : 1)),
  deletedWorks: book.deletedWorks,
  deletedChapters: book.deletedChapters,
});
const stable = (obj) => JSON.stringify(obj, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v));

// 새 기기에서 처음 동기화할 때, 앱이 자동으로 만든 빈 "새 작품"은 치운다(드라이브에 쓸데없는 작품이 쌓이지 않게).
async function dropPristineWorks() {
  const works = await db.getAll('works');
  const chapters = await db.getAll('chapters');
  for (const w of works) {
    const mine = chapters.filter((c) => c.workId === w.id);
    if (w.title === '새 작품' && mine.every((c) => !c.body && !c.title && !c.remoteId)) {
      for (const c of mine) await db.del('chapters', c.id);
      await db.del('works', w.id);
    }
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
  const total = [...remote.keys()].filter((n) => n.startsWith(CH_PREFIX)).length;
  log(`드라이브 파일 ${remote.size}개 (회차 ${total}개)`);
  let step = 0;

  // 1) 작품 목록 합치기
  const worksFile = remote.get('works.json');
  let remoteWorks = null;
  if (worksFile) {
    remoteWorks = await download(worksFile.id);
    if (!book.everSynced) await dropPristineWorks();
    Object.entries(remoteWorks.deletedWorks ?? {}).forEach(([id, at]) => (book.deletedWorks[id] ??= at));
    Object.entries(remoteWorks.deletedChapters ?? {}).forEach(([id, at]) => (book.deletedChapters[id] ??= at));
    const localWorks = new Map((await db.getAll('works')).map((w) => [w.id, w]));
    for (const rw of remoteWorks.works ?? []) {
      if (book.deletedWorks[rw.id]) continue;
      const lw = localWorks.get(rw.id);
      if (!lw || (rw.updatedAt ?? 0) > (lw.updatedAt ?? lw.createdAt ?? 0)) await db.put('works', rw);
    }
  }

  // 2) 지운 표시를 이 기기에 적용
  for (const w of await db.getAll('works')) if (book.deletedWorks[w.id]) await db.del('works', w.id);
  for (const c of await db.getAll('chapters')) {
    if (book.deletedChapters[c.id] || book.deletedWorks[c.workId]) {
      if (c.dirty) await addHistory(c, '다른 기기에서 지워짐');
      await db.del('chapters', c.id);
    }
  }

  // 3) 회차 맞추기
  const local = new Map((await db.getAll('chapters')).map((c) => [c.id, c]));
  const seen = new Set();
  for (const [name, file] of remote) {
    if (!name.startsWith(CH_PREFIX)) continue;
    const id = name.slice(CH_PREFIX.length, -'.json'.length);
    seen.add(id);
    hooks.progress(`회차 확인 ${++step}/${total}`);
    if (book.deletedChapters[id]) {
      await trash(file.id);
      continue;
    }
    const mine = local.get(id);

    if (!mine) {
      const data = await download(file.id);
      if (book.deletedWorks[data.workId]) await trash(file.id);
      else {
        await storeRemoteChapter(data, file);
        result.pulled++;
      }
      continue;
    }

    const remoteChanged = file.md5Checksum !== mine.remoteVer || file.id !== mine.remoteId;
    if (!remoteChanged) {
      if (mine.dirty && (await pushChapter(mine, folder)) === 'ok') result.pushed++;
      continue;
    }

    const data = await download(file.id);
    if (!mine.dirty) {
      await storeRemoteChapter(data, file);
      result.pulled++;
    } else if (sameContent(mine, data)) {
      await patchChapter(id, (rec) => Object.assign(rec, { remoteId: file.id, remoteVer: file.md5Checksum, dirty: false }));
    } else {
      // 둘 다 바뀜 → 작가가 고른다. 안 고른 쪽은 되돌리기 기록에 남긴다.
      result.conflicts++;
      log(`충돌 ${label(mine)} ↔ 드라이브 ${label(data)} — 작가 선택 대기`);
      hooks.progress('어느 버전을 쓸지 골라줘');
      const choice = await hooks.resolveConflict(mine, data);
      log(`선택: ${choice === 'remote' ? '드라이브 버전' : '이 기기 버전'}`);
      if (choice === 'remote') {
        await addHistory(mine, '충돌 · 이 기기 버전');
        await storeRemoteChapter(data, file);
        result.pulled++;
      } else {
        await addHistory(data, '충돌 · 드라이브 버전');
        const fresh = { ...mine, remoteId: file.id, remoteVer: file.md5Checksum };
        await patchChapter(id, (rec) => Object.assign(rec, { remoteId: file.id, remoteVer: file.md5Checksum }));
        if ((await pushChapter(fresh, folder)) === 'ok') result.pushed++;
      }
    }
  }
  // 드라이브에 파일이 없는 회차 → 새로 올린다(처음 올리는 회차, 또는 드라이브에서 누가 파일을 지운 경우)
  for (const [id, mine] of local) {
    if (seen.has(id)) continue;
    hooks.progress('새 회차 올리는 중');
    if ((await pushChapter({ ...mine, remoteId: null, remoteVer: null }, folder)) === 'ok') result.pushed++;
  }

  // 4) 작품 목록 올리기(드라이브 것과 다를 때만)
  const merged = worksPayload(await db.getAll('works'), book);
  const remoteSame = remoteWorks && stable(worksPayload(remoteWorks.works ?? [], { deletedWorks: remoteWorks.deletedWorks ?? {}, deletedChapters: remoteWorks.deletedChapters ?? {} })) === stable(merged);
  if (remoteSame) {
    book.worksId = worksFile.id;
    book.worksVer = worksFile.md5Checksum;
  } else {
    const res = worksFile ? await updateFile(worksFile.id, merged) : await createFile(folder, 'works.json', merged);
    book.worksId = res.id;
    book.worksVer = res.md5Checksum;
  }
  book.worksDirty = false;

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
  for (const ch of await db.getAll('chapters')) {
    if (!ch.dirty) continue;
    if ((await pushChapter(ch, folder)) === 'conflict') return { conflict: true, pushed };
    pushed++;
  }

  const fresh = await getBook();
  if (fresh.worksDirty) {
    if (fresh.worksId && (await currentVer(fresh.worksId)) !== fresh.worksVer) return { conflict: true, pushed };
    const payload = worksPayload(await db.getAll('works'), fresh);
    const res = fresh.worksId ? await updateFile(fresh.worksId, payload) : await createFile(folder, 'works.json', payload);
    Object.assign(fresh, { worksId: res.id, worksVer: res.md5Checksum, worksDirty: false });
    // 지운 회차의 드라이브 파일은 휴지통으로
    const remote = await listRemote(folder);
    for (const id of Object.keys(fresh.deletedChapters)) {
      const f = remote.get(`${CH_PREFIX}${id}.json`);
      if (f) await trash(f.id);
    }
    await setBook(fresh);
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
