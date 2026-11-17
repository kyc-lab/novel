// 작법 노트: 작가가 모은 작법 팁을 규칙으로 정리해 두고, 나중에 전개 회의실의 모든 AI가 참고하게 한다.
// 모든 작품이 같이 쓰고, 팁마다 "이 작품에서 끄기"가 된다.
//
// 팁 하나 = {
//   id, rule(규칙 한 줄), category(분류), when('always' 매 회의 | 'range' 특정 회차 구간 | 'need' 필요할 때만),
//   range: { from, to, basis(원문이 기준으로 삼은 총 회차, 모르면 null) } | null,
//   genres: [장르 경로] — [] 이면 공통(모든 장르), 없으면(옛 팁) 장르 미정 = 일단 공통처럼 쓴다,
//   on(켜짐), offWorks: [이 팁을 끈 작품 id], source(출처), original(원문),
//   conflicts: [{ with: 다른 팁 id, prefer: 'this' | 'that' | 'judge', reason }],
//   createdAt, updatedAt, dirty
// }

import * as db from './db.js';
import * as ai from './ai.js';
import { askConfirm } from './dialogs.js';

export const CATEGORIES = ['연재 리듬', '도입부', '인물', '문장', '전개', '기타'];
export const WHEN = { always: '매 회의', range: '특정 회차 구간', need: '필요할 때만' };
const uid = () => crypto.randomUUID();
const $ = (sel) => document.querySelector(sel);

// ───────── 장르 ─────────
// 장르는 "현판 › 헌터 › 회빙환" 처럼 큰 장르에서 세부 장르로 내려가는 경로. 작품에 하나, 팁에 여러 개.
// "현판" 팁은 "현판 › 헌터 › 회빙환" 작품에도 들어간다(위 장르 팁은 아래 장르에 다 적용).
export const SEP = ' › ';
export const GENRE_HINTS = ['현판', '현판 › 헌터', '현판 › 헌터 › 회빙환', '판타지', '무협', '로판', '힐링'];
export const normGenre = (s) =>
  String(s ?? '')
    .split(/\s*(?:›|>|\/|\|)\s*/)
    .map((x) => x.trim())
    .filter(Boolean)
    .join(SEP);
const parseGenres = (s) => [...new Set(String(s ?? '').split(/[,，]/).map(normGenre).filter((g) => g && g !== '공통'))];
export const genreLabel = (n) => (!Array.isArray(n.genres) ? '장르 미정' : n.genres.length ? n.genres.join(', ') : '공통');
// 이 팁이 이 장르 작품에 들어가는가. 작품 장르를 아직 안 정했으면 전부 들어간다(예전처럼).
export const fitsGenre = (n, genre) =>
  !genre || !Array.isArray(n.genres) || !n.genres.length || n.genres.some((g) => genre === g || genre.startsWith(g + SEP));

const ORGANIZE = `너는 웹소설 작법 코치다. 작가가 모은 작법 팁(짧은 말이거나 긴 글)을 규칙으로 정리한다.
- 하나의 글에 조언이 여러 개면 규칙 여러 개로 나눈다. 같은 말을 되풀이한 것은 하나로 합친다.
- rule: 바로 지킬 수 있는 규칙 한 문장. "~한다" 체, 60자 안팎.
- category: ${CATEGORIES.join(' / ')} 중 하나. 정말 안 맞으면 짧은 새 이름.
- when: always(매 회의 참고) / range(특정 회차 구간에만 해당) / need(특정 상황에서만 필요)
- range: when 이 range 일 때만 {"from":시작 회차,"to":끝 회차,"basis":원문이 기준으로 삼은 총 회차(예: "200화 기준"이면 200, 언급 없으면 null)}. 아니면 null.
- 원문에 없는 조언을 지어내지 않는다.
- genre: 이 규칙이 어느 장르에서만 통하는지. 장르와 상관없이 웹소설 어디서나 통하면 "공통". 특정 장르 이야기(예: 헌터 등급, 회귀 전 지식, 힐링물의 갈등 수위)면 "큰 장르 › 세부 장르" 경로로. 작가가 아는 장르 목록에 맞는 게 있으면 그 이름을 그대로 쓴다.
출력은 JSON 객체 하나: {"tips":[{"rule":"","category":"","when":"always","range":null,"genre":"공통"}]}`;

