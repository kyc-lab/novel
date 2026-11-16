// 회차 완료 검토: AI가 줄거리 요약 · 인물 상태 변화 · 새 떡밥 후보를 초안으로 내고, 작가가 체크해서 반영한다.

import * as ai from './ai.js';
import { KINDS, kindOf, makeEntry, oneLine } from './status.js';

const SYSTEM = `너는 웹소설 편집 보조다. 회차 원고를 읽고 작가가 설정집을 관리할 수 있게 정리한다.

1. summary: 이 회차 줄거리 3~6문장. 일어난 일 위주로, 평가·감상 없이.
2. changes: 이 회차에서 새로 생기거나 바뀐 인물 상태만. "현재 설정"과 같은 내용이면 넣지 않는다.
   kind 는 다음 중 하나:
   - 생존: value = 생존 / 사망 / 부상 / 실종 / 봉인 같은 지금 상태
   - 레벨: value = 레벨·등급 (예: Lv.15, B급)
   - 상태창: key = 항목 이름(힘, 민첩, 칭호, 직업 등 상태창에 나온 것), value = 값
   - 능력: value = 스킬·능력 이름. 잃으면 op = remove
   - 소지품: value = 물건 이름. 잃거나 다 쓰면 op = remove
   - 관계: key = 상대 인물 이름, value = 관계(연인, 적대, 사제, 동료 등)
   - 소속: value = 단체·세력 이름
   - 기타: value = 위에 안 맞는 중요한 변화
   op 는 add(새로 얻음·바뀜) 또는 remove(잃음·끝남).
   name 은 인물 이름. "현재 설정"에 있는 인물이면 그 이름을 똑같이 쓴다.
   evidence 는 원고에서 근거가 되는 짧은 구절(30자 이내).
   원고에 확실히 나온 것만 쓴다. 추측하지 않는다.
3. hooks: 이번 회차에 새로 깔린 떡밥(아직 설명·회수되지 않은 수수께끼, 복선, 약속). title 은 짧게, detail 은 한두 문장. 많아야 5개.

출력은 JSON 객체 하나만:
{"summary":"...","changes":[{"name":"","kind":"","key":"","value":"","op":"add","evidence":""}],"hooks":[{"title":"","detail":""}]}`;

// AI 초안 받기
async function draft({ no, title, body, persons, prevSummary }) {
  const known = persons.length ? persons.map((p) => '- ' + oneLine(p.title, p.status ?? [])).join('\n').slice(0, 4000) : '없음';
  const user =
    `현재 설정(인물별 최신 상태):\n${known}\n\n` +
    `직전 회차 요약:\n${prevSummary || '없음'}\n\n` +
    `이번 회차: ${no}화${title ? ' ' + title : ''}\n원고:\n${body}`;
  const res = await ai.ask({ system: SYSTEM, user, json: true });
  let data = {};
  try {
    data = JSON.parse(res.text.slice(res.text.indexOf('{'), res.text.lastIndexOf('}') + 1));
  } catch {
    throw new Error('AI 답을 읽지 못했어. 한 번 더 해줘.');
  }
  return {
    summary: String(data.summary ?? '').trim(),
    changes: (Array.isArray(data.changes) ? data.changes : [])
      .filter((c) => c && (c.value || c.key) && c.name)
      .map((c) => ({
        on: true,
        name: String(c.name).trim(),
        kind: kindOf(c.kind).id,
        key: String(c.key ?? '').trim(),
        value: String(c.value ?? '').trim(),
        op: c.op === 'remove' ? 'remove' : 'add',
        evidence: String(c.evidence ?? '').trim(),
      })),
    hooks: (Array.isArray(data.hooks) ? data.hooks : [])
      .filter((x) => x && x.title)
      .map((x) => ({ on: true, title: String(x.title).trim(), detail: String(x.detail ?? '').trim() })),
    costText: ai.fmtWon(ai.estimateWon(res.provider, res.model, res.usage)),
  };
}

// ───────── 검토 창 ─────────

const $ = (sel) => document.querySelector(sel);
const dlg = $('#reviewDlg');
const steps = { start: $('#rvStart'), wait: $('#rvWait'), edit: $('#rvEdit') };

function show(step) {
  for (const [k, node] of Object.entries(steps)) node.hidden = k !== step;
}

function h(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...kids.filter((k) => k != null));
  return node;
}

function renderChanges(list, persons) {
  const box = $('#rvChanges');
  const names = $('#rvNames');
  names.replaceChildren(...persons.map((p) => new Option(p.title)));
  if (!list.length) {
    box.replaceChildren(h('p', { className: 'hint', textContent: '이번 회차에서 바뀐 인물 상태가 없대.' }));
    return;
  }
  box.replaceChildren(
    ...list.map((c) => {
      const on = h('input', { type: 'checkbox', checked: c.on, title: '반영할지' });
      on.addEventListener('change', () => (c.on = on.checked));
      const name = h('input', { type: 'text', value: c.name, className: 'rv-name', placeholder: '인물' });
      name.setAttribute('list', 'rvNames');
      name.addEventListener('input', () => (c.name = name.value.trim()));
      const kind = h('select');
      for (const k of KINDS) kind.append(new Option(k.id, k.id, false, k.id === c.kind));
      const key = h('input', { type: 'text', value: c.key, className: 'rv-key' });
      const value = h('input', { type: 'text', value: c.value, className: 'rv-val' });
      const op = h('select');
      op.append(new Option('얻음·바뀜', 'add', false, c.op === 'add'), new Option('잃음·끝남', 'remove', false, c.op === 'remove'));
      const sync = () => {
        const k = kindOf(kind.value);
        key.hidden = k.mode !== 'keyed';
        key.placeholder = k.keyHint ?? '';
        value.placeholder = k.hint;
      };
      kind.addEventListener('change', () => {
        c.kind = kind.value;
        sync();
      });
      key.addEventListener('input', () => (c.key = key.value.trim()));
      value.addEventListener('input', () => (c.value = value.value.trim()));
      op.addEventListener('change', () => (c.op = op.value));
      sync();
      const isNew = !persons.some((p) => p.title === c.name);
      return h('li', { className: 'rv-row' },
        h('div', { className: 'rv-line' }, on, name, kind, key, value, op),
        h('p', { className: 'hint rv-ev', textContent: (isNew ? '새 인물 · ' : '') + (c.evidence ? `근거: ${c.evidence}` : '') }));
    }),
  );
}

