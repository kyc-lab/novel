// 초안 쓰기: 시놉/장면 뼈대 → AI 초안. 분량은 항상 "공백 포함, 줄바꿈 제외 5,500자 이상".
// AI는 글자수를 정확히 못 세니까, 받은 뒤 앱이 직접 세고 모자라면 이어 쓰게 한다.

import * as ai from './ai.js';
import { summariesText, loreText } from './context.js';

const MIN_CHARS = 5500;
const MAX_ROUNDS = 5; // 처음 1번 + 이어 쓰기 최대 4번
const count = (t) => [...t.replace(/[\r\n]/g, '')].length; // 공백 포함, 줄바꿈 제외

const SOE_BAN = `쇠맛 금지(AI 티 나는 문체를 쓰지 않는다):
- "마치 ~처럼" 비유를 남발하지 않는다.
- 감정을 직접 이름 붙여 말하지 않는다("슬펐다", "화가 났다" 대신 행동·대사·몸의 반응으로).
- 형용사·명사를 세 개씩 나열하는 버릇 금지.
- 문장 길이를 일부러 들쭉날쭉하게. 비슷한 길이의 문장을 이어 쓰지 않는다.
- 교훈조·감상조 마무리 금지.
- 번역투와 "그녀" 금지(이름이나 다른 표현으로).
- 인물이 설정을 줄줄 설명하는 대사 금지.`;

const system = (noSoe) => `너는 한국 웹소설 작가의 초안 보조다. 작가가 준 시놉/장면 뼈대로 한 회차 분량의 원고를 쓴다.
- 분량: 공백 포함 ${MIN_CHARS.toLocaleString()}자 이상. 서둘러 끝내지 말고 장면을 충분히 펼친다.
- 한국 웹소설 연재 문체: 짧은 문단, 대사와 지문의 리듬. 회차 끝은 다음 화가 궁금하게 끊는다.
- 설정 자료와 직전 회차 요약에 어긋나지 않게 쓴다. 죽은 인물, 잃은 물건, 능력·레벨을 확인한다.
- 원고 본문만 출력한다. 제목, 설명, 머리말, 맺음말 금지.
${noSoe ? SOE_BAN : ''}`;

export async function write(ctx, { synopsis, styleChapterId, noSoe, provider, onProgress }) {
  const ch = ctx.chapter();
  const no = ctx.noOf(ch);
  const prev = ctx.chapters()[no - 2];
  const style = styleChapterId ? ctx.chapters().find((c) => c.id === styleChapterId) : null;
  const usage = { input: 0, output: 0 };
  let model;
  const call = async (user) => {
    const res = await ai.ask({ system: system(noSoe), user, provider });
    usage.input += res.usage.input;
    usage.output += res.usage.output;
    model = res.model;
    return res.text.trim();
  };

  const material =
    `설정 자료(${Math.max(no - 1, 0)}화 기준):\n${await loreText(ctx, { upto: no - 1 })}\n\n` +
    `지금까지 줄거리:\n${summariesText(ctx, { upto: no - 1 }) || '없음'}\n\n` +
    `직전 회차 요약:\n${prev?.summary || '없음'}\n\n` +
    (style ? `문체 기준(이 문체를 따라 쓴다. 내용은 가져오지 않는다):\n${style.body.slice(0, 3000)}\n\n` : '');

  onProgress(1, 0);
  let text = await call(`${material}이번 회차(${no}화) 시놉/장면 뼈대:\n${synopsis}`);
  for (let round = 2; round <= MAX_ROUNDS && count(text) < MIN_CHARS; round++) {
    onProgress(round, count(text));
    const need = MIN_CHARS - count(text) + 300;
    const more = await call(
      `아래 원고에 바로 이어서 쓴다. 이미 쓴 장면을 되풀이하지 말고 이야기를 앞으로 진행한다. 이어지는 본문만 출력한다.\n` +
        `앞으로 최소 ${need.toLocaleString()}자 더 쓴다.\n\n` +
        `시놉/장면 뼈대:\n${synopsis}\n\n지금까지 쓴 원고의 끝부분:\n${text.slice(-2500)}`,
    );
    text = text.replace(/\s+$/, '') + '\n\n' + more;
  }
  return { text, chars: count(text), provider, model, cost: ai.fmtWon(ai.estimateWon(provider, model, usage)) };
}

// ───────── 화면 ─────────

