// 설정집 탭: 원고를 쓰다가 위키를 빠르게 찾아본다(읽기만). 고치려면 "위키에서 열기".

import { compute, describe } from './status.js';

const $ = (sel) => document.querySelector(sel);
const plain = (s) => s.replace(/\[\[([^\[\]|]+)(?:\|([^\[\]]+))?\]\]/g, (_, a, b) => (b ?? a));

function h(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...kids.filter((k) => k != null));
  return node;
}

export function initPane(ctx) {
  const el = { search: $('#loreSearch'), list: $('#loreList'), doc: $('#loreDoc') };
  let openId = null;

  async function render() {
    const q = el.search.value.trim().toLowerCase();
    const docs = (await ctx.wikiDocs())
      .filter((d) => d.title.trim())
      .filter((d) => !q || d.title.toLowerCase().includes(q) || d.body.toLowerCase().includes(q))
      .sort((a, b) => a.category.localeCompare(b.category, 'ko') || a.title.localeCompare(b.title, 'ko'));
    el.list.replaceChildren(
      ...(docs.length
        ? docs.slice(0, 50).map((d) => {
            const b = h('button', { type: 'button' }, h('span', { className: 'cat', textContent: d.category }), h('span', { textContent: d.title }));
            b.addEventListener('click', () => {
              openId = d.id;
              render();
            });
            return h('li', {}, b);
          })
        : [h('li', { className: 'hint', textContent: q ? '찾는 문서가 없어.' : '위키가 비어 있어. 위쪽 "위키"에서 문서를 만들어.' })]),
    );
    const doc = docs.find((d) => d.id === openId) ?? (await ctx.wikiDocs()).find((d) => d.id === openId);
    el.doc.hidden = !doc;
    if (!doc) return;
    const no = ctx.noOf(ctx.chapter());
    const rows = describe(compute(doc.status ?? [], no || Infinity));
    const go = h('button', { type: 'button', className: 'mini-btn', textContent: '위키에서 열기' });
    go.addEventListener('click', () => ctx.openWikiDoc(doc.id));
    const st = h('dl', { className: 'st-now' });
    for (const [k, v] of rows) st.append(h('dt', { textContent: k }), h('dd', { textContent: v }));
    el.doc.replaceChildren(
      ...[
      h('div', { className: 'proof-top' }, h('h3', { textContent: doc.title, style: 'flex:1' }), go),
      rows.length ? h('p', { className: 'hint', textContent: `${no}화 기준 상태` }) : null,
      rows.length ? st : null,
      h('div', { className: 'body', textContent: plain(doc.body) || '(내용 없음)' }),
      ].filter(Boolean),
    );
  }

  el.search.addEventListener('input', () => {
    openId = null;
    render();
  });
  return { render };
}
