// 시험용 가짜 구글 드라이브. 앱 코드에서는 쓰지 않는다.
// 시험할 때만 브라우저에서 불러서(fetch를 가로채서) 진짜 드라이브 대신 대답하게 한다.
// 파일은 localStorage('mockDrive')에 담아 둬서 새로고침해도 남는다.

const KEY = 'mockDrive';
const load = () => JSON.parse(localStorage.getItem(KEY) ?? '{"seq":0,"files":{}}');
const save = (d) => localStorage.setItem(KEY, JSON.stringify(d));
const hash = (s) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16) + '-' + s.length;
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

export const store = { load, save, hash };
export const log = [];

export function install() {
  if (window.__mockDrive) return;
  window.__mockDrive = true;
  const real = window.fetch.bind(window);
  localStorage.setItem('driveToken', JSON.stringify({ token: 'mock', exp: Date.now() + 3600e3 }));
  localStorage.setItem('driveUser', 'mock@example.com');

  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.hostname !== 'www.googleapis.com') return real(input, init);
    const method = init.method ?? 'GET';
    const d = load();
    const upload = url.pathname.startsWith('/upload/');
    const m = url.pathname.match(/\/files\/([^/]+)$/);
    const id = m?.[1];
    log.push(`${method} ${upload ? 'upload ' : ''}${id ?? url.pathname.split('/').pop()}${url.searchParams.get('alt') ? ' media' : ''}`);

    if (url.pathname.endsWith('/about')) return json({ user: { emailAddress: 'mock@example.com' } });

    if (!id && method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      const wantFolder = q.includes('google-apps.folder');
      const files = Object.values(d.files)
        .filter((f) => !f.trashed && !!f.folder === wantFolder)
        .sort((a, b) => a.seq - b.seq)
        .map((f) => ({ id: f.id, name: f.name, md5Checksum: f.md5, modifiedTime: f.modified }));
      return json({ files });
    }

    if (!id && method === 'POST') {
      d.seq++;
      const fid = 'f' + d.seq;
      if (upload && init.body instanceof Blob) {
        // PDF 같은 파일: 내용은 담지 않고 이름과 크기만 기억한다.
        const head = await init.body.slice(0, 2000).text();
        const meta = JSON.parse(head.match(/\{.*\}/)[0]);
        d.files[fid] = { id: fid, seq: d.seq, name: meta.name, binary: true, size: init.body.size, content: '{}', md5: 'bin' + init.body.size, modified: Date.now() };
      } else if (upload) {
        const boundary = init.headers['Content-Type'].split('boundary=')[1];
        const parts = init.body.split('--' + boundary).slice(1, -1).map((p) => p.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, ''));
        const meta = JSON.parse(parts[0]);
        d.files[fid] = { id: fid, seq: d.seq, name: meta.name, content: parts[1], md5: hash(parts[1]), modified: Date.now() };
      } else {
        const meta = JSON.parse(init.body);
        d.files[fid] = { id: fid, seq: d.seq, name: meta.name, folder: true };
      }
      save(d);
      return json({ id: fid, md5Checksum: d.files[fid].md5 });
    }

    const f = d.files[id];
    if (!f) return json({ error: 'not found' }, 404);

    if (method === 'GET') {
      if (url.searchParams.get('alt') === 'media') return new Response(f.content, { status: 200 });
      return json({ id: f.id, md5Checksum: f.md5, trashed: !!f.trashed });
    }
    if (method === 'PATCH') {
      if (upload && init.body instanceof Blob) {
        f.size = init.body.size;
        f.md5 = 'bin' + f.size;
        f.modified = Date.now();
      } else if (upload) {
        f.content = init.body;
        f.md5 = hash(init.body);
        f.modified = Date.now();
      } else {
        Object.assign(f, JSON.parse(init.body));
      }
      save(d);
      return json({ id: f.id, md5Checksum: f.md5 });
    }
    return json({ error: 'unsupported' }, 400);
  };
}

// "다른 기기가 고쳤다"를 흉내 낸다: 이름으로 파일을 찾아 내용을 바꾼다.
export function remoteEdit(name, fn) {
  const d = load();
  const f = Object.values(d.files).find((x) => x.name === name && !x.trashed);
  const data = JSON.parse(f.content);
  fn(data);
  f.content = JSON.stringify(data);
  f.md5 = hash(f.content);
  save(d);
}

// "다른 기기가 새 파일을 올렸다"를 흉내 낸다.
export function remoteCreate(name, data) {
  const d = load();
  d.seq++;
  const content = JSON.stringify(data);
  d.files['f' + d.seq] = { id: 'f' + d.seq, seq: d.seq, name, content, md5: hash(content), modified: Date.now() };
  save(d);
}

export const remoteFiles = () =>
  Object.values(load().files).filter((f) => !f.folder).map((f) => ({ name: f.name, trashed: !!f.trashed, data: JSON.parse(f.content) }));
