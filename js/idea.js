// 트렌드 자료 + 아이디어 검토 회의 (전개 회의실 안의 두 모드)
//
// 트렌드 자료: 문피아 무료·유료 베스트 상위 50을 작가가 복사해 붙여넣으면 AI가 정리해서 날짜와 함께 보관한다.
//   (이 앱은 서버가 없어서 문피아 페이지를 직접 읽어 올 수 없다.)
//   하나 = { id, source: 'munpia-free'|'munpia-paid', date, raw, items: [{ rank, title, genre, tags }],
//           summary: { genres: [{ name, count }], keywords: [], tropes: [], notes }, createdAt }
//
// 아이디어 검토: 작가의 아이디어를 관점이 다른 평가자 셋이 평가 → 서로 교차 검토 → 진행자가 정리.
//   기록은 회의 기록(meetings)에 kind: 'idea' 로 같이 저장한다.

import * as db from './db.js';
import * as ai from './ai.js';
import { summariesText, loreText } from './context.js';
import { activeTips, normGenre } from './notes.js';
import { roles } from './meeting.js';
import { askConfirm } from './dialogs.js';

export const SOURCES = {
  'munpia-free': { name: '문피아 무료 베스트', short: '무료' },
  'munpia-paid': { name: '문피아 유료 베스트', short: '유료' },
};
const STALE_DAYS = 14; // 이보다 오래된 자료는 갱신하라고 알린다

const ANGLES = [
  { angle: '독자 반응', hint: '첫 화와 초반 30화에서 독자가 끌릴 지점과 이탈할 지점. 연재 플랫폼 독자 입장에서.' },
  { angle: '시장성·트렌드', hint: '주어진 문피아 상위 50 자료와 비교해서 흔한지 신선한지, 지금 먹히는 요소가 있는지, 비슷한 상위 작품이 있는지.' },
  { angle: '위험·개연성', hint: '설정 충돌, 개연성 구멍, 연재가 길어질 때 무너질 지점, 소재가 빨리 바닥날 위험.' },
];
const SCOPES = ['작품 콘셉트', '앞으로의 큰 전개', '새 인물·설정', '기타'];

const uid = () => crypto.randomUUID();
const $ = (sel) => document.querySelector(sel);
const parse = (text) => {
  try {
    return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch {
    return {};
  }
};
const arr = (x) => (Array.isArray(x) ? x : []);
const score = (x) => Math.min(5, Math.max(1, Math.round(Number(x)) || 3));
const days = (t) => Math.floor((Date.now() - t) / 86400000);
const today = () => new Date().toLocaleDateString('sv-SE'); // 2026-11-17 모양

function h(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...kids.flat().filter((k) => k != null && k !== false));
  return node;
}

// ───────── 트렌드 자료 ─────────

const PARSE = (name) => `너는 웹소설 시장 분석가다. 작가가 "${name}" 상위 목록을 웹페이지에서 복사해 붙여넣었다. 순위, 제목, 작가, 태그, 소개글, 조회수 같은 것이 뒤섞여 있다.
1. items: 순위대로 최대 50개. {"rank":순위,"title":"제목","genre":"장르","tags":["핵심 태그·소재 3개 이내"]}
   genre 는 현대판타지 / 판타지 / 무협 / 로맨스판타지 / 대체역사 / 스포츠 / SF / 라이트노벨 / 기타 중 가장 가까운 것.
   붙여넣은 글에 없는 작품을 지어내지 않는다.
2. summary:
   - genres: [{"name":"장르","count":작품 수}] 많은 순
   - keywords: 자주 나오는 소재·키워드 10개
   - tropes: 반복되는 설정·전개 패턴 5~8개 (예: 회귀, 빙의, 상태창, 재벌, 천재, 사이다 복수 …)
   - notes: 눈에 띄는 흐름 2~3문장
출력은 JSON 객체 하나: {"items":[],"summary":{"genres":[],"keywords":[],"tropes":[],"notes":""}}`;

export async function latestTrends() {
  const all = await db.getAll('trends');
  const pick = (src) => all.filter((t) => t.source === src).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
  return { free: pick('munpia-free'), paid: pick('munpia-paid') };
}