const SPLIT = `너는 웹소설 작법 노트 편집자다. 아래 규칙들은 작가가 한 장르를 쓰면서 모은 것이다.
이 중에서 장르와 상관없이 웹소설 어디서나 통하는 규칙(연재 리듬, 회차 끝 절단, 문장, 인물 일반론 등)만 고른다.
그 장르 특유의 소재·설정·독자 기대에 기대는 규칙은 고르지 않는다. 애매하면 고르지 않는다.
출력은 JSON 객체 하나: {"common":[규칙 번호들]}`;

const CONFLICT = `너는 작법 노트 편집자다. "새 규칙"과 "기존 규칙" 사이에서 서로 반대되어 동시에 지키기 어려운 쌍만 찾는다.
비슷한 말, 서로 보완하는 말은 충돌이 아니다. 확실한 것만.
출력은 JSON 객체 하나: {"conflicts":[{"new":새 규칙 번호,"old":기존 규칙 번호,"reason":"왜 부딪히는지 짧게"}]}`;

const parse = (text) => {
  try {
    return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch {
    return {};
  }
};

function h(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...kids.filter((k) => k != null && k !== false));
  return node;
}

// ───────── 데이터 ─────────

let notes = []; // 메모리에 들고 있는 팁 목록(화면을 열 때 읽는다)
let hooks = { onChange: () => {}, onDelete: () => {}, workId: () => null, work: () => null, works: () => [], setWorkGenre: async () => {} };

async function load() {
  notes = (await db.getAll('notes')).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  return notes;
}

async function save(list) {
  for (const n of list) {
    n.updatedAt = Date.now();
    n.dirty = true;
    await db.put('notes', n);
    if (!notes.includes(n)) notes.push(n);
  }
  if (list.length) hooks.onChange();
}

// 동기화가 "올렸다" 꼬리표를 붙일 때(메모리의 같은 팁을 고쳐서 저장)
export async function patch(id, fn) {
  const n = notes.find((x) => x.id === id);
  if (!n) return false;
  fn(n);
  await db.put('notes', n);
  return true;
}

// 회의실 등에서 쓸 "지금 켜져 있는 팁". workId 작품, no 화 기준. 공통 팁 + 그 작품 장르 팁만.
// genre 를 주면 작품 장르 대신 그 장르로 고른다(새 작품 아이디어 검토 등).
// (구간 팁의 회차 환산은 연재 로드맵이 생기면 거기 목표 회차로 맞춘다. 지금은 원문 회차 그대로.)
export async function activeTips(workId, no, { genre } = {}) {
  const all = await db.getAll('notes');
  const g = genre !== undefined ? normGenre(genre) : workId ? (await db.get('works', workId))?.genre ?? '' : '';
  return all.filter((n) => {
    if (!n.on || (n.offWorks ?? []).includes(workId)) return false;
    if (!fitsGenre(n, g)) return false;
    if (n.when === 'range' && n.range) return no >= n.range.from && no <= n.range.to;
    return n.when !== 'need';
  });
}

// ───────── AI 정리 · 충돌 찾기 ─────────

async function organize(text, workGenre, known) {
  const user =
    `작가가 지금 쓰는 작품 장르: ${workGenre || '아직 안 정함'}\n` +
    `작가가 아는 장르 목록: ${known.join(' / ') || '없음'}\n\n작법 팁 원문:\n${text}`;
  const res = await ai.ask({ system: ORGANIZE, user, json: true, effort: 'low' });
  const tips = (Array.isArray(parse(res.text).tips) ? parse(res.text).tips : [])
    .filter((t) => t && String(t.rule ?? '').trim())
    .map((t) => ({
      keep: true,
      rule: String(t.rule).trim(),
      category: String(t.category ?? '기타').trim() || '기타',
      when: WHEN[t.when] ? t.when : 'always',
      range:
        t.when === 'range' && t.range && Number(t.range.from) && Number(t.range.to)
          ? { from: Number(t.range.from), to: Number(t.range.to), basis: Number(t.range.basis) || null }
          : null,
      genres: parseGenres(t.genre),
    }));
  return { tips, cost: ai.fmtWon(ai.estimateWon(res.provider, res.model, res.usage)) };
}

