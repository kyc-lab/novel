// 떡밥 장부: 위키의 "떡밥" 분류 문서들을 장부처럼 본다(회수 여부, 오래 안 풀린 떡밥 알림).
// 떡밥 문서에는 doc.hook = { first: 처음 나온 회차, resolved: 회수한 회차 또는 null } 을 붙인다.

import * as settings from './settings.js';

const $ = (sel) => document.querySelector(sel);

function h(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...kids.filter((k) => k != null));
  return node;
}

// 예전에 만든 떡밥 문서(hook 정보 없이 본문에 "처음 나온 곳: N화"만 있는 것)도 읽는다.
export function hookOf(doc) {
  if (doc.hook) return doc.hook;
  const m = /처음 나온 곳:\s*(\d+)화/.exec(doc.body ?? '');
  return { first: m ? Number(m[1]) : 0, resolved: null };
}

const firstLine = (body) =>
  (body ?? '')
    .split('\n')
    .map((s) => s.trim())
    .find((s) => s && !s.startsWith('- 처음 나온 곳') && !s.startsWith('- 회수')) ?? '';

export function initPane(ctx, { onBadge }) {
  const el = { alert: $('#hookAlert'), list: $('#hookList'), title: $('#hookTitle'), detail: $('#hookDetail'), add: $('#hookAdd'), age: $('#hookAge') };
  const ageLimit = () => settings.get().hookAge || 10;

  el.age.addEventListener('change', () => {
    const n = Math.max(1, Math.round(Number(el.age.value)) || 10);
    settings.update({ hookAge: n });
    render();
  });
  for (const r of document.querySelectorAll('input[name="hookFilter"]')) r.addEventListener('change', () => render());

  async function setResolved(doc, resolved) {
    await ctx.mutateWiki((docs) => {
      const d = docs.find((x) => x.id === doc.id);
      if (!d) return [];
      d.hook = { ...hookOf(d), resolved };
      return [d];
    });
    render();
  }

  el.add.addEventListener('click', async () => {
    const title = el.title.value.trim();
    if (!title) return el.title.focus();
    const no = ctx.noOf(ctx.chapter()) || 1;
    await ctx.mutateWiki((docs, { newDoc }) => {
      if (docs.some((d) => d.category === '떡밥' && d.title.trim() === title)) return [];
      return [newDoc({ title, category: '떡밥', body: el.detail.value.trim(), hook: { first: no, resolved: null } })];
    });
    el.title.value = '';
    el.detail.value = '';
    render();
  });

  async function render() {
    el.age.value = ageLimit();
    const latest = ctx.chapters().length;
    const filter = document.querySelector('input[name="hookFilter"]:checked')?.value ?? 'open';
    const all = (await ctx.wikiDocs())
      .filter((d) => d.category === '떡밥')
      .map((d) => ({ d, hk: hookOf(d) }))
      .sort((a, b) => a.hk.first - b.hk.first);
    const old = all.filter(({ hk }) => !hk.resolved && hk.first && latest - hk.first >= ageLimit());
    onBadge(old.length);
    el.alert.hidden = !old.length;
    el.alert.textContent = old.length ? `${ageLimit()}화 넘게 안 풀린 떡밥이 ${old.length}개 있어: ${old.map(({ d }) => d.title).join(', ')}` : '';

    const shown = all.filter(({ hk }) => (filter === 'all' ? true : filter === 'done' ? !!hk.resolved : !hk.resolved));
    if (!shown.length) {
      el.list.replaceChildren(h('li', { className: 'hint', textContent: filter === 'done' ? '회수한 떡밥이 아직 없어.' : '떡밥이 없어. 회차 완료 검토에서 체크하거나 아래에서 직접 추가해.' }));
      return;
    }
    el.list.replaceChildren(
      ...shown.map(({ d, hk }) => {
        const age = hk.first ? latest - hk.first : null;
        const state = hk.resolved ? `${hk.first}화 → ${hk.resolved}화에 회수` : hk.first ? `${hk.first}화에 나옴 · ${age}화째 안 풀림` : '처음 나온 회차 모름';
        const toggle = h('button', { type: 'button', className: 'mini-btn' + (hk.resolved ? '' : ' primary'), textContent: hk.resolved ? '다시 열기' : '이 회차에서 회수' });
        toggle.addEventListener('click', () => setResolved(d, hk.resolved ? null : ctx.noOf(ctx.chapter()) || latest));
        const open = h('button', { type: 'button', className: 'mini-btn', textContent: '위키에서 보기' });
        open.addEventListener('click', () => ctx.openWikiDoc(d.id));
        const isOld = !hk.resolved && age != null && age >= ageLimit();
        return h('li', { className: 'proof-item' + (hk.resolved ? ' hook-done' : '') + (isOld ? ' hook-old' : '') },
          h('div', { className: 'proof-head' }, h('b', { textContent: d.title }), h('span', { textContent: state })),
          firstLine(d.body) ? h('p', { className: 'proof-sum', textContent: firstLine(d.body) }) : null,
          h('div', { className: 'proof-btns' }, open, toggle));
      }),
    );
  }

  return { render };
}