// 회의 자료에 넣을 트렌드 글
export function trendText({ free, paid }) {
  const one = (t, src) => {
    if (!t) return `${SOURCES[src].name}: 자료 없음`;
    const s = t.summary ?? {};
    return (
      `${SOURCES[src].name} 상위 ${t.items.length}개 (${t.date} 기준)\n` +
      `장르 분포: ${arr(s.genres).map((g) => `${g.name} ${g.count}`).join(', ')}\n` +
      `자주 나오는 소재: ${arr(s.keywords).join(', ')}\n` +
      `반복 패턴: ${arr(s.tropes).join(', ')}\n` +
      (s.notes ? `흐름: ${s.notes}\n` : '') +
      `목록: ${t.items.map((x) => `${x.rank}. ${x.title}[${x.genre}${arr(x.tags).length ? ' · ' + x.tags.join('/') : ''}]`).join(' ')}`
    );
  };
  return `${one(free, 'munpia-free')}\n\n${one(paid, 'munpia-paid')}`;
}

// ───────── 아이디어 검토 ─────────

const EVAL = (angle, hint) => `너는 웹소설 기획 회의의 평가자다. 너의 관점은 "${angle}": ${hint}
작가의 아이디어를 평가한다. 고쳐 쓰거나 새 아이디어를 내지 말고 평가만 한다.
트렌드 이야기는 반드시 주어진 "문피아 상위 50" 자료를 근거로 한다. 자료에 없는 유행을 지어내지 않는다. 자료가 없으면 없다고 말한다.
- verdict: ○(좋음) / △(보완 필요) / ✕(어려움)
- fit: 네 관점에서의 점수 1~5
- good: 좋은 점 2~4개, bad: 걱정되는 점 2~4개 (각 한 줄, 구체적으로)
- evidence: 근거 한두 줄 (트렌드 자료의 작품 제목·패턴, 작품 설정 등)
출력은 JSON 객체 하나: {"verdict":"△","fit":3,"good":[],"bad":[],"evidence":""}`;

const CROSS = `너는 웹소설 기획 회의의 검토자다. 다른 평가자의 평가를 읽고 동의하는 점과 반박할 점을 짧게 말한다. 새 아이디어를 내지 않는다.
출력은 JSON 객체 하나: {"reviews":[{"n":평가 번호,"agree":"한 줄","disagree":"한 줄"}]}`;

const SUMMARY = `너는 웹소설 기획 회의의 진행자다. 아이디어에 대한 평가들과 교차 검토를 정리한다. 아이디어를 새로 쓰지 않는다.
- strengths: 강점 3개, weaknesses: 약점 3개
- fixes: 살리려면 바꾸거나 보강할 점 3~5개 (구체적으로)
- trendFit: 문피아 상위 50 자료 기준 트렌드 적합도 1~5, trendNote: 근거 (비슷한 상위 작품이 있으면 제목)
- opinion: 진행자 한 줄 의견
출력은 JSON 객체 하나: {"strengths":[],"weaknesses":[],"fixes":[],"trendFit":3,"trendNote":"","opinion":""}`;

function reviewerFor(providers, provider) {
  return providers.find((p) => p !== provider) ?? provider;
}

