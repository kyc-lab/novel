// 기기 안 저장소(IndexedDB). 작품 / 회차 / 기타 기억할 것(meta) 세 칸으로 나눠 담는다.
// 회차는 한 편이 한 덩어리 — 나중에 드라이브에도 회차별 파일로 올리기 위해서.

const DB_NAME = 'novel-app';
const DB_VERSION = 5; // 2: 되돌리기 기록(history) / 3: 위키(wiki) / 4: 작법 노트(notes) / 5: 전개 회의 기록(meetings)

let dbPromise;
const blockedListeners = [];
export const onBlocked = (fn) => blockedListeners.push(fn);

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        const has = (name) => db.objectStoreNames.contains(name);
        if (!has('works')) db.createObjectStore('works', { keyPath: 'id' });
        if (!has('chapters')) {
          const chapters = db.createObjectStore('chapters', { keyPath: 'id' });
          chapters.createIndex('workId', 'workId');
        }
        if (!has('meta')) db.createObjectStore('meta');
        if (!has('history')) {
          const history = db.createObjectStore('history', { keyPath: 'id' });
          history.createIndex('chapterId', 'chapterId');
        }
        if (!has('wiki')) {
          const wiki = db.createObjectStore('wiki', { keyPath: 'id' });
          wiki.createIndex('workId', 'workId');
        }
        if (!has('notes')) db.createObjectStore('notes', { keyPath: 'id' }); // 작품과 상관없이 하나
        if (!has('meetings')) {
          const meetings = db.createObjectStore('meetings', { keyPath: 'id' });
          meetings.createIndex('workId', 'workId');
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // 다른 창이 더 새 버전의 앱으로 저장소를 올리려 하면, 이 창이 길을 비켜 주고 새로 연다.
        db.onversionchange = () => {
          db.close();
          location.reload();
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      // 예전 버전 앱이 다른 창에 열려 있어서 저장소를 못 여는 경우.
      // 그 창이 닫히면 저절로 이어서 열리므로 실패로 처리하지 않고 안내만 띄운다.
      req.onblocked = () => blockedListeners.forEach((fn) => fn());
    });
  }
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const getAll = (store) => run(store, 'readonly', (s) => s.getAll());
export const get = (store, id) => run(store, 'readonly', (s) => s.get(id));
export const put = (store, value) => run(store, 'readwrite', (s) => s.put(value));
export const del = (store, id) => run(store, 'readwrite', (s) => s.delete(id));

export const getChaptersOf = (workId) =>
  run('chapters', 'readonly', (s) => s.index('workId').getAll(workId));

export const getHistoryOf = (chapterId) =>
  run('history', 'readonly', (s) => s.index('chapterId').getAll(chapterId));

export const getWikiOf = (workId) => run('wiki', 'readonly', (s) => s.index('workId').getAll(workId));
export const getMeetingsOf = (workId) => run('meetings', 'readonly', (s) => s.index('workId').getAll(workId));

export const getMeta = (key) => run('meta', 'readonly', (s) => s.get(key));
export const setMeta = (key, value) => run('meta', 'readwrite', (s) => s.put(value, key));
