// 전개 회의실: 다음 화 전개를 브레인스토밍한다. 실제 본문은 작가가 쓰고, AI는 아이디어와 설정 점검만 맡는다.
// 흐름: 자료 모으기 → 진행자가 지시서 → 전개안 3개(성격이 서로 다름) → 진행자가 비교·정리 → 작가가 채택/보관/버리기
//
// 역할은 roles() 가 돌려준다(회의실 화면의 "역할 바꾸기"에서 바꾸고, 이 기기에 저장).
// 기본: Claude 진행 · 전개안은 GPT·제미나이 · 서로의 안을 교차 검토(고쳐 쓰지 않고 장점·약점만).
//
// 회의 기록 하나 = {
//   id, workId, target(몇 화 전개), round(같은 조건으로 몇 번째), parentId(앞 회의), wish(작가가 원한 것), memo(작가 메모),
//   material: { tips: [{ id, rule }] },   // 이 회의에 넣은 작법 팁(번호 = 배열 순서 + 1)
//   brief: { goal, conditions: [], tips: [번호] },
//   proposals: [{ id, by, persona, title, summary, beats: [], ending, tips: [번호], choice: null|'adopt'|'keep'|'drop' }],
//   review: { table: [{ n, tension, hooks, safety, note }], conflicts: [{ n, problem, ref }], opinion },
//   cost, createdAt, updatedAt, dirty
// }

import * as db from './db.js';
import * as ai from './ai.js';
import { summariesText, loreText } from './context.js';
import { hookOf } from './hooks.js';
import { activeTips } from './notes.js';
import { askConfirm } from './dialogs.js';
import * as settings from './settings.js';

export const PERSONAS = [
  { persona: '과감한 전개', hint: '판을 크게 흔든다. 예상을 깨는 사건, 반전, 위기 고조.' },
  { persona: '떡밥 회수', hint: '깔아 둔 떡밥을 회수하거나 크게 진전시킨다. 독자가 기다린 보상.' },
  { persona: '감정선', hint: '인물의 감정과 관계를 깊게 판다. 대사와 선택으로 마음이 움직이는 회차.' },
];
export const DEFAULT_ROLES = { host: 'claude', writers: ['openai', 'gemini', 'gemini'] };

// 지금 역할: { host, writers: [{ provider, persona, hint }] }
export function roles() {
  const saved = settings.get().meetingRoles ?? {};
  const ok = (p) => (ai.PROVIDERS[p]?.ready ? p : null);
  return {
    host: ok(saved.host) ?? DEFAULT_ROLES.host,
    writers: PERSONAS.map((x, i) => ({ ...x, provider: ok(saved.writers?.[i]) ?? DEFAULT_ROLES.writers[i] })),
  };
}

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
const nums = (x) => arr(x).map(Number).filter((n) => Number.isInteger(n) && n > 0);
const score = (x) => Math.min(5, Math.max(1, Math.round(Number(x)) || 3));

function h(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...kids.flat().filter((k) => k != null && k !== false));
  return node;
}

// ───────── 지시문 ─────────

const BRIEF = `너는 웹소설 기획 회의의 진행자다. 아래 자료를 읽고 다음 회차 전개 회의의 지시서를 쓴다.
- goal: 이번 회차가 이뤄야 할 목표 한두 문장.
- conditions: 전개안이 지켜야 할 조건 3~6개. 설정·떡밥·연재 리듬과 관련해 구체적으로.
- tips: 이번 회의에 특히 참고할 작법 팁 번호(주어진 목록에서만).
- 작가가 원하는 것이나 지난 회의 메모가 있으면 그걸 가장 먼저 반영한다.
- 본문은 쓰지 않는다.
출력은 JSON 객체 하나: {"goal":"","conditions":[],"tips":[]}`;