export async function review(ctx, { idea, scope, genre = '' }, onStep) {
  const R = roles();
  // 평가자 세 관점은 회의실 역할의 세 자리(과감한 전개·떡밥 회수·감정선 담당 회사)를 그대로 쓴다.
  const evaluators = ANGLES.map((a, i) => ({ ...a, provider: R.writers[i]?.provider ?? R.host }));
  const providers = evaluators.map((e) => e.provider);
  for (const p of new Set([R.host, ...providers])) if (!ai.hasKey(p)) throw new Error(`${ai.PROVIDERS[p].name} 키가 없어. 설정(⚙) → AI → 키·모델 관리에서 넣거나, 전개 회의의 "역할 바꾸기"에서 바꿔줘.`);

  const usage = {};
  const call = async (provider, system, user) => {
    const res = await ai.ask({ provider, system, user, json: true });
    const u = (usage[provider] ??= { input: 0, output: 0, model: res.model });
    u.input += res.usage.input;
    u.output += res.usage.output;
    return parse(res.text);
  };

  onStep('자료 모으는 중');
  const trends = await latestTrends();
  const hasWork = ctx.chapters().some((c) => c.body.trim());
  // 장르를 적으면(새 작품 아이디어 등) 그 장르 팁, 비우면 지금 작품 장르 팁
  const tips = await activeTips(ctx.workId(), ctx.chapters().length + 1, genre ? { genre } : {});
  const material =
    `검토할 아이디어 (${scope}${genre ? ` · ${genre}` : ''}):\n${idea}\n\n` +
    `트렌드 자료(문피아 상위 50):\n${trendText(trends)}\n\n` +
    (hasWork ? `지금 작품의 줄거리:\n${summariesText(ctx) || '없음'}\n\n지금 작품의 설정:\n${await loreText(ctx, { max: 5000 })}\n\n` : '지금 작품: 아직 원고 없음\n\n') +
    `작가의 작법 팁:\n${tips.map((t, i) => `${i + 1}. ${t.rule}`).join('\n') || '없음'}`;

  onStep(`평가하는 중 (0/${evaluators.length})`);
  let done = 0;
  const evals = await Promise.all(
    evaluators.map(async (e) => {
      const r = await call(e.provider, EVAL(e.angle, e.hint), material);
      onStep(`평가하는 중 (${++done}/${evaluators.length})`);
      return {
        by: e.provider,
        angle: e.angle,
        verdict: ['○', '△', '✕'].includes(r.verdict) ? r.verdict : '△',
        fit: score(r.fit),
        good: arr(r.good).map(String),
        bad: arr(r.bad).map(String),
        evidence: String(r.evidence ?? ''),
      };
    }),
  );
  const describe = (e, i) => `평가 ${i + 1} [${e.angle}] ${e.verdict} ${e.fit}점\n좋은 점: ${e.good.join(' / ')}\n걱정: ${e.bad.join(' / ')}\n근거: ${e.evidence}`;

  onStep('서로의 평가를 검토하는 중');
  const byReviewer = new Map();
  evals.forEach((e, i) => {
    const rv = reviewerFor(providers, e.by);
    if (!byReviewer.has(rv)) byReviewer.set(rv, []);
    byReviewer.get(rv).push(i);
  });
  await Promise.all(
    [...byReviewer].map(async ([rv, idx]) => {
      const c = await call(rv, CROSS, `${material}\n\n검토할 평가:\n${idx.map((i) => describe(evals[i], i)).join('\n\n')}`);
      for (const x of arr(c.reviews)) {
        const i = Number(x.n) - 1;
        if (idx.includes(i)) evals[i].review = { by: rv, agree: String(x.agree ?? ''), disagree: String(x.disagree ?? '') };
      }
    }),
  );

  onStep('진행자가 정리하는 중');
  const list = evals
    .map((e, i) => describe(e, i) + (e.review ? `\n검토(${ai.PROVIDERS[e.review.by]?.name}): 동의 ${e.review.agree} · 반박 ${e.review.disagree}` : ''))
    .join('\n\n');
  const s = await call(R.host, SUMMARY, `${material}\n\n평가와 교차 검토:\n${list}`);

  let won = 0;
  for (const [p, u] of Object.entries(usage)) won += ai.estimateWon(p, u.model, u) ?? 0;
  return {
    id: uid(),
    workId: ctx.workId(),
    kind: 'idea',
    idea,
    scope,
    genre,
    evals,
    summary: {
      strengths: arr(s.strengths).map(String),
      weaknesses: arr(s.weaknesses).map(String),
      fixes: arr(s.fixes).map(String),
      trendFit: score(s.trendFit),
      trendNote: String(s.trendNote ?? ''),
      opinion: String(s.opinion ?? ''),
    },
    trends: { free: trends.free?.date ?? null, paid: trends.paid?.date ?? null },
    memo: '',
    cost: ai.fmtWon(won),
    createdAt: Date.now(),
  };
}

// ───────── 화면 ─────────