function renderHooks(list) {
  const box = $('#rvHooks');
  if (!list.length) {
    box.replaceChildren(h('p', { className: 'hint', textContent: '새 떡밥 후보가 없대.' }));
    return;
  }
  box.replaceChildren(
    ...list.map((x) => {
      const on = h('input', { type: 'checkbox', checked: x.on });
      on.addEventListener('change', () => (x.on = on.checked));
      const title = h('input', { type: 'text', value: x.title, className: 'rv-hook-title' });
      title.addEventListener('input', () => (x.title = title.value.trim()));
      const detail = h('textarea', { value: x.detail, rows: 2, className: 'rv-hook-detail' });
      detail.addEventListener('input', () => (x.detail = detail.value.trim()));
      return h('li', { className: 'rv-row' }, h('div', { className: 'rv-line' }, on, title), detail);
    }),
  );
}

// 회차 완료를 눌렀을 때 연다. 돌려주는 것:
//   null(취소) / { mode: 'plain' }(AI 없이) / { mode: 'later' }(나중에 검토) / { mode: 'apply', summary, changes, hooks }
export function open({ no, title, chars, body, persons, prevSummary, saveWhere }) {
  return new Promise((resolve) => {
    let data = null;
    const done = (value) => {
      dlg.onclose = null;
      if (dlg.open) dlg.close();
      resolve(value);
    };
    dlg.onclose = () => resolve(null); // Esc 등으로 닫힘 = 취소

    $('#rvTitle').textContent = `${no}화 「${title || '제목 없음'}」 완료`;
    $('#rvWhere').textContent = `${chars}자 · ${saveWhere}`;
    const provider = ai.currentProvider();
    const hasKey = ai.hasKey(provider);
    $('#rvAi').disabled = !hasKey;
    $('#rvAiHint').textContent = hasKey
      ? `${ai.PROVIDERS[provider].name}(${ai.currentModel(provider)})가 요약·인물 상태 변화·떡밥 후보를 뽑아. 쓴 만큼 요금이 나가.`
      : 'AI 키가 없어서 AI 검토는 못 해. 설정(⚙) → AI에서 키를 넣으면 쓸 수 있어.';
    show('start');
    if (!dlg.open) dlg.showModal();

    $('#rvCancel').onclick = () => done(null);
    $('#rvPlain').onclick = () => done({ mode: 'plain' });
    $('#rvLater').onclick = () => done({ mode: 'later' });
    $('#rvApply').onclick = () =>
      done({
        mode: 'apply',
        summary: $('#rvSummary').value.trim(),
        changes: data.changes.filter((c) => c.on && c.name && (c.value || c.key)),
        hooks: data.hooks.filter((x) => x.on && x.title),
      });
    $('#rvCancel2').onclick = () => done(null);

    $('#rvAi').onclick = async () => {
      show('wait');
      try {
        data = await draft({ no, title, body, persons, prevSummary });
      } catch (err) {
        show('start');
        $('#rvAiHint').textContent = err.message;
        return;
      }
      $('#rvSummary').value = data.summary;
      $('#rvCost').textContent = data.costText ? `AI 비용 ${data.costText}` : '';
      renderChanges(data.changes, persons);
      renderHooks(data.hooks);
      show('edit');
    };
  });
}

// 검토 결과를 위키에 반영한다. 고친 문서 목록을 돌려준다.
// changes → 인물 문서의 상태 기록, hooks → "떡밥" 분류 문서
export function applyToWiki(docs, { newDoc }, { chapterId, no, changes, hooks }) {
  const changed = new Set();
  // 같은 회차를 다시 검토했으면, 그 회차에서 나온 예전 기록은 지우고 새로 넣는다.
  for (const d of docs) {
    if (d.status?.some((e) => e.chapterId === chapterId)) {
      d.status = d.status.filter((e) => e.chapterId !== chapterId);
      changed.add(d);
    }
  }
  const findDoc = (title, category) =>
    docs.find((d) => d.title.trim() === title && d.category === category) ?? docs.find((d) => d.title.trim() === title);
  for (const c of changes) {
    let doc = findDoc(c.name, '인물');
    if (!doc) {
      doc = newDoc({ title: c.name, category: '인물' });
      docs.push(doc);
    }
    doc.status = [...(doc.status ?? []), makeEntry({ chapterId, no, kind: c.kind, key: c.key, value: c.value, op: c.op })];
    changed.add(doc);
  }
  for (const x of hooks) {
    if (findDoc(x.title, '떡밥')) continue;
    // 떡밥 장부가 읽는 정보는 hook 에. 본문에는 설명만.
    const doc = newDoc({ title: x.title, category: '떡밥', body: x.detail, hook: { first: no, resolved: null } });
    docs.push(doc);
    changed.add(doc);
  }
  return [...changed];
}