const PROPOSE = (persona, hint) => `너는 웹소설 전개 아이디어를 내는 작가 보조다. 이번 회의에서 너의 성격은 "${persona}" 담당이다: ${hint}
지시서와 자료를 보고 다음 회차 전개안 하나를 낸다. 본문이 아니라 요약이다.
- title: 짧은 제목
- summary: 4~6문장
- beats: 장면 흐름 4~6개, 각 한 줄
- ending: 회차 끝을 어떻게 끊을지 한 줄
- tips: 참고한 작법 팁 번호
설정(죽은 인물, 잃은 물건, 능력·레벨, 관계)을 어기지 않는다. 지시서의 조건을 지킨다.
출력은 JSON 객체 하나: {"title":"","summary":"","beats":[],"ending":"","tips":[]}`;

const CROSS = `너는 웹소설 기획 회의의 검토자다. 다른 AI가 낸 전개안을 검토한다.
- 안을 고쳐 쓰거나 새 안을 내지 않는다. 장점과 약점만 말한다.
- strengths: 장점 2~3개, weaknesses: 약점 2~3개(각 한 줄, 구체적으로).
- tips: 작법 팁을 지켰는지 한 줄(어긴 팁 번호가 있으면 적는다).
출력은 JSON 객체 하나: {"reviews":[{"n":안 번호,"strengths":[],"weaknesses":[],"tips":""}]}`;

const REVIEW = `너는 웹소설 기획 회의의 진행자다. 전개안들과 교차 검토 내용을 보고 비교·정리한다. 안을 고쳐 쓰지 말고 평가만 한다.
- table: 안마다 tension(긴장감), hooks(떡밥 회수), safety(설정 안전) 를 1~5점으로, note 는 한 줄(작법 팁을 지켰는지도).
- conflicts: 설정과 어긋나는 점만. n(안 번호), problem, ref(근거 설정). 없으면 빈 배열.
- opinion: 진행자 한 줄 의견(어느 안이 왜 좋은지, 섞으면 좋은 점).
출력은 JSON 객체 하나: {"table":[{"n":1,"tension":3,"hooks":3,"safety":5,"note":""}],"conflicts":[],"opinion":""}`;

// ───────── 자료 모으기 ─────────

async function gather(ctx, { target, wish, memo }) {
  const workId = ctx.workId();
  const upto = target - 1;
  const docs = await ctx.wikiDocs();
  const openHooks = docs
    .filter((d) => d.category === '떡밥')
    .map((d) => ({ d, hk: hookOf(d) }))
    .filter(({ hk }) => !hk.resolved && (!hk.first || hk.first <= upto));
  const tips = await activeTips(workId, target);
  const text =
    `대상: ${target}화 전개 (지금까지 쓴 회차 ${ctx.chapters().length}개)\n` +
    `작가가 원하는 것: ${wish || '없음'}\n` +
    `지난 회의 메모: ${memo || '없음'}\n\n` +
    `회차 요약(연표, ${upto}화까지):\n${summariesText(ctx, { upto }) || '없음'}\n\n` +
    `설정(위키, ${upto}화 기준 인물 상태 포함):\n${await loreText(ctx, { upto })}\n\n` +
    `아직 안 푼 떡밥:\n${openHooks.map(({ d, hk }) => `- ${d.title}${hk.first ? ` (${hk.first}화)` : ''}: ${(d.body ?? '').split('\n')[0]}`).join('\n') || '없음'}\n\n` +
    `작법 팁(번호):\n${tips.map((t, i) => `${i + 1}. ${t.rule} [${t.category}]`).join('\n') || '없음'}`;
  return { text, tips: tips.map((t) => ({ id: t.id, rule: t.rule })), openHooks: openHooks.map(({ d, hk }) => ({ title: d.title, first: hk.first })) };
}

