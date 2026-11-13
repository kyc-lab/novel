// 기기 안 저장소(IndexedDB). 작품 / 회차 / 기타 기억할 것(meta) 세 칸으로 나눠 담는다.
// 회차는 한 편이 한 덩어리 — 나중에 드라이브에도 회차별 파일로 올리기 위해서.

const DB_NAME = 'novel-app';
const DB_VERSION = 1;

let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('works', { keyPath: 'id' });
        const chapters = db.createObjectStore('chapters', { keyPath: 'id' });
        chapters.createIndex('workId', 'workId');
        db.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
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
export const put = (store, value) => run(store, 'readwrite', (s) => s.put(value));
export const del = (store, id) => run(store, 'readwrite', (s) => s.delete(id));

export const getChaptersOf = (workId) =>
  run('chapters', 'readonly', (s) => s.index('workId').getAll(workId));

export const getMeta = (key) => run('meta', 'readonly', (s) => s.get(key));
export const setMeta = (key, value) => run('meta', 'readwrite', (s) => s.put(value, key));
