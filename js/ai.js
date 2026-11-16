// AI 공통 호출. 회사(제미나이 / GPT / Claude)별 차이는 전부 이 파일 안에만 둔다.
// 다른 코드는 ask({ system, user }) 만 부르면 된다 → 회사를 바꿔도 다른 코드는 안 건드린다.
//
// API 키는 이 기기의 저장소에만 둔다. 드라이브·깃허브에는 절대 올리지 않는다.

import * as settings from './settings.js';

const KEYS = 'aiKeys'; // { openai: 'sk-…', … } — 이 기기에만
const TIMEOUT = 120000;

// 회사 목록. models = [모델 이름, 설명, 입력 가격, 출력 가격] (가격은 100만 토큰당 달러).
// 모델 이름·가격은 2026-11 OpenAI 가격표 기준. 바뀌면 여기만 고치면 된다.
export const PROVIDERS = {
  openai: {
    name: 'GPT',
    ready: true,
    defaultModel: 'gpt-6.1-terra',
    models: [
      ['gpt-6.1-terra', '균형 · 추천', 1.0, 5.0],
      ['gpt-6-luna', '가장 저렴', 0.1, 0.5],
      ['gpt-6.1-sol', '고급 · 비쌈', 2.0, 10.0],
    ],
  },
  gemini: { name: '제미나이', ready: false, defaultModel: '', models: [] },
  claude: { name: 'Claude', ready: false, defaultModel: '', models: [] },
};

// ───────── 키 ─────────

function readKeys() {
  try {
    return JSON.parse(localStorage.getItem(KEYS)) ?? {};
  } catch {
    return {};
  }
}
export const getKey = (provider) => readKeys()[provider] ?? '';
export const hasKey = (provider) => !!getKey(provider);
export function setKey(provider, key) {
  const keys = readKeys();
  if (key) keys[provider] = key.trim();
  else delete keys[provider];
  localStorage.setItem(KEYS, JSON.stringify(keys));
}
// 화면에 보여줄 때는 앞뒤 몇 글자만
export function maskKey(provider) {
  const k = getKey(provider);
  return k ? `${k.slice(0, 5)}…${k.slice(-4)}` : '';
}

// 쓴 토큰으로 대략의 원화 비용을 계산한다. 가격을 모르는 모델이면 null.
const KRW_PER_USD = 1400;
export function estimateWon(provider, model, usage) {
  const row = PROVIDERS[provider]?.models.find(([id]) => id === model);
  if (!row) return null;
  const usd = (usage.input * row[2] + usage.output * row[3]) / 1e6;
  return usd * KRW_PER_USD;
}
export const fmtWon = (won) => (won == null ? '' : won < 1 ? '1원 미만' : `약 ${Math.round(won).toLocaleString('ko-KR')}원`);

export const currentProvider = () => settings.get().aiProvider;
export const currentModel = (provider = currentProvider()) =>
  settings.get().aiModels?.[provider] || PROVIDERS[provider].defaultModel;

// ───────── 호출 ─────────

async function request(url, options) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (err) {
    throw new Error(ctrl.signal.aborted ? 'AI 응답이 너무 늦어(2분 초과).' : 'AI에 연결하지 못했어. 인터넷을 확인해줘.');
  } finally {
    clearTimeout(timer);
  }
}

// 오류를 작가가 알아볼 말로 바꾼다.
async function explain(res, providerName) {
  let detail = '';
  let code = '';
  try {
    const body = await res.json();
    detail = body.error?.message ?? '';
    code = body.error?.code ?? body.error?.type ?? '';
  } catch {
    // 본문이 없으면 상태 번호만으로 설명
  }
  if (res.status === 401) return `${providerName} 키가 맞지 않아. 설정에서 키를 다시 넣어줘.`;
  if (res.status === 429 && /quota|billing/i.test(code + detail)) return `${providerName} 충전 금액이 없거나 월 한도에 닿았어. 결제 설정을 확인해줘.`;
  if (res.status === 429) return `${providerName} 요청이 너무 잦아. 잠깐 뒤에 다시 해줘.`;
  if (res.status === 404) return `고른 모델을 쓸 수 없어. 설정에서 다른 모델을 골라줘. (${detail})`;
  return `${providerName} 오류 ${res.status}: ${detail || '알 수 없는 오류'}`;
}

const openai = {
  headers: (key) => ({ Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }),

  async ask({ key, model, system, user, json, effort }) {
    // JSON으로 받으려면 GPT는 "질문 본문"에 json이라는 말이 꼭 있어야 한다(지시문에만 있으면 거절).
    const input = json && !/json/i.test(user) ? `${user}\n\n(답은 JSON 객체 하나로)` : user;
    const body = { model, input };
    if (system) body.instructions = system;
    if (json) body.text = { format: { type: 'json_object' } };
    // 생각을 짧게 하라고 하면 빠르고 싸다. 모델이 이 옵션을 모르면 빼고 다시 보낸다.
    if (effort) body.reasoning = { effort };
    const send = () =>
      request('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: this.headers(key),
        body: JSON.stringify(body),
      });
    let res = await send();
    if (res.status === 400 && body.reasoning) {
      const text = await res.clone().text();
      if (/reasoning|effort/i.test(text)) {
        delete body.reasoning;
        res = await send();
      }
    }
    if (!res.ok) throw new Error(await explain(res, 'GPT'));
    const data = await res.json();
    // 답은 여러 조각으로 온다. 글자 조각만 모은다.
    const text = (data.output ?? [])
      .flatMap((item) => (item.type === 'message' ? item.content ?? [] : []))
      .filter((part) => part.type === 'output_text')
      .map((part) => part.text)
      .join('');
    return {
      text,
      usage: { input: data.usage?.input_tokens ?? 0, output: data.usage?.output_tokens ?? 0 },
    };
  },

  // 이 키로 쓸 수 있는 모델 이름들
  async listModels(key) {
    const res = await request('https://api.openai.com/v1/models', { headers: this.headers(key) });
    if (!res.ok) throw new Error(await explain(res, 'GPT'));
    const data = await res.json();
    return (data.data ?? []).map((m) => m.id);
  },
};