// 회의 한 번의 대략 비용(시작 전에 보여준다). 한국어는 대략 글자 0.9개 = 토큰 1개로 본다.
export function estimate(materialText) {
  const base = Math.round(materialText.length * 0.9) + 600;
  const R = roles();
  const reviewers = new Set(R.writers.map((w) => reviewerFor(R, w.provider)));
  const calls = [
    [R.host, base, 600],
    ...R.writers.map((w) => [w.provider, base + 500, 1200]),
    ...[...reviewers].map((p) => [p, base + 2500, 800]),
    [R.host, base + 4000, 900],
  ];
  let won = 0;
  for (const [p, input, output] of calls) won += ai.estimateWon(p, ai.currentModel(p), { input, output }) ?? 0;
  return won;
}

// ───────── 회의 진행 ─────────

// 교차 검토자: 그 안을 낸 회사가 아닌 다른 전개안 담당 회사. 모두 같은 회사면 진행자가 본다.
function reviewerFor(R, provider) {
  return R.writers.map((w) => w.provider).find((p) => p !== provider) ?? (R.host !== provider ? R.host : provider);
}
export const callCount = () => {
  const R = roles();
  return 2 + R.writers.length + new Set(R.writers.map((w) => reviewerFor(R, w.provider))).size;
};

export async function run(ctx, { target, wish, memo, parent }, onStep) {
  const R = roles();
  const need = new Set([R.host, ...R.writers.map((w) => w.provider)]);
  for (const p of need) if (!ai.hasKey(p)) throw new Error(`${ai.PROVIDERS[p].name} 키가 없어. 설정(⚙) → AI → 키·모델 관리에서 넣어줘.`);

  const usage = {};
  const call = async (provider, system, user) => {
    const res = await ai.ask({ provider, system, user, json: true });
    const u = (usage[provider] ??= { input: 0, output: 0, model: res.model });
    u.input += res.usage.input;
    u.output += res.usage.output;
    return parse(res.text);
  };

  onStep('자료 모으는 중');
  const mat = await gather(ctx, { target, wish, memo });

  onStep('진행자가 지시서 쓰는 중');
  const b = await call(R.host, BRIEF, mat.text);
  const brief = { goal: String(b.goal ?? ''), conditions: arr(b.conditions).map(String), tips: nums(b.tips).filter((n) => n <= mat.tips.length) };
  const briefText = `지시서\n목표: ${brief.goal}\n조건:\n${brief.conditions.map((c) => '- ' + c).join('\n')}\n특히 참고할 작법 팁: ${brief.tips.join(', ') || '없음'}`;

  onStep(`전개안 쓰는 중 (0/${R.writers.length})`);
  let done = 0;
  const proposals = await Promise.all(
    R.writers.map(async (w) => {
      const p = await call(w.provider, PROPOSE(w.persona, w.hint), `${mat.text}\n\n${briefText}`);
      onStep(`전개안 쓰는 중 (${++done}/${R.writers.length})`);
      return {
        id: uid(),
        by: w.provider,
        persona: w.persona,
        title: String(p.title ?? '(제목 없음)'),
        summary: String(p.summary ?? ''),
        beats: arr(p.beats).map(String),
        ending: String(p.ending ?? ''),
        tips: nums(p.tips).filter((n) => n <= mat.tips.length),
        choice: null,
      };
    }),
  );

  const describeP = (p, i) =>
    `안 ${i + 1} [${p.persona}] ${p.title}\n${p.summary}\n흐름: ${p.beats.join(' / ')}\n끝: ${p.ending}\n참고한 팁: ${p.tips.join(', ') || '없음'}`;

  // 교차 검토: 검토자마다 자기 것이 아닌 안들을 한 번에 본다(고쳐 쓰지 않고 장점·약점만).
  const byReviewer = new Map();
  proposals.forEach((p, i) => {
    const rv = reviewerFor(R, p.by);
    if (!byReviewer.has(rv)) byReviewer.set(rv, []);
    byReviewer.get(rv).push(i);
  });
  onStep('서로의 안을 검토하는 중');
  await Promise.all(
    [...byReviewer].map(async ([rv, idx]) => {
      const c = await call(rv, CROSS, `${mat.text}\n\n${briefText}\n\n검토할 전개안:\n${idx.map((i) => describeP(proposals[i], i)).join('\n\n')}`);
      for (const x of arr(c.reviews)) {
        const i = Number(x.n) - 1;
        if (!idx.includes(i)) continue;
        proposals[i].review = { by: rv, strengths: arr(x.strengths).map(String), weaknesses: arr(x.weaknesses).map(String), tips: String(x.tips ?? '') };
      }
    }),
  );

  onStep('진행자가 비교·정리하는 중');
  const list = proposals
    .map((p, i) => {
      const rv = p.review;
      const cross = rv ? `\n검토(${ai.PROVIDERS[rv.by]?.name}): 장점 ${rv.strengths.join(' / ')} · 약점 ${rv.weaknesses.join(' / ')} · 팁 ${rv.tips}` : '';
      return describeP(p, i) + cross;
    })
    .join('\n\n');
  const r = await call(R.host, REVIEW, `${mat.text}\n\n${briefText}\n\n전개안과 교차 검토:\n${list}`);
  const review = {
    table: arr(r.table).map((t) => ({ n: Number(t.n), tension: score(t.tension), hooks: score(t.hooks), safety: score(t.safety), note: String(t.note ?? '') })),
    conflicts: arr(r.conflicts).filter((c) => c && c.problem).map((c) => ({ n: Number(c.n), problem: String(c.problem), ref: String(c.ref ?? '') })),
    opinion: String(r.opinion ?? ''),
  };

  let won = 0;
  for (const [p, u] of Object.entries(usage)) won += ai.estimateWon(p, u.model, u) ?? 0;
  return {
    id: uid(),
    workId: ctx.workId(),
    target,
    round: parent ? (parent.round ?? 1) + 1 : 1,
    parentId: parent?.id ?? null,
    wish,
    memo: '',
    material: { tips: mat.tips, openHooks: mat.openHooks },
    brief,
    proposals,
    review,
    cost: ai.fmtWon(won),
    createdAt: Date.now(),
  };
}

