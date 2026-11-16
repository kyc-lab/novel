// 인물 상태(설정집). 위키 인물 문서의 doc.status 에 "몇 화에 무엇이 어떻게 바뀌었나"를 한 줄씩 쌓는다.
// 한 줄 = { id, chapterId, no(몇 화), kind(항목), key(이름: 상태창·관계에서만), value, op('add'|'remove') }
// "N화 기준" 상태는 N화까지의 줄을 차례로 적용해서 계산한다.

// 항목 종류. mode:
//   single = 값 하나(가장 나중 것)    keyed = 이름별로 값 하나(예: 힘 → 32)
//   set    = 여러 개(얻고 잃음)        list  = 있는 그대로 다 보여줌
export const KINDS = [
  { id: '생존', mode: 'single', hint: '생존 / 사망 / 부상 / 실종 …' },
  { id: '레벨', mode: 'single', hint: 'Lv.15, B급, 3성 …' },
  { id: '상태창', mode: 'keyed', keyHint: '항목(힘, 칭호, 직업 …)', hint: '값' },
  { id: '능력', mode: 'set', hint: '스킬·능력 이름' },
  { id: '소지품', mode: 'set', hint: '물건 이름' },
  { id: '관계', mode: 'keyed', keyHint: '상대 인물', hint: '관계(연인, 적대 …)' },
  { id: '소속', mode: 'single', hint: '단체·세력' },
  { id: '기타', mode: 'list', hint: '그 밖의 중요한 변화' },
];
export const KIND = Object.fromEntries(KINDS.map((k) => [k.id, k]));
export const kindOf = (id) => KIND[id] ?? KIND['기타'];

const uid = () => crypto.randomUUID();
export const makeEntry = ({ chapterId = null, no, kind, key = '', value, op = 'add' }) => ({
  id: uid(),
  chapterId,
  no: Number(no) || 0,
  kind: KIND[kind] ? kind : '기타',
  key: String(key ?? '').trim(),
  value: String(value ?? '').trim(),
  op: op === 'remove' ? 'remove' : 'add',
});

// 회차 순서대로(같은 회차면 쌓인 순서대로)
const ordered = (entries) => entries.map((e, i) => [e, i]).sort((a, b) => a[0].no - b[0].no || a[1] - b[1]).map(([e]) => e);

// upto화까지의 상태. 돌려주는 것: { 생존: {value,no}, 상태창: Map(key→{value,no}), 능력: Map(value→no), 기타: [{value,no}] … }
export function compute(entries = [], upto = Infinity) {
  const st = {};
  for (const k of KINDS) st[k.id] = k.mode === 'single' ? null : k.mode === 'list' ? [] : new Map();
  for (const e of ordered(entries)) {
    if (e.no > upto) continue;
    const k = kindOf(e.kind);
    if (k.mode === 'single') st[k.id] = e.op === 'remove' ? null : { value: e.value, no: e.no };
    else if (k.mode === 'keyed') {
      const key = e.key || e.value;
      if (e.op === 'remove') st[k.id].delete(key);
      else st[k.id].set(key, { value: e.key ? e.value : '', no: e.no });
    } else if (k.mode === 'set') {
      if (e.op === 'remove') st[k.id].delete(e.value);
      else st[k.id].set(e.value, e.no);
    } else st[k.id].push({ value: e.value, no: e.no });
  }
  return st;
}

// 상태를 사람이 읽는 줄들로: [[항목, '내용'], …]
export function describe(st) {
  const rows = [];
  for (const k of KINDS) {
    const v = st[k.id];
    if (k.mode === 'single' && v) rows.push([k.id, `${v.value} (${v.no}화)`]);
    if (k.mode === 'keyed' && v.size) rows.push([k.id, [...v].map(([key, x]) => (x.value ? `${key} ${x.value}` : key)).join(', ')]);
    if (k.mode === 'set' && v.size) rows.push([k.id, [...v.keys()].join(', ')]);
    if (k.mode === 'list' && v.length) rows.push([k.id, v.map((x) => `${x.value}(${x.no}화)`).join(', ')]);
  }
  return rows;
}