async function findConflicts(fresh, existing) {
  if (!fresh.length || !existing.length) return [];
  const list = (arr) => arr.map((n, i) => `${i + 1}. ${n.rule}`).join('\n');
  const res = await ai.ask({ system: CONFLICT, user: `새 규칙:\n${list(fresh)}\n\n기존 규칙:\n${list(existing)}`, json: true, effort: 'low' });
  return (Array.isArray(parse(res.text).conflicts) ? parse(res.text).conflicts : [])
    .map((c) => ({ a: fresh[Number(c.new) - 1], b: existing[Number(c.old) - 1], reason: String(c.reason ?? '') }))
    .filter((c) => c.a && c.b);
}

// 옛 팁(장르 미정)을 한 장르로 묶되, 어디서나 통하는 건 공통으로 골라낸다
async function splitCommon(list) {
  const res = await ai.ask({ system: SPLIT, user: list.map((n, i) => `${i + 1}. ${n.rule}`).join('\n'), json: true, effort: 'low' });
  const nums = Array.isArray(parse(res.text).common) ? parse(res.text).common.map(Number) : [];
  return { common: new Set(nums.map((k) => list[k - 1]).filter(Boolean)), cost: ai.fmtWon(ai.estimateWon(res.provider, res.model, res.usage)) };
}

// ───────── 화면 ─────────