const ADAPTERS = { openai };

// AI에게 묻는다. { system: 역할·규칙, user: 내용, json: 답을 JSON으로 받을지 }
// 돌려주는 것: { text, usage: { input, output }, provider, model }
export async function ask({ system = '', user, json = false, effort, provider = currentProvider(), model }) {
  const info = PROVIDERS[provider];
  const adapter = ADAPTERS[provider];
  if (!info?.ready || !adapter) throw new Error(`${info?.name ?? provider}는 아직 준비 중이야. 설정에서 다른 회사를 골라줘.`);
  const key = getKey(provider);
  if (!key) throw new Error(`${info.name} API 키가 없어. 설정에서 키를 넣어줘.`);
  const useModel = model || currentModel(provider);
  const result = await adapter.ask({ key, model: useModel, system, user, json, effort });
  return { ...result, provider, model: useModel };
}

export async function listModels(provider = currentProvider()) {
  const adapter = ADAPTERS[provider];
  if (!adapter) return [];
  return adapter.listModels(getKey(provider));
}

// ───────── 설정 창의 AI 칸 ─────────

export function initPanel(dialog) {
  const $ = (sel) => dialog.querySelector(sel);
  const keyInput = $('#aiKey');
  const keyState = $('#aiKeyState');
  const modelSel = $('#aiModel');
  const testBtn = $('#aiTest');
  const testMsg = $('#aiTestMsg');
  let extraModels = []; // 연결 시험 때 받아온, 이 키로 쓸 수 있는 다른 모델들

  function render() {
    const provider = currentProvider();
    const info = PROVIDERS[provider];
    for (const radio of dialog.querySelectorAll('input[name="aiProvider"]')) {
      radio.disabled = !PROVIDERS[radio.value].ready;
      radio.checked = radio.value === provider;
    }
    keyState.textContent = hasKey(provider)
      ? `${info.name} 키 저장됨 (${maskKey(provider)}) · 이 기기에만 있어`
      : `${info.name} 키가 아직 없어. 키를 붙여넣고 "저장"을 눌러줘.`;
    $('#aiKeyDel').hidden = !hasKey(provider);

    const chosen = currentModel(provider);
    const known = info.models.map(([id]) => id);
    const options = info.models.map(([id, note, inP, outP]) => new Option(`${id} — ${note} ($${inP}/$${outP})`, id));
    for (const id of [chosen, ...extraModels]) {
      if (id && !known.includes(id)) {
        known.push(id);
        options.push(new Option(id, id));
      }
    }
    modelSel.replaceChildren(...options);
    modelSel.value = chosen;
  }

  $('#aiKeySave').addEventListener('click', () => {
    const key = keyInput.value.trim();
    if (!key) return;
    setKey(currentProvider(), key);
    keyInput.value = '';
    testMsg.textContent = '키를 저장했어. "연결 시험"을 눌러서 되는지 확인해봐.';
    render();
  });
  $('#aiKeyDel').addEventListener('click', () => {
    setKey(currentProvider(), '');
    testMsg.textContent = '';
    render();
  });
  modelSel.addEventListener('change', () => {
    settings.update({ aiModels: { ...(settings.get().aiModels ?? {}), [currentProvider()]: modelSel.value } });
  });
  for (const radio of dialog.querySelectorAll('input[name="aiProvider"]')) {
    radio.addEventListener('change', () => setTimeout(render)); // 설정에 반영된 다음 다시 그린다
  }

  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    testMsg.classList.remove('warn');
    testMsg.textContent = '물어보는 중…';
    try {
      const res = await ask({ user: '연결 시험이야. "연결됐어" 한 마디만 답해줘.' });
      testMsg.textContent = `됐어. ${PROVIDERS[res.provider].name}(${res.model})의 답: "${res.text.trim().slice(0, 40)}"`;
      // 이 키로 쓸 수 있는 모델을 목록에 더한다(글 쓰는 모델만).
      try {
        extraModels = (await listModels())
          .filter((id) => /^gpt-\d/.test(id) && !/audio|realtime|image|tts|transcribe|embedding|search|codex|instruct/.test(id))
          .sort()
          .reverse();
        render();
      } catch {
        // 모델 목록을 못 받아와도 연결은 된 것
      }
    } catch (err) {
      testMsg.classList.add('warn');
      testMsg.textContent = err.message;
    } finally {
      testBtn.disabled = false;
    }
  });

  dialog.addEventListener('toggle', render);
  render();
  return { render };
}