const $ = (sel) => document.querySelector(sel);

function h(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...kids.filter((k) => k != null));
  return node;
}

export function initPane(ctx) {
  const el = { syn: $('#draftSyn'), style: $('#draftStyle'), noSoe: $('#draftNoSoe'), prov: $('#draftProvider'), info: $('#draftInfo'), go: $('#draftGo'), list: $('#draftList') };
  const results = []; // { id, synopsis, opts, text, chars, provider, model, cost, busy, error }

  function render() {
    // 문체 기준 회차 목록
    const chapters = ctx.chapters();
    const keepStyle = el.style.value;
    el.style.replaceChildren(new Option('없음', ''), ...chapters.map((c, i) => (c.body.trim() ? new Option(`${i + 1}화${c.title ? ' ' + c.title : ''}`, c.id) : null)).filter(Boolean));
    el.style.value = [...el.style.options].some((o) => o.value === keepStyle) ? keepStyle : '';
    // AI 회사: 준비 안 됐거나 키 없는 회사는 흐리게
    const keepProv = el.prov.value || ai.currentProvider();
    el.prov.replaceChildren(
      ...Object.entries(ai.PROVIDERS).map(([id, p]) => {
        const why = !p.ready ? ' (준비 중)' : !ai.hasKey(id) ? ' (설정에서 키 입력)' : ` · ${ai.currentModel(id)}`;
        const o = new Option(p.name + why, id, false, id === keepProv);
        o.disabled = !p.ready || !ai.hasKey(id);
        return o;
      }),
    );
    if (el.prov.selectedOptions[0]?.disabled) el.prov.value = [...el.prov.options].find((o) => !o.disabled)?.value ?? '';
    el.go.disabled = !el.prov.value;
    el.info.textContent = el.prov.value ? `공백 포함 ${MIN_CHARS.toLocaleString()}자가 넘을 때까지 이어 써.` : 'AI 키가 없어. 설정(⚙) → AI에서 키를 넣어줘.';

    el.list.replaceChildren(
      ...results.map((r) => {
        const name = ai.PROVIDERS[r.provider]?.name ?? r.provider;
        const meta = h('div', { className: 'meta' });
        if (r.busy) meta.textContent = `${name} 쓰는 중… ${r.progress ?? ''}`;
        else if (r.error) meta.textContent = `${name} · ${r.error}`;
        else meta.textContent = `${name}(${r.model}) · 공백 포함 ${r.chars.toLocaleString()}자${r.chars < MIN_CHARS ? ' (모자람)' : ''}${r.cost ? ' · ' + r.cost : ''}`;
        const card = h('li', { className: 'draft-card' }, meta);
        if (r.text) card.append(h('div', { className: 'text', textContent: r.text }));
        if (!r.busy) {
          const put = h('button', { type: 'button', className: 'mini-btn primary', textContent: '본문에 넣기', disabled: !r.text });
          put.addEventListener('click', () => ctx.insertAiText(r.text));
          const redo = h('button', { type: 'button', className: 'mini-btn', textContent: '다시 쓰기' });
          redo.addEventListener('click', () => run(r));
          const del = h('button', { type: 'button', className: 'mini-btn danger', textContent: '지우기' });
          del.addEventListener('click', () => {
            results.splice(results.indexOf(r), 1);
            render();
          });
          card.append(h('div', { className: 'proof-btns' }, del, redo, put));
        }
        return card;
      }),
    );
  }

  async function run(target) {
    const r = target ?? { id: crypto.randomUUID() };
    if (!target) {
      const synopsis = el.syn.value.trim();
      if (!synopsis) return el.syn.focus();
      Object.assign(r, { synopsis, opts: { styleChapterId: el.style.value, noSoe: el.noSoe.checked }, provider: el.prov.value });
      results.unshift(r);
    }
    Object.assign(r, { busy: true, error: '', text: '', progress: '' });
    render();
    try {
      const res = await write(ctx, {
        synopsis: r.synopsis,
        ...r.opts,
        provider: r.provider,
        onProgress: (round, chars) => {
          r.progress = round === 1 ? '' : `(이어 쓰기 ${round - 1} · 지금 ${chars.toLocaleString()}자)`;
          render();
        },
      });
      Object.assign(r, res);
    } catch (err) {
      r.error = err.message;
    } finally {
      r.busy = false;
      render();
    }
  }

  el.go.addEventListener('click', () => run());
  return { render };
}
