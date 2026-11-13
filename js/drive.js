// 구글 드라이브 연결: 로그인(허락 받기)과 드라이브 호출을 한 곳에 모은다.
// 권한은 drive.file — 이 앱이 직접 만든 파일·폴더만 읽고 쓸 수 있다(드라이브의 다른 파일은 못 봄).

import { GOOGLE_CLIENT_ID, DRIVE_FOLDER_NAME } from './config.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const TOKEN_KEY = 'driveToken'; // 출입증(1시간짜리). 이 기기에만 저장.
const FOLDER_KEY = 'driveFolderId';
const USER_KEY = 'driveUser';
const API = 'https://www.googleapis.com/drive/v3';

export class NeedSignIn extends Error {}

const listeners = [];
export const onChange = (fn) => listeners.push(fn);
const notify = () => listeners.forEach((fn) => fn());

// ───────── 출입증(토큰) ─────────

function readToken() {
  try {
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY));
    return t && t.exp > Date.now() ? t.token : null;
  } catch {
    return null;
  }
}

export const isConfigured = () => !!GOOGLE_CLIENT_ID;
export const isSignedIn = () => !!readToken();
// 한 번이라도 연결한 적이 있는지(출입증이 만료돼도 true)
export const wasConnected = () => !!localStorage.getItem(USER_KEY);
export const userEmail = () => localStorage.getItem(USER_KEY) ?? '';

// 구글 로그인 도구는 구글 서버에서만 받을 수 있다(인터넷 될 때만 필요).
let gisPromise;
function loadGis() {
  gisPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = resolve;
    s.onerror = () => {
      gisPromise = null;
      reject(new Error('구글 로그인 도구를 못 불러왔어. 인터넷 연결을 확인해줘.'));
    };
    document.head.append(s);
  });
  return gisPromise;
}

let tokenClient;
let pending = null; // 지금 열려 있는 로그인 창의 결과를 기다리는 중

// 로그인 창을 띄워 출입증을 받는다. 반드시 버튼을 누른 직후에 불러야 창이 막히지 않는다.
export async function signIn() {
  if (!isConfigured()) throw new Error('아직 구글 클라이언트 ID가 앱에 안 들어가 있어.');
  await loadGis();
  tokenClient ??= google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: SCOPE,
    callback: (res) => {
      if (res.error) return pending?.reject(new Error(res.error_description || res.error));
      if (!google.accounts.oauth2.hasGrantedAllScopes(res, SCOPE)) {
        return pending?.reject(new Error('드라이브 접근을 허락하지 않았어. 다시 연결하면서 체크해줘.'));
      }
      const exp = Date.now() + (Number(res.expires_in) - 60) * 1000;
      localStorage.setItem(TOKEN_KEY, JSON.stringify({ token: res.access_token, exp }));
      pending?.resolve();
    },
    error_callback: (err) => {
      const msg =
        err.type === 'popup_closed' ? '로그인 창이 닫혔어.'
        : err.type === 'popup_failed_to_open' ? '로그인 창이 막혔어. 팝업 차단을 풀어줘.'
        : err.message || '로그인에 실패했어.';
      pending?.reject(new Error(msg));
    },
  });

  await new Promise((resolve, reject) => {
    pending = { resolve, reject };
    // 처음엔 허락 화면이 나오고, 이미 허락했으면 계정만 고르면 된다.
    tokenClient.requestAccessToken({ prompt: '', login_hint: userEmail() || undefined });
  }).finally(() => (pending = null));

  const about = await call('/about?fields=user(emailAddress)');
  localStorage.setItem(USER_KEY, about.user.emailAddress);
  notify();
}

export function signOut() {
  const token = readToken();
  if (token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token, () => {});
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(FOLDER_KEY);
  notify();
}

// ───────── 드라이브 호출 ─────────

// 드라이브에 요청을 보낸다. 출입증이 없거나 만료됐으면 NeedSignIn.
export async function call(path, { method = 'GET', body, headers = {}, raw = false, base = API } = {}) {
  const token = readToken();
  if (!token) throw new NeedSignIn('드라이브 연결이 필요해.');
  // 응답이 20초 넘게 안 오면 끊고 실패로 처리한다(끝없이 기다리며 멈추지 않게).
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let res;
  try {
    res = await fetch(base + path, {
      method,
      headers: { Authorization: 'Bearer ' + token, ...headers },
      body,
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new Error(ctrl.signal.aborted ? '드라이브 응답이 너무 늦어(20초 초과)' : '드라이브에 연결 못 함: ' + err.message);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    notify();
    throw new NeedSignIn('드라이브 연결이 끊겼어. 다시 연결해줘.');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`드라이브 오류 ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  if (raw) return res;
  return res.status === 204 ? null : res.json();
}

// 앱 폴더의 ID. 없으면 만든다.
export async function ensureFolder() {
  const saved = localStorage.getItem(FOLDER_KEY);
  if (saved) return saved;
  const q = encodeURIComponent(
    `name = '${DRIVE_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
  );
  const found = await call(`/files?q=${q}&fields=files(id,name,createdTime)&orderBy=createdTime`);
  let id = found.files[0]?.id;
  if (!id) {
    const created = await call('/files?fields=id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: DRIVE_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
    });
    id = created.id;
  }
  localStorage.setItem(FOLDER_KEY, id);
  return id;
}