export function init(h0) {
  hooks = { ...hooks, ...h0 };
  const el = {
    text: $('#ntText'),
    source: $('#ntSource'),
    go: $('#ntGo'),
    info: $('#ntInfo'),
    draft: $('#ntDraft'),
    conflicts: $('#ntConflicts'),
    filter: $('#ntFilter'),
    genreFilter: $('#ntGenreFilter'),
    workGenre: $('#ntWorkGenre'),
    legacy: $('#ntLegacy'),
    list: $('#ntList'),
    count: $('#ntCount'),
  };
  let draft = null; // { original, source, tips: [...], cost }
  let pending = []; // 사용자가 아직 정하지 않은 충돌 [{ a, b, reason }]
  let filter = '전체';
  let gFilter = 'all'; // all | here | common | none | 장르 경로

  const workGenre = () => hooks.work()?.genre ?? '';
  const knownGenres = () =>
    [...new Set([...GENRE_HINTS, ...hooks.works().map((w) => w.genre), ...notes.flatMap((n) => n.genres ?? [])].filter(Boolean))].sort();
  const appliesHere = (n) => n.on && !(n.offWorks ?? []).includes(hooks.workId()) && fitsGenre(n, workGenre());

  // 장르 입력칸(이미 쓴 장르를 골라 쓰거나 새로 입력). 고를 목록은 화면에 하나만 둔다.
  const datalist = h('datalist', { id: 'ntGenreList' });
  document.body.append(datalist);
  const fillDatalist = () => datalist.replaceChildren(...knownGenres().map((g) => new Option(g, g)));
  load().then(fillDatalist, () => {}); // 아이디어 검토의 장르 칸도 이 목록을 쓴다
  const genreInput = (value, placeholder) => {
    const i = h('input', { type: 'text', className: 'pane-input nt-genre', value, placeholder, autocomplete: 'off', spellcheck: false, title: '예: 현판 › 헌터 › 회빙환 ( > 나 / 로 나눠도 돼). 여러 개면 쉼표로.' });
    i.setAttribute('list', 'ntGenreList');
    return i;
  };
  let editing = null; // 고치는 중인 팁 id

  const categoriesInUse = () => [...new Set([...CATEGORIES, ...notes.map((n) => n.category)])];

  // 분류·적용 시점·구간을 고르는 칸들(정리 결과와 목록 고치기가 같이 쓴다)
  function fields(t) {
    const rule = h('textarea', { className: 'pane-input nt-rule', rows: 2, value: t.rule });
    rule.addEventListener('input', () => (t.rule = rule.value.trim()));
    const cat = h('select');
    for (const c of categoriesInUse()) cat.append(new Option(c, c, false, c === t.category));
    if (!categoriesInUse().includes(t.category)) cat.append(new Option(t.category, t.category, false, true));
    cat.addEventListener('change', () => (t.category = cat.value));
    const when = h('select');
    for (const [k, v] of Object.entries(WHEN)) when.append(new Option(v, k, false, k === t.when));
    const from = h('input', { type: 'number', min: 1, placeholder: '시작', value: t.range?.from ?? '' });
    const to = h('input', { type: 'number', min: 1, placeholder: '끝', value: t.range?.to ?? '' });
    const basis = h('input', { type: 'number', min: 1, placeholder: '원문 기준(예: 200)', value: t.range?.basis ?? '' });
    const rangeBox = h('span', { className: 'nt-range' }, from, '화 ~ ', to, '화 · ', basis, '화 기준');
    const syncRange = () => {
      rangeBox.hidden = when.value !== 'range';
      t.when = when.value;
      t.range = when.value === 'range' && Number(from.value) && Number(to.value)
        ? { from: Number(from.value), to: Number(to.value), basis: Number(basis.value) || null }
        : null;
    };
    for (const x of [when, from, to, basis]) x.addEventListener('input', syncRange);
    syncRange();
    const genre = genreInput((t.genres ?? []).join(', '), '공통 (비우면 모든 장르)');
    genre.addEventListener('input', () => (t.genres = parseGenres(genre.value)));
    return [rule, h('div', { className: 'nt-fields' }, h('label', { className: 'nt-genre-l' }, '장르 ', genre), cat, when, rangeBox)];
  }

  function renderDraft() {
    if (!draft) {
      el.draft.replaceChildren();
      return;
    }
    const cards = draft.tips.map((t) => {
      const keep = h('input', { type: 'checkbox', checked: t.keep, title: '저장할지' });
      keep.addEventListener('change', () => (t.keep = keep.checked));
      return h('li', { className: 'proof-item' }, h('label', { className: 'nt-keep' }, keep, ' 저장'), ...fields(t));
    });
    const saveBtn = h('button', { type: 'button', className: 'mini-btn primary', textContent: '확인한 팁 저장' });
    saveBtn.addEventListener('click', saveDraft);
    const cancel = h('button', { type: 'button', className: 'mini-btn', textContent: '취소' });
    cancel.addEventListener('click', () => {
      draft = null;
      renderDraft();
    });
    el.draft.replaceChildren(
      h('h3', { className: 'pane-h', textContent: `정리 결과 ${draft.tips.length}개${draft.cost ? ' · ' + draft.cost : ''}` }),
      h('p', { className: 'hint', textContent: '고칠 데는 고치고, 저장할 것만 체크해. 장르를 비우면 공통(모든 작품)이야. 원문도 같이 보관돼.' }),
      h('ul', { className: 'proof-list' }, ...cards),
      h('div', { className: 'proof-btns' }, cancel, saveBtn),
    );
  }

  async function saveDraft() {
    const now = Date.now();
    const fresh = draft.tips
      .filter((t) => t.keep && t.rule)
      .map((t) => ({
        id: uid(),
        rule: t.rule,
        category: t.category,
        when: t.when,
        range: t.when === 'range' ? t.range : null,
        genres: t.genres ?? [],
        on: true,
        offWorks: [],
        source: draft.source,
        original: draft.original,
        conflicts: [],
        createdAt: now,
      }));
    if (!fresh.length) return;
    const existing = notes.filter((n) => n.on);
    await save(fresh);
    draft = null;
    el.text.value = '';
    el.source.value = '';
    renderDraft();
    render();
    // 새 팁과 기존 팁이 부딪히는지 확인
    if (existing.length && ai.hasKey(ai.currentProvider())) {
      el.info.textContent = '기존 팁과 부딪히는 게 있는지 보는 중…';
      try {
        pending = [...pending, ...(await findConflicts(fresh, existing))];
        el.info.textContent = pending.length ? '' : `팁 ${fresh.length}개를 저장했어. 부딪히는 팁은 없어.`;
      } catch (err) {
        el.info.textContent = `팁은 저장했는데 충돌 확인을 못 했어: ${err.message}`;
      }
      renderConflicts();
    } else {
      el.info.textContent = `팁 ${fresh.length}개를 저장했어.`;
    }
  }

  // 충돌 알림: 어느 쪽을 우선할지 고른다. 고른 결과는 두 팁 모두에 적어 둔다.
  function renderConflicts() {
    el.conflicts.replaceChildren(
      ...(pending.length ? [h('h3', { className: 'pane-h', textContent: `부딪히는 팁 ${pending.length}쌍` })] : []),
      ...pending.map((c) => {
        const pick = async (prefer) => {
          c.a.conflicts = [...(c.a.conflicts ?? []).filter((x) => x.with !== c.b.id), { with: c.b.id, prefer, reason: c.reason }];
          const mirror = prefer === 'this' ? 'that' : prefer === 'that' ? 'this' : 'judge';
          c.b.conflicts = [...(c.b.conflicts ?? []).filter((x) => x.with !== c.a.id), { with: c.a.id, prefer: mirror, reason: c.reason }];
          await save([c.a, c.b]);
          pending = pending.filter((x) => x !== c);
          renderConflicts();
          render();
        };
        const btn = (label, prefer) => {
          const b = h('button', { type: 'button', className: 'mini-btn', textContent: label });
          b.addEventListener('click', () => pick(prefer));
          return b;
        };
        return h('div', { className: 'proof-item hook-old' },
          h('p', { className: 'nt-vs' }, h('b', { textContent: 'A (새 팁) ' }), c.a.rule),
          h('p', { className: 'nt-vs' }, h('b', { textContent: 'B (기존) ' }), c.b.rule),
          h('p', { className: 'hint', textContent: c.reason }),
          h('div', { className: 'proof-btns' }, btn('A 우선', 'this'), btn('B 우선', 'that'), btn('상황 보고 판단', 'judge')));
      }),
    );
  }

  const preferText = (n) =>
    (n.conflicts ?? [])
      .map((c) => {
        const other = notes.find((x) => x.id === c.with);
        if (!other) return null;
        const who = c.prefer === 'this' ? '이 팁 우선' : c.prefer === 'that' ? '저 팁 우선' : '상황 보고 판단';
        return `「${other.rule}」과 부딪힘 → ${who}`;
      })
      .filter(Boolean);

  function render() {
    const workId = hooks.workId();
    const cats = ['전체', ...categoriesInUse().filter((c) => notes.some((n) => n.category === c))];
    if (!cats.includes(filter)) filter = '전체';
    el.filter.replaceChildren(
      ...cats.map((c) => {
        const b = h('button', { type: 'button', className: 'chip' + (c === filter ? ' on' : ''), textContent: c === '전체' ? `전체 ${notes.length}` : c });
        b.addEventListener('click', () => {
          filter = c;
          render();
        });
        return b;
      }),
    );
    fillDatalist();
    renderWorkGenre();
    renderLegacy();
    const gOpts = [
      ['all', '모든 장르'],
      ['here', '이 작품에 들어가는 팁'],
      ['common', '공통'],
      ...(notes.some((n) => !Array.isArray(n.genres)) ? [['none', '장르 미정']] : []),
      ...[...new Set(notes.flatMap((n) => n.genres ?? []))].sort().map((g) => [g, g]),
    ];
    if (!gOpts.some(([k]) => k === gFilter)) gFilter = 'all';
    el.genreFilter.replaceChildren(...gOpts.map(([k, v]) => new Option(v, k, false, k === gFilter)));
    const gOk = (n) =>
      gFilter === 'all' ? true
      : gFilter === 'here' ? appliesHere(n)
      : gFilter === 'common' ? Array.isArray(n.genres) && !n.genres.length
      : gFilter === 'none' ? !Array.isArray(n.genres)
      : (n.genres ?? []).includes(gFilter);
    const shown = notes.filter((n) => (filter === '전체' || n.category === filter) && gOk(n));
    el.count.textContent = workId ? `이 작품에 들어가는 팁 ${notes.filter(appliesHere).length}개` : '';

    el.list.replaceChildren(
      ...(shown.length
        ? shown.map((n) => {
            const offHere = (n.offWorks ?? []).includes(workId);
            const on = h('input', { type: 'checkbox', className: 'switch', checked: n.on, title: '모든 작품에서 켜기/끄기' });
            on.addEventListener('change', async () => {
              n.on = on.checked;
              await save([n]);
              render();
            });
            const here = h('input', { type: 'checkbox', checked: offHere, disabled: !workId });
            here.addEventListener('change', async () => {
              n.offWorks = here.checked ? [...new Set([...(n.offWorks ?? []), workId])] : (n.offWorks ?? []).filter((x) => x !== workId);
              await save([n]);
              render();
            });
            const fits = fitsGenre(n, workGenre());
            const meta = [genreLabel(n) + (fits ? '' : ' (이 작품 장르 아님)'), n.category, WHEN[n.when] ?? '', n.when === 'range' && n.range ? `${n.range.from}~${n.range.to}화${n.range.basis ? ` (${n.range.basis}화 기준)` : ''}` : '', n.source ? `출처: ${n.source}` : '']
              .filter(Boolean)
              .join(' · ');

            if (editing === n.id) {
              const copy = { ...n, range: n.range ? { ...n.range } : null, genres: Array.isArray(n.genres) ? [...n.genres] : [] };
              const ok = h('button', { type: 'button', className: 'mini-btn primary', textContent: '저장' });
              ok.addEventListener('click', async () => {
                Object.assign(n, { rule: copy.rule, category: copy.category, when: copy.when, range: copy.when === 'range' ? copy.range : null, genres: copy.genres });
                editing = null;
                await save([n]);
                render();
              });
              const no = h('button', { type: 'button', className: 'mini-btn', textContent: '취소' });
              no.addEventListener('click', () => {
                editing = null;
                render();
              });
              return h('li', { className: 'proof-item' }, ...fields(copy), h('div', { className: 'proof-btns' }, no, ok));
            }

            const edit = h('button', { type: 'button', className: 'mini-btn', textContent: '고치기' });
            edit.addEventListener('click', () => {
              editing = n.id;
              render();
            });
            const del = h('button', { type: 'button', className: 'mini-btn danger', textContent: '지우기' });
            del.addEventListener('click', async () => {
              if (!(await askConfirm(`이 팁을 지울까?\n「${n.rule}」\n모든 작품에서 사라지고 되돌릴 수 없어.`, '지우기', true))) return;
              await db.del('notes', n.id);
              notes = notes.filter((x) => x !== n);
              for (const other of notes) {
                if ((other.conflicts ?? []).some((c) => c.with === n.id)) {
                  other.conflicts = other.conflicts.filter((c) => c.with !== n.id);
                  await save([other]);
                }
              }
              await hooks.onDelete(n.id);
              render();
            });
            const prefs = preferText(n);
            return h('li', { className: 'proof-item' + (n.on && !offHere && fits ? '' : ' hook-done') },
              h('div', { className: 'nt-row' }, on, h('p', { className: 'nt-rule-text', textContent: n.rule })),
              h('p', { className: 'hint', textContent: meta }),
              prefs.length ? h('p', { className: 'hint nt-pref', textContent: prefs.join(' / ') }) : null,
              n.original ? h('details', { className: 'pane-details' }, h('summary', { textContent: '원문 보기' }), h('p', { className: 'nt-original', textContent: n.original })) : null,
              h('div', { className: 'proof-btns' }, h('label', { className: 'nt-here' }, here, ' 이 작품에서 끄기'), edit, del));
          })
        : [h('li', { className: 'hint', textContent: notes.length ? '고른 조건에 맞는 팁이 없어.' : '아직 팁이 없어. 위에 보거나 들은 작법 팁을 붙여넣고 "AI로 정리"를 눌러봐.' })]),
    );
  }

  // 이 작품 장르: 정하면 공통 팁 + 이 장르 팁만 회의·검토에 들어간다
  function renderWorkGenre() {
    const work = hooks.work();
    if (!work) {
      el.workGenre.replaceChildren(h('p', { className: 'hint', textContent: '작품을 열면 그 작품 장르를 정할 수 있어.' }));
      return;
    }
    if (el.workGenre.contains(document.activeElement)) return; // 입력 중이면 건드리지 않음
    const input = genreInput(work.genre ?? '', '예: 현판 › 헌터 › 회빙환');
    const ok = h('button', { type: 'button', className: 'mini-btn primary', textContent: '저장' });
    const apply = async () => {
      let g = normGenre(input.value.split(/[,，]/)[0]);
      if (g === '공통') g = '';
      if (g === (work.genre ?? '')) return;
      await hooks.setWorkGenre(g);
      input.blur();
      el.info.textContent = g ? `이 작품은 「${g}」. 공통 팁이랑 이 장르 팁만 회의에 들어가.` : '장르를 비웠어. 모든 팁이 들어가.';
      render();
    };
    ok.addEventListener('click', apply);
    input.addEventListener('keydown', (e) => e.key === 'Enter' && apply());
    el.workGenre.replaceChildren(
      h('div', { className: 'nt-src-row' }, h('span', { className: 'nt-work', textContent: `「${work.title}」 장르` }), input, ok),
      h('p', { className: 'hint', textContent: work.genre ? '공통 팁 + 이 장르(와 그 위 장르) 팁만 이 작품 회의·검토에 들어가.' : '장르를 안 정하면 모든 팁이 다 들어가. 큰 장르 › 세부 장르 순으로 적어줘.' }),
    );
  }

  // 장르를 정하기 전에 넣은 팁: 한 장르로 묶고, 공통인 건 AI가 골라낸다
  function renderLegacy() {
    const old = notes.filter((n) => !Array.isArray(n.genres));
    if (!old.length) return el.legacy.replaceChildren();
    if (el.legacy.contains(document.activeElement)) return;
    const input = genreInput(workGenre(), '예: 현판 › 헌터 › 회빙환');
    const msg = h('p', { className: 'hint' });
    const all = h('button', { type: 'button', className: 'mini-btn', textContent: '전부 이 장르로' });
    const smart = h('button', { type: 'button', className: 'mini-btn primary', textContent: 'AI로 공통 골라내고 묶기' });
    const target = () => {
      const g = normGenre(input.value.split(/[,，]/)[0]);
      if (!g || g === '공통') {
        msg.textContent = '묶을 장르를 적어줘.';
        input.focus();
        return null;
      }
      return g;
    };
    all.addEventListener('click', async () => {
      const g = target();
      if (!g) return;
      old.forEach((n) => (n.genres = [g]));
      await save(old);
      el.info.textContent = `팁 ${old.length}개를 「${g}」로 묶었어.`;
      render();
    });
    smart.addEventListener('click', async () => {
      const g = target();
      if (!g) return;
      if (!ai.hasKey(ai.currentProvider())) {
        msg.textContent = 'AI 키가 없어. "전부 이 장르로"를 쓰거나 설정에서 키를 넣어줘.';
        return;
      }
      smart.disabled = all.disabled = true;
      msg.textContent = 'AI가 어디서나 통하는 팁을 고르는 중…';
      try {
        const { common, cost } = await splitCommon(old);
        old.forEach((n) => (n.genres = common.has(n) ? [] : [g]));
        await save(old);
        el.info.textContent = `공통 ${common.size}개, 「${g}」 ${old.length - common.size}개로 나눴어${cost ? ' · ' + cost : ''}. 틀린 건 "고치기"에서 장르를 바꿔.`;
        render();
      } catch (err) {
        msg.textContent = err.message;
        smart.disabled = all.disabled = false;
      }
    });
    el.legacy.replaceChildren(
      h('div', { className: 'proof-item hook-old' },
        h('p', { textContent: `장르가 안 정해진 팁 ${old.length}개가 있어. 지금까지 쓰던 장르로 묶어 두면 다른 장르 작품엔 안 들어가.` }),
        h('div', { className: 'nt-src-row' }, input),
        h('div', { className: 'proof-btns' }, all, smart),
        msg),
    );
  }

  el.genreFilter.addEventListener('change', () => {
    gFilter = el.genreFilter.value;
    render();
  });

  el.go.addEventListener('click', async () => {
    const text = el.text.value.trim();
    if (!text) return el.text.focus();
    if (!ai.hasKey(ai.currentProvider())) {
      el.info.textContent = 'AI 키가 없어. 설정(⚙) → AI에서 키를 넣어줘.';
      return;
    }
    el.go.disabled = true;
    el.info.textContent = 'AI가 규칙으로 정리하는 중…';
    try {
      const res = await organize(text, workGenre(), knownGenres());
      if (!res.tips.length) {
        el.info.textContent = '규칙으로 뽑을 만한 걸 못 찾았어. 문장을 조금 더 구체적으로 써줘.';
        return;
      }
      draft = { original: text, source: el.source.value.trim(), tips: res.tips, cost: res.cost };
      el.info.textContent = '';
      renderDraft();
    } catch (err) {
      el.info.textContent = err.message;
    } finally {
      el.go.disabled = false;
    }
  });

  return {
    async open() {
      await load();
      render();
      renderConflicts();
    },
    async reload() {
      if (editing) return;
      await load();
      render();
    },
  };
}