export function init(ctx) {
  const el = {
    text: $('#idText'),
    scope: $('#idScope'),
    start: $('#idStart'),
    history: $('#idHistory'),
    status: $('#idStatus'),
    result: $('#idResult'),
    trends: $('#trendCards'),
  };
  el.scope.replaceChildren(...SCOPES.map((s) => new Option(s, s)));
  let records = [];
  let current = null;
  let busy = false;

  const save = async (rec, store = 'meetings') => {
    rec.updatedAt = Date.now();
    rec.dirty = true;
    await db.put(store, rec);
    ctx.onChange();
  };

  // ── 트렌드 자료 카드 ──
  // 붙여넣기 또는 스크린샷 → AI가 목록을 뽑음 → 저장 전에 표로 확인·수정 → 저장
  const drafts = {}; // 출처별로 확인 중인 결과 { items, summary, raw, costText, by }
  let reader = null; // 목록·사진을 읽을 AI(기본: AI 담당)

  async function extract(src, { text = '', images = [] }) {
    const info = SOURCES[src];
    const provider = reader && ai.hasKey(reader) ? reader : ai.currentProvider();
    if (!ai.hasKey(provider)) throw new Error('AI 키가 없어. 설정(⚙) → AI에서 키를 넣어줘.');
    const user = images.length
      ? `${info.name} 상위 목록 스크린샷 ${images.length}장이야. 여러 장에 같은 순위가 겹쳐 찍혔으면 하나로 합친다. 사진에서 읽을 수 없는 글자는 추측하지 말고 보이는 만큼만 쓴다.`
      : `붙여넣은 목록:\n${text}`;
    const res = await ai.ask({ provider, system: PARSE(info.name), user, json: true, images, effort: images.length ? undefined : 'low' });
    const d = parse(res.text);
    const items = arr(d.items)
      .filter((x) => x && x.title)
      .map((x, i) => ({ rank: Number(x.rank) || i + 1, title: String(x.title).trim(), genre: String(x.genre ?? '기타'), tags: arr(x.tags).map(String).slice(0, 3) }))
      .sort((a, b) => a.rank - b.rank)
      .filter((x, i, all) => all.findIndex((y) => y.rank === x.rank) === i) // 겹친 순위는 하나만
      .slice(0, 50);
    if (!items.length) throw new Error(images.length ? '사진에서 작품 목록을 못 읽었어. 순위와 제목이 보이게 찍었는지 봐줘.' : '목록에서 작품을 못 찾았어. 순위와 제목이 들어간 부분을 복사했는지 봐줘.');
    const s = d.summary ?? {};
    return {
      items,
      summary: {
        genres: arr(s.genres).map((g) => ({ name: String(g.name), count: Number(g.count) || 0 })),
        keywords: arr(s.keywords).map(String),
        tropes: arr(s.tropes).map(String),
        notes: String(s.notes ?? ''),
      },
      raw: text || `(스크린샷 ${images.length}장)`,
      costText: ai.fmtWon(ai.estimateWon(res.provider, res.model, res.usage)),
      by: res.provider,
    };
  }

  // 사진을 글씨가 읽힐 정도로만 줄여서 JPEG로 바꾼다(비용·전송량 절약).
  async function shrink(file) {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / bmp.width, 2600 / bmp.height);
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    const url = c.toDataURL('image/jpeg', 0.85);
    return { mime: 'image/jpeg', data: url.slice(url.indexOf(',') + 1) };
  }

  // 저장 전 확인 표: 순위·제목·장르·태그를 고치거나 뺄 수 있다.
  function draftTable(src) {
    const d = drafts[src];
    const rows = d.items.map((x) => {
      const rank = h('input', { type: 'number', value: x.rank, className: 'tr-rank' });
      rank.addEventListener('input', () => (x.rank = Number(rank.value) || x.rank));
      const title = h('input', { type: 'text', value: x.title, className: 'tr-title' });
      title.addEventListener('input', () => (x.title = title.value.trim()));
      const genre = h('input', { type: 'text', value: x.genre, className: 'tr-genre' });
      genre.addEventListener('input', () => (x.genre = genre.value.trim() || '기타'));
      const tags = h('input', { type: 'text', value: x.tags.join(', '), className: 'tr-tags' });
      tags.addEventListener('input', () => (x.tags = tags.value.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 3)));
      const del = h('button', { type: 'button', className: 'st-del', textContent: '✕', title: '이 줄 빼기' });
      del.addEventListener('click', () => {
        d.items = d.items.filter((y) => y !== x);
        renderTrends();
      });
      return h('tr', {}, h('td', {}, rank), h('td', {}, title), h('td', {}, genre), h('td', {}, tags), h('td', {}, del));
    });
    const ok = h('button', { type: 'button', className: 'mini-btn primary', textContent: `${d.items.length}개 저장` });
    ok.addEventListener('click', async () => {
      const items = d.items.filter((x) => x.title).sort((a, b) => a.rank - b.rank).slice(0, 50);
      await save({ id: uid(), source: src, date: today(), raw: d.raw, items, summary: d.summary, createdAt: Date.now() }, 'trends');
      delete drafts[src];
      renderTrends();
    });
    const cancel = h('button', { type: 'button', className: 'mini-btn', textContent: '취소' });
    cancel.addEventListener('click', () => {
      delete drafts[src];
      renderTrends();
    });
    const missing = 50 - d.items.length;
    return h('div', { className: 'tr-draft' },
      h('p', { className: 'hint', textContent: `${ai.PROVIDERS[d.by]?.name ?? ''}가 ${d.items.length}개를 읽었어${d.costText ? ` · ${d.costText}` : ''}. 잘못 읽은 제목은 고치고, 이상한 줄은 ✕로 빼고 저장해.${missing > 0 ? ` (50개 중 ${missing}개가 비어 있어. 취소하고 빠진 부분까지 다시 올려도 돼.)` : ''}` }),
      h('div', { className: 'tr-table-wrap' }, h('table', { className: 'tr-table' }, h('tr', {}, ['순위', '제목', '장르', '태그', ''].map((t) => h('th', { textContent: t }))), rows)),
      h('div', { className: 'proof-btns' }, cancel, ok));
  }

  async function renderTrends() {
    const latest = await latestTrends();
    // 목록·사진을 읽을 AI 고르기
    const pick = h('select', { className: 'pick' });
    for (const [id, p] of Object.entries(ai.PROVIDERS)) {
      const o = new Option(p.name + (ai.hasKey(id) ? ` · ${ai.currentModel(id)}` : ' (키 없음)'), id, false, id === (reader ?? ai.currentProvider()));
      o.disabled = !p.ready || !ai.hasKey(id);
      pick.append(o);
    }
    pick.addEventListener('change', () => (reader = pick.value));
    el.trends.replaceChildren(
      h('label', { className: 'row tr-reader' }, h('span', { textContent: '목록·사진을 읽을 AI' }), pick),
      ...Object.entries(SOURCES).map(([src, info]) => {
        const t = src === 'munpia-free' ? latest.free : latest.paid;
        const stale = t && days(t.createdAt) >= STALE_DAYS;
        const msg = h('p', { className: 'hint' });
        const raw = h('textarea', { className: 'pane-input', rows: 5, placeholder: `${info.name} 페이지에서 1위~50위를 드래그해서 복사한 다음 여기에 붙여넣어. 소개글·조회수가 섞여도 괜찮아.` });
        const go = h('button', { type: 'button', className: 'mini-btn primary', textContent: '붙여넣은 글 정리' });
        const file = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
        const shot = h('button', { type: 'button', className: 'mini-btn primary', textContent: '스크린샷 올리기' });
        const busyOn = (on, text = '') => {
          go.disabled = on;
          shot.disabled = on;
          msg.textContent = text;
        };
        const run = async (input) => {
          busyOn(true, input.images?.length ? `AI가 스크린샷 ${input.images.length}장을 읽는 중… (1분쯤 걸릴 수 있어)` : 'AI가 목록을 정리하는 중…');
          try {
            drafts[src] = await extract(src, input);
            renderTrends();
          } catch (err) {
            busyOn(false, err.message);
          }
        };
        go.addEventListener('click', () => (raw.value.trim() ? run({ text: raw.value.trim() }) : raw.focus()));
        shot.addEventListener('click', () => file.click());
        file.addEventListener('change', async () => {
          const files = [...file.files].slice(0, 12);
          file.value = '';
          if (!files.length) return;
          busyOn(true, `사진 ${files.length}장 준비하는 중…`);
          try {
            await run({ images: await Promise.all(files.map(shrink)) });
          } catch (err) {
            busyOn(false, `사진을 읽지 못했어: ${err.message}`);
          }
        });
        const s = t?.summary;
        return h('section', { className: 'proof-item tr-card' + (stale ? ' hook-old' : '') },
          h('h3', { className: 'pane-h', textContent: info.name }),
          t
            ? h('div', {},
                h('p', { className: stale ? 'mt-warn' : 'hint', textContent: `${t.date} 기준 · ${t.items.length}개 · ${days(t.createdAt)}일 전${stale ? ` · ${STALE_DAYS}일이 넘었어, 갱신해줘` : ''}` }),
                h('p', {}, h('b', { textContent: '장르 ' }), arr(s.genres).map((g) => `${g.name} ${g.count}`).join(' · ')),
                h('p', {}, h('b', { textContent: '소재 ' }), arr(s.keywords).join(', ')),
                h('p', {}, h('b', { textContent: '패턴 ' }), arr(s.tropes).join(', ')),
                s.notes ? h('p', { className: 'hint', textContent: s.notes }) : null,
                h('details', { className: 'pane-details' }, h('summary', { textContent: '목록 보기' }), h('ol', { className: 'mt-list' }, t.items.map((x) => h('li', { textContent: `${x.title} · ${x.genre}${x.tags.length ? ' · ' + x.tags.join('/') : ''}` })))))
            : h('p', { className: 'hint', textContent: '아직 자료가 없어.' }),
          drafts[src]
            ? draftTable(src)
            : h('details', { className: 'pane-details', open: !t || stale },
                h('summary', { textContent: t ? '새로 갱신하기' : '자료 넣기' }),
                h('div', { className: 'proof-btns tr-shot' }, h('span', { className: 'hint', textContent: '1~50위가 다 보이게 여러 장 찍어서 한꺼번에 골라도 돼' }), shot, file),
                h('p', { className: 'hint', textContent: '또는 글로 붙여넣기:' }),
                raw,
                h('div', { className: 'proof-btns' }, go),
                msg),
        );
      }),
    );
  }

  // ── 아이디어 검토 ──
  function renderHistory() {
    const list = [...records].sort((a, b) => b.createdAt - a.createdAt);
    el.history.replaceChildren(
      new Option(list.length ? `검토 기록 ${list.length}개` : '검토 기록 없음', ''),
      ...list.map((r) => new Option(`${new Date(r.createdAt).toLocaleDateString('ko-KR')} · ${r.idea.slice(0, 18)}${r.idea.length > 18 ? '…' : ''}`, r.id, false, r === current)),
    );
  }

  function renderResult() {
    const r = current;
    if (!r) {
      el.result.replaceChildren(h('p', { className: 'hint', textContent: '아이디어를 적고 "검토 시작"을 눌러. 독자 반응 · 시장성·트렌드 · 위험·개연성 세 관점으로 평가하고, 서로 검토한 뒤 진행자가 정리해. 트렌드는 "트렌드 자료"에 넣은 문피아 상위 50을 기준으로 봐.' }));
      return;
    }
    const s = r.summary;
    const dots = (n) => '●'.repeat(n) + '○'.repeat(5 - n);
    const memo = h('textarea', { className: 'pane-input', rows: 2, placeholder: '메모', value: r.memo ?? '' });
    memo.addEventListener('change', async () => {
      r.memo = memo.value.trim();
      await save(r);
    });
    const toMeeting = h('button', { type: 'button', className: 'mini-btn primary', textContent: '이 아이디어로 전개 회의 열기' });
    toMeeting.addEventListener('click', () => ctx.toDevMeeting(r.idea));
    const del = h('button', { type: 'button', className: 'mini-btn danger', textContent: '이 검토 지우기' });
    del.addEventListener('click', async () => {
      if (!(await askConfirm('이 검토 기록을 지울까? 되돌릴 수 없어.', '지우기', true))) return;
      await db.del('meetings', r.id);
      records = records.filter((x) => x !== r);
      await ctx.onDelete(r.id);
      current = records.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
      render();
    });
    el.result.replaceChildren(
      h('section', { className: 'mt-brief' },
        h('h3', { className: 'pane-h', textContent: `검토한 아이디어 · ${r.scope}${r.genre ? ` · ${r.genre}` : ''}` }),
        h('p', { className: 'mt-summary', textContent: r.idea }),
        h('p', { className: 'hint', textContent: `트렌드 기준: 무료 ${r.trends.free ?? '없음'} · 유료 ${r.trends.paid ?? '없음'}${r.cost ? ' · 비용 ' + r.cost : ''}` })),
      h('section', { className: 'mt-brief' },
        h('h3', { className: 'pane-h', textContent: '진행자 정리' }),
        s.opinion ? h('p', { className: 'mt-opinion', textContent: `“${s.opinion}”` }) : null,
        h('p', {}, h('b', { textContent: `트렌드 적합도 ${dots(s.trendFit)} ` }), s.trendNote),
        h('h4', { className: 'mt-h4', textContent: '강점' }), h('ul', { className: 'mt-list' }, s.strengths.map((x) => h('li', { textContent: x }))),
        h('h4', { className: 'mt-h4', textContent: '약점' }), h('ul', { className: 'mt-list' }, s.weaknesses.map((x) => h('li', { textContent: x }))),
        h('h4', { className: 'mt-h4', textContent: '살리려면' }), h('ol', { className: 'mt-list' }, s.fixes.map((x) => h('li', { textContent: x })))),
      h('div', { className: 'mt-cards' },
        r.evals.map((e, i) =>
          h('article', { className: 'mt-card' },
            h('div', { className: 'mt-card-head' }, h('span', { className: 'proof-tag', textContent: `평가 ${i + 1} · ${e.angle}` }), h('span', { className: 'hint', textContent: ai.PROVIDERS[e.by]?.name ?? e.by })),
            h('h3', { textContent: `${e.verdict} · ${dots(e.fit)}` }),
            h('p', { className: 'mt-summary', textContent: `👍 ${e.good.join(' / ')}` }),
            h('p', { className: 'mt-summary', textContent: `⚠ ${e.bad.join(' / ')}` }),
            e.evidence ? h('p', { className: 'hint', textContent: `근거: ${e.evidence}` }) : null,
            e.review
              ? h('div', { className: 'mt-cross' },
                  h('b', { textContent: `${ai.PROVIDERS[e.review.by]?.name ?? e.review.by}의 검토` }),
                  e.review.agree ? h('p', { textContent: `동의: ${e.review.agree}` }) : null,
                  e.review.disagree ? h('p', { textContent: `반박: ${e.review.disagree}` }) : null)
              : null))),
      h('section', { className: 'mt-memo' }, h('h3', { className: 'pane-h', textContent: '메모' }), memo, h('div', { className: 'proof-btns' }, del, toMeeting)),
    );
  }

  function render() {
    renderHistory();
    renderResult();
    el.start.disabled = busy;
  }

  el.start.addEventListener('click', async () => {
    const idea = el.text.value.trim();
    if (!idea) return el.text.focus();
    busy = true;
    render();
    try {
      const genre = normGenre($('#idGenre').value.split(/[,，]/)[0]);
      const rec = await review(ctx, { idea, scope: el.scope.value, genre }, (step) => (el.status.textContent = `${step}…`));
      await save(rec);
      records.push(rec);
      current = rec;
      el.status.textContent = `검토 끝 · ${rec.cost || ''}`;
    } catch (err) {
      el.status.textContent = err.message;
    } finally {
      busy = false;
      render();
    }
  });
  el.history.addEventListener('change', () => {
    current = records.find((r) => r.id === el.history.value) ?? current;
    render();
  });

  return {
    async openIdea() {
      records = (await db.getMeetingsOf(ctx.workId())).filter((m) => m.kind === 'idea');
      current = current && records.find((r) => r.id === current.id) ? records.find((r) => r.id === current.id) : records.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
      const { free, paid } = await latestTrends();
      el.status.textContent = !free && !paid ? '트렌드 자료가 아직 없어. "트렌드 자료"에서 문피아 상위 50을 넣어두면 그걸 기준으로 봐.' : '';
      render();
    },
    openTrend: renderTrends,
    // 동기화가 꼬리표를 붙일 때: 들고 있는 검토 기록이면 여기서 고쳐 저장(트렌드 자료는 저장소에서 바로)
    async patch(id, fn) {
      const r = records.find((x) => x.id === id);
      if (!r) return false;
      fn(r);
      await db.put('meetings', r);
      return true;
    },
  };
}