// ───────── 화면 ─────────

export function init(ctx) {
  const el = {
    root: $('#meeting'),
    no: $('#mtNo'),
    wish: $('#mtWish'),
    start: $('#mtStart'),
    cost: $('#mtCost'),
    history: $('#mtHistory'),
    status: $('#mtStatus'),
    tabs: $('#mtTabs'),
    material: $('#mtMaterial'),
    center: $('#mtCenter'),
    right: $('#mtRight'),
    actions: $('#mtActions'),
  };
  let meetings = [];
  let current = null;
  let page = 0; // 폰에서 지금 보는 전개안
  let busy = false;
  let materialPreview = null;

  const save = async (m) => {
    m.updatedAt = Date.now();
    m.dirty = true;
    await db.put('meetings', m);
    if (!meetings.includes(m)) meetings.push(m);
    ctx.onChange();
  };
  const defaultTarget = () => {
    const chs = ctx.chapters();
    const lastDone = chs.reduce((n, c, i) => (c.done ? i + 1 : n), 0);
    return Math.max(1, lastDone + 1);
  };
  const tipText = (m, n) => m.material?.tips?.[n - 1]?.rule;

  async function refreshEstimate() {
    const target = Number(el.no.value) || defaultTarget();
    try {
      materialPreview = await gather(ctx, { target, wish: el.wish.value.trim(), memo: '' });
      const won = estimate(materialPreview.text);
      el.cost.textContent = won ? `예상 비용 ${ai.fmtWon(won)} (AI ${callCount()}번)` : '';
    } catch {
      el.cost.textContent = '';
    }
    renderMaterial();
  }

  function renderHistory() {
    const list = [...meetings].sort((a, b) => b.createdAt - a.createdAt);
    el.history.replaceChildren(
      new Option(list.length ? `회의 기록 ${list.length}개` : '회의 기록 없음', ''),
      ...list.map((m) => new Option(`${new Date(m.createdAt).toLocaleDateString('ko-KR')} · ${m.target}화${m.round > 1 ? ` (${m.round}차)` : ''}`, m.id, false, m === current)),
    );
  }

  function renderMaterial() {
    const m = current;
    const tips = m?.material?.tips ?? materialPreview?.tips ?? [];
    const hooks = m?.material?.openHooks ?? materialPreview?.openHooks ?? [];
    const target = m?.target ?? (Number(el.no.value) || defaultTarget());
    const persons = [];
    // 역할 바꾸기: 진행자와 성격별 전개안 담당 회사(키가 없는 회사는 흐리게)
    const R = roles();
    const pick = (value, onPick) => {
      const s = h('select', { className: 'pick' });
      for (const [id, p] of Object.entries(ai.PROVIDERS)) {
        const o = new Option(p.name + (ai.hasKey(id) ? '' : ' (키 없음)'), id, false, id === value);
        o.disabled = !p.ready;
        s.append(o);
      }
      s.addEventListener('change', () => onPick(s.value));
      return s;
    };
    const setRoles = (patch) => {
      const cur = roles();
      settings.update({ meetingRoles: { host: cur.host, writers: cur.writers.map((w) => w.provider), ...patch } });
      refreshEstimate();
    };
    const roleBox = h('details', { className: 'pane-details mt-roles' },
      h('summary', { textContent: `역할: 진행 ${ai.PROVIDERS[R.host].name} · 전개안 ${R.writers.map((w) => ai.PROVIDERS[w.provider].name).join('·')}` }),
      h('label', { className: 'row' }, h('span', { textContent: '진행자' }), pick(R.host, (v) => setRoles({ host: v }))),
      R.writers.map((w, i) =>
        h('label', { className: 'row' }, h('span', { textContent: w.persona }), pick(w.provider, (v) => setRoles({ writers: R.writers.map((x, j) => (j === i ? v : x.provider)) })))),
      h('p', { className: 'hint', textContent: '전개안은 그 안을 안 낸 다른 회사가 검토해.' }));
    el.material.replaceChildren(
      h('h3', { className: 'pane-h', textContent: '회의 자료' }),
      roleBox,
      h('p', { className: 'hint', textContent: `${target}화 전개 · ${target - 1}화까지의 요약·위키를 읽어.` }),
      h('h4', { className: 'mt-h4', textContent: `안 푼 떡밥 ${hooks.length}` }),
      hooks.length ? h('ul', { className: 'mt-list' }, hooks.map((x) => h('li', { textContent: `${x.title}${x.first ? ` · ${x.first}화` : ''}` }))) : h('p', { className: 'hint', textContent: '없음' }),
      h('h4', { className: 'mt-h4', textContent: `켜진 작법 팁 ${tips.length}` }),
      tips.length
        ? h('ol', { className: 'mt-list' }, tips.map((t, i) => h('li', { className: m?.brief?.tips?.includes(i + 1) ? 'used' : '', textContent: t.rule })))
        : h('p', { className: 'hint', textContent: '없음 · 기획 ▾ → 작법 노트에서 모을 수 있어' }),
      persons,
    );
  }

  function proposalCard(m, p, i) {
    const t = m.review?.table?.find((x) => x.n === i + 1);
    const conflicts = (m.review?.conflicts ?? []).filter((c) => c.n === i + 1);
    const choose = (choice) => async () => {
      p.choice = p.choice === choice ? null : choice;
      await save(m);
      render();
    };
    const btn = (label, choice) =>
      h('button', { type: 'button', className: 'mini-btn' + (p.choice === choice ? ' primary' : ''), textContent: label, onclick: choose(choice) });
    return h('article', { className: 'mt-card' + (p.choice ? ' ' + p.choice : '') },
      h('div', { className: 'mt-card-head' }, h('span', { className: 'proof-tag', textContent: `안 ${i + 1} · ${p.persona}` }), h('span', { className: 'hint', textContent: ai.PROVIDERS[p.by]?.name ?? p.by })),
      h('h3', { textContent: p.title }),
      h('p', { className: 'mt-summary', textContent: p.summary }),
      p.beats.length ? h('ol', { className: 'mt-beats' }, p.beats.map((b) => h('li', { textContent: b }))) : null,
      p.ending ? h('p', { className: 'mt-ending' }, h('b', { textContent: '회차 끝 ' }), p.ending) : null,
      p.tips.length ? h('p', { className: 'hint', textContent: `참고한 팁: ${p.tips.map((n) => tipText(m, n) ?? n).join(' / ')}` }) : null,
      p.review
        ? h('div', { className: 'mt-cross' },
            h('b', { textContent: `${ai.PROVIDERS[p.review.by]?.name ?? p.review.by}의 검토` }),
            p.review.strengths.length ? h('p', { textContent: `👍 ${p.review.strengths.join(' / ')}` }) : null,
            p.review.weaknesses.length ? h('p', { textContent: `⚠ ${p.review.weaknesses.join(' / ')}` }) : null,
            p.review.tips ? h('p', { className: 'hint', textContent: `작법 팁: ${p.review.tips}` }) : null)
        : null,
      t ? h('p', { className: 'mt-score' }, `긴장감 ${'●'.repeat(t.tension)}${'○'.repeat(5 - t.tension)} · 떡밥 ${'●'.repeat(t.hooks)}${'○'.repeat(5 - t.hooks)} · 설정 안전 ${'●'.repeat(t.safety)}${'○'.repeat(5 - t.safety)}`) : null,
      conflicts.map((c) => h('p', { className: 'mt-warn', textContent: `⚠ ${c.problem}${c.ref ? ` (${c.ref})` : ''}` })),
      h('div', { className: 'proof-btns mt-choice' }, btn('버리기', 'drop'), btn('보관', 'keep'), btn('채택', 'adopt')),
    );
  }

  function renderCenter() {
    const m = current;
    if (!m) {
      el.center.replaceChildren(
        h('div', { className: 'mt-empty' },
          h('p', { textContent: '"새 회의 시작"을 누르면 진행자가 자료를 읽고 지시서를 쓰고, 성격이 다른 전개안 3개를 받아서 정리해 줘.' }),
          h('p', { className: 'hint', textContent: '본문은 네가 쓰는 거야. 여기선 아이디어와 설정 점검만.' })),
      );
      return;
    }
    const memo = h('textarea', { className: 'pane-input', rows: 3, placeholder: '메모 (예: 2안의 반전에 3안의 감정선을 섞고 싶어. 철수는 아직 정체를 숨겨야 해.)', value: m.memo ?? '' });
    memo.addEventListener('change', async () => {
      m.memo = memo.value.trim();
      await save(m);
    });
    const again = h('button', { type: 'button', className: 'mini-btn primary', textContent: '이 조건으로 한 번 더 회의' });
    again.addEventListener('click', () => start({ parent: m, memo: memo.value.trim() }));
    const del = h('button', { type: 'button', className: 'mini-btn danger', textContent: '이 회의 지우기' });
    del.addEventListener('click', async () => {
      if (!(await askConfirm('이 회의 기록을 지울까? 보관한 안도 같이 사라지고 되돌릴 수 없어.', '지우기', true))) return;
      await db.del('meetings', m.id);
      meetings = meetings.filter((x) => x !== m);
      await ctx.onDelete(m.id);
      current = [...meetings].sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
      render();
    });
    const cards = m.proposals.map((p, i) => proposalCard(m, p, i));
    el.center.replaceChildren(
      h('section', { className: 'mt-brief' },
        h('h3', { className: 'pane-h', textContent: `${m.target}화 지시서${m.round > 1 ? ` · ${m.round}차 회의` : ''}` }),
        m.wish ? h('p', { className: 'hint', textContent: `원한 것: ${m.wish}` }) : null,
        h('p', { textContent: m.brief.goal }),
        h('ul', { className: 'mt-list' }, m.brief.conditions.map((c) => h('li', { textContent: c }))),
        m.brief.tips.length ? h('p', { className: 'hint', textContent: `참고 팁: ${m.brief.tips.map((n) => tipText(m, n) ?? n).join(' / ')}` }) : null),
      h('div', { className: 'mt-cards' }, cards),
      h('div', { className: 'mt-pager' },
        h('button', { type: 'button', className: 'mini-btn', textContent: '‹', disabled: page <= 0, onclick: () => ((page = Math.max(0, page - 1)), render()) }),
        h('span', { textContent: `${page + 1} / ${cards.length}` }),
        h('button', { type: 'button', className: 'mini-btn', textContent: '›', disabled: page >= cards.length - 1, onclick: () => ((page = Math.min(cards.length - 1, page + 1)), render()) })),
      h('section', { className: 'mt-memo' }, h('h3', { className: 'pane-h', textContent: '메모' }), memo, h('div', { className: 'proof-btns' }, del, again)),
    );
    cards.forEach((c, i) => c.classList.toggle('mt-current', i === page));

    // 폰: 지금 보는 안의 채택/보관/버리기를 아래에 고정
    const cur = m.proposals[page];
    el.actions.replaceChildren(
      ...(cur
        ? [['버리기', 'drop'], ['보관', 'keep'], ['채택', 'adopt']].map(([label, choice]) =>
            h('button', {
              type: 'button',
              className: 'mini-btn' + (cur.choice === choice ? ' primary' : ''),
              textContent: label,
              onclick: async () => {
                cur.choice = cur.choice === choice ? null : choice;
                await save(m);
                render();
              },
            }))
        : []),
    );
  }

  function renderRight() {
    const m = current;
    const kept = meetings
      .flatMap((x) => x.proposals.filter((p) => p.choice === 'keep').map((p) => ({ m: x, p })))
      .sort((a, b) => b.m.createdAt - a.m.createdAt);
    const summary = m
      ? [
          h('h3', { className: 'pane-h', textContent: '진행자 정리' }),
          h('table', { className: 'mt-table' },
            h('tr', {}, h('th', { textContent: '안' }), h('th', { textContent: '긴장감' }), h('th', { textContent: '떡밥' }), h('th', { textContent: '설정' })),
            m.proposals.map((p, i) => {
              const t = m.review.table.find((x) => x.n === i + 1);
              return h('tr', {}, h('td', { textContent: `${i + 1}. ${p.persona}` }), h('td', { textContent: t?.tension ?? '-' }), h('td', { textContent: t?.hooks ?? '-' }), h('td', { textContent: t?.safety ?? '-' }));
            })),
          m.review.table.some((t) => t.note) ? h('ul', { className: 'mt-list' }, m.review.table.filter((t) => t.note).map((t) => h('li', { textContent: `안 ${t.n}: ${t.note}` }))) : null,
          m.review.conflicts.length
            ? h('div', {}, h('h4', { className: 'mt-h4', textContent: '설정 충돌' }), m.review.conflicts.map((c) => h('p', { className: 'mt-warn', textContent: `안 ${c.n}: ${c.problem}${c.ref ? ` (${c.ref})` : ''}` })))
            : h('p', { className: 'hint', textContent: '설정 충돌 없음' }),
          m.review.opinion ? h('p', { className: 'mt-opinion', textContent: `“${m.review.opinion}”` }) : null,
          m.cost ? h('p', { className: 'hint', textContent: `이 회의 비용 ${m.cost}` }) : null,
        ]
      : [h('h3', { className: 'pane-h', textContent: '진행자 정리' }), h('p', { className: 'hint', textContent: '회의를 하면 여기에 비교표와 의견이 나와.' })];
    el.right.replaceChildren(
      ...summary,
      h('h3', { className: 'pane-h', textContent: `아이디어 보관함 ${kept.length}` }),
      kept.length
        ? h('ul', { className: 'proof-list' },
            kept.map(({ m: x, p }) =>
              h('li', { className: 'proof-item' },
                h('div', { className: 'proof-head' }, h('b', { textContent: p.title }), h('span', { textContent: `${x.target}화 회의 · ${p.persona}` })),
                h('details', { className: 'pane-details' }, h('summary', { textContent: '내용' }), h('p', { className: 'mt-summary', textContent: p.summary }), p.ending ? h('p', { className: 'hint', textContent: `끝: ${p.ending}` }) : null),
                h('div', { className: 'proof-btns' },
                  h('button', { type: 'button', className: 'mini-btn', textContent: '보관함에서 빼기', onclick: async () => ((p.choice = null), await save(x), render()) }),
                  h('button', { type: 'button', className: 'mini-btn', textContent: '그 회의 보기', onclick: () => ((current = x), (page = x.proposals.indexOf(p)), render()) })))))
        : h('p', { className: 'hint', textContent: '"보관"한 안이 여기 모여. 다른 회차에서 다시 꺼내 쓸 수 있어.' }),
    );
  }

  function render() {
    renderHistory();
    renderMaterial();
    renderCenter();
    renderRight();
    el.start.disabled = busy;
  }

  async function start({ parent = null, memo = '' } = {}) {
    if (busy) return;
    const target = parent ? parent.target : Number(el.no.value) || defaultTarget();
    const wish = parent ? parent.wish : el.wish.value.trim();
    busy = true;
    el.start.disabled = true;
    try {
      const m = await run(ctx, { target, wish, memo, parent }, (step) => (el.status.textContent = `${step}…`));
      await save(m);
      current = m;
      page = 0;
      el.status.textContent = `회의 끝 · ${m.cost || ''}`;
      showTab('center');
    } catch (err) {
      el.status.textContent = err.message;
    } finally {
      busy = false;
      render();
    }
  }

  // 폰: 자료 / 전개안 / 정리 탭
  function showTab(col) {
    el.root.dataset.tab = col;
    for (const b of el.tabs.querySelectorAll('[data-col]')) b.classList.toggle('on', b.dataset.col === col);
  }
  el.tabs.addEventListener('click', (e) => {
    const b = e.target.closest('[data-col]');
    if (b) showTab(b.dataset.col);
  });
  el.start.addEventListener('click', () => start());
  el.history.addEventListener('change', () => {
    current = meetings.find((m) => m.id === el.history.value) ?? current;
    page = 0;
    render();
  });
  el.no.addEventListener('change', refreshEstimate);
  el.wish.addEventListener('change', refreshEstimate);

  return {
    async open() {
      meetings = (await db.getMeetingsOf(ctx.workId())).filter((m) => m.kind !== 'idea'); // 아이디어 검토 기록은 따로
      current = [...meetings].sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
      el.no.value = defaultTarget();
      page = 0;
      showTab(current ? 'center' : 'material');
      const missing = [...new Set([roles().host, ...roles().writers.map((w) => w.provider)])].filter((p) => !ai.hasKey(p));
      el.status.textContent = missing.length ? `${missing.map((p) => ai.PROVIDERS[p].name).join(', ')} 키가 없어. 설정(⚙) → AI → 키·모델 관리에서 넣거나, 왼쪽 "역할 바꾸기"에서 다른 회사로 바꿔줘.` : '';
      render();
      refreshEstimate();
    },
    async reload() {
      if (busy) return;
      const id = current?.id;
      meetings = (await db.getMeetingsOf(ctx.workId())).filter((m) => m.kind !== 'idea');
      current = meetings.find((m) => m.id === id) ?? current;
      render();
    },
    // 아이디어 검토에서 "이 아이디어로 전개 회의 열기"
    prefillWish(text) {
      el.wish.value = text;
      refreshEstimate();
    },
    async patch(id, fn) {
      const m = meetings.find((x) => x.id === id);
      if (!m) return false;
      fn(m);
      await db.put('meetings', m);
      return true;
    },
  };
}