// AI에게 넘길 한 줄 요약: "철수 — 생존: 생존 / 능력: 회귀, 검술 / …"
export const oneLine = (name, entries) => {
  const rows = describe(compute(entries));
  return rows.length ? `${name} — ${rows.map(([k, v]) => `${k}: ${v}`).join(' / ')}` : `${name} — (기록 없음)`;
};

export const entryText = (e) => {
  const k = kindOf(e.kind);
  const body = k.mode === 'keyed' && e.key ? `${e.key} ${e.value}` : e.value;
  return e.op === 'remove' ? `${body} (잃음·끝남)` : body;
};

// ───────── 위키 인물 문서 안의 "상태" 칸 ─────────
// onAdd(entry), onDelete(id) 를 부른다. 저장은 부르는 쪽(wiki.js)이 한다.

function h(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...kids.filter((k) => k != null));
  return node;
}

export function renderSection(doc, { upto = Infinity, onUpto, onAdd, onDelete }) {
  const entries = doc.status ?? [];
  const nos = [...new Set(entries.map((e) => e.no))].sort((a, b) => a - b);

  const head = h('div', { className: 'st-head' }, h('h3', { textContent: '상태' }));
  if (nos.length) {
    const sel = h('select', { className: 'st-upto', title: '이 회차까지의 상태 보기' });
    sel.append(new Option('최신', 'all', false, upto === Infinity));
    for (const n of nos) sel.append(new Option(`${n}화 기준`, n, false, upto === n));
    sel.addEventListener('change', () => onUpto(sel.value === 'all' ? Infinity : Number(sel.value)));
    head.append(sel);
  }

  const rows = describe(compute(entries, upto));
  const now = h('dl', { className: 'st-now' });
  if (rows.length) for (const [k, v] of rows) now.append(h('dt', { textContent: k }), h('dd', { textContent: v }));
  else now.append(h('p', { className: 'hint', textContent: '아직 기록이 없어. 회차 완료 검토에서 반영하거나 아래에서 직접 추가해.' }));

  // 변화 기록 표
  const log = h('details', { className: 'st-log' }, h('summary', { textContent: `변화 기록 ${entries.length}개` }));
  const table = h('table');
  for (const e of ordered(entries)) {
    const del = h('button', { type: 'button', className: 'st-del', textContent: '✕', title: '이 기록 지우기' });
    del.addEventListener('click', () => onDelete(e.id));
    table.append(
      h('tr', { className: e.no > upto ? 'later' : '' },
        h('td', { textContent: `${e.no}화` }),
        h('td', { textContent: e.kind }),
        h('td', { textContent: entryText(e) }),
        h('td', {}, del)),
    );
  }
  if (entries.length) log.append(table);

  // 직접 추가
  const add = h('details', { className: 'st-add' }, h('summary', { textContent: '＋ 상태 직접 추가' }));
  const no = h('input', { type: 'number', min: 0, placeholder: '몇 화', className: 'st-no', value: nos.at(-1) ?? '' });
  const kind = h('select');
  for (const k of KINDS) kind.append(new Option(k.id, k.id));
  const key = h('input', { type: 'text', className: 'st-key' });
  const value = h('input', { type: 'text', className: 'st-val' });
  const op = h('select');
  op.append(new Option('얻음·바뀜', 'add'), new Option('잃음·끝남', 'remove'));
  const ok = h('button', { type: 'button', className: 'mini-btn primary', textContent: '추가' });
  const sync = () => {
    const k = kindOf(kind.value);
    key.hidden = k.mode !== 'keyed';
    key.placeholder = k.keyHint ?? '';
    value.placeholder = k.hint;
  };
  kind.addEventListener('change', sync);
  sync();
  ok.addEventListener('click', () => {
    if (!value.value.trim() && !key.value.trim()) return value.focus();
    onAdd(makeEntry({ no: no.value, kind: kind.value, key: key.value, value: value.value, op: op.value }));
  });
  add.append(h('div', { className: 'st-add-row' }, no, kind, key, value, op, ok));

  return h('section', { className: 'st' }, head, now, log, add);
}
