// 점검: 작가가 정한 체크리스트(쇠맛 점검 포함)와 설정 충돌 찾기.

import * as ai from './ai.js';
import * as settings from './settings.js';
import { summariesText, loreText } from './context.js';

export const DEFAULT_ITEMS = ['도입부 후킹이 적절한가', '사이다(통쾌한 장면)가 있는가', '회차 끝 절단(다음 화가 궁금한가)', '쇠맛 점검'];
const GRADES = ['○', '△', '✕'];

const SOE = `"쇠맛 점검" 항목이 있으면 AI 특유 문체를 찾는다:
마치~처럼 비유 남발, 감정을 직접 서술("슬펐다", "화가 났다"), 세 개씩 나열, 문장 길이가 고르게 비슷함, 교훈조 마무리, 번역투·"그녀", 설명조 대사.
찾은 곳은 soe 에 {"type":"어떤 쇠맛","quote":"원문 그대로 40자 이내","reason":"짧게"} 로, 많아야 12개.`;

const CHECK = `너는 한국 웹소설 편집자다. 작가가 정한 점검 항목마다 이 회차를 평가한다.
- grade: ○(잘 됨) / △(아쉬움) / ✕(안 됨) 중 하나
- reason: 한두 문장, 구체적으로
- quotes: 근거가 되는 원문 구절. 원문 글자 그대로 복사, 각 40자 이내, 0~3개
${SOE}
출력은 JSON 객체 하나: {"items":[{"name":"항목 이름 그대로","grade":"○","reason":"","quotes":[]}],"soe":[]}`;

const CONFLICT = `너는 연재 웹소설의 설정 검수자다. "지금까지의 설정"(이전 회차까지의 요약과 인물 상태)과 "이번 회차 원고"를 비교해 모순만 찾는다.
예: 죽은 인물이 멀쩡히 등장, 잃은 물건을 다시 씀, 능력·레벨이 앞뒤가 안 맞음, 관계·소속이 어긋남, 사건 순서가 안 맞음.
확실한 것만 낸다. 없으면 빈 배열.
- quote: 이번 회차 원문 글자 그대로 40자 이내
- problem: 무엇이 어긋나는지
- ref: 근거가 된 설정(몇 화의 무엇)
출력은 JSON 객체 하나: {"conflicts":[{"quote":"","problem":"","ref":""}]}`;

const parse = (text) => {
  try {
    return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch {
    return {};
  }
};
const list = (x) => (Array.isArray(x) ? x : []);
const $ = (sel) => document.querySelector(sel);

function h(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...kids.filter((k) => k != null));
  return node;
}

export function initPane(ctx) {
  const el = {
    info: $('#checkInfo'),
    run: $('#checkRun'),
    items: $('#checkItems'),
    sum: $('#checkSum'),
    list: $('#checkList'),
    cRun: $('#conflictRun'),
    cSum: $('#conflictSum'),
    cList: $('#conflictList'),
  };
  let fresh = null; // 방금 돌린 점검 결과 { chapterId, items, soe, cost }
  let conflicts = null; // { chapterId, list, cost }

  const items = () => {
    const saved = settings.get().checkItems;
    return Array.isArray(saved) && saved.length ? saved : DEFAULT_ITEMS;
  };
  el.items.addEventListener('change', () => {
    const lines = el.items.value.split('\n').map((s) => s.trim()).filter(Boolean);
    settings.update({ checkItems: lines.length ? lines : DEFAULT_ITEMS });
  });

  const quoteBtn = (quote) => {
    const b = h('button', { type: 'button', textContent: `“${quote}”`, title: '원고에서 이 자리로 가기' });
    b.addEventListener('click', () => ctx.goToText(quote));
    return b;
  };

  function renderCheck() {
    const ch = ctx.chapter();
    el.items.value = items().join('\n');
    const hasKey = ai.hasKey(ai.currentProvider());
    el.run.disabled = !hasKey;
    el.cRun.disabled = !hasKey;
    el.info.textContent = hasKey ? `항목 ${items().length}개를 AI가 ○/△/✕로 봐. 판정은 네가 바꿀 수 있어.` : 'AI 키가 없어. 설정(⚙) → AI에서 키를 넣어줘.';

    // 방금 돌린 결과가 없으면, 이 회차에 저장해 둔 확정 결과를 보여준다.
    const shown = fresh?.chapterId === ch?.id ? fresh : ch?.check ? { ...ch.check, saved: true } : null;
    if (!shown) {
      el.sum.textContent = '';
      el.list.replaceChildren();
    } else {
      el.sum.textContent = shown.saved
        ? `확정한 점검 결과 (${new Date(shown.at).toLocaleDateString('ko-KR')})`
        : `점검 결과${shown.cost ? ' · ' + shown.cost : ''} · 판정을 고르고 "확정 저장"을 눌러.`;
      const cards = shown.items.map((it) => {
        const sel = h('select', { title: '판정(네가 확정)' });
        for (const g of GRADES) sel.append(new Option(g, g, false, g === it.grade));
        const grade = h('span', { className: 'grade g' + Math.max(0, GRADES.indexOf(it.grade)) }, sel);
        sel.addEventListener('change', () => {
          it.grade = sel.value;
          grade.className = 'grade g' + GRADES.indexOf(sel.value);
        });
        return h('li', { className: 'proof-item' },
          h('div', { className: 'proof-head' }, grade, h('b', { textContent: it.name })),
          h('p', { className: 'proof-sum', textContent: it.reason }),
          list(it.quotes).length ? h('div', { className: 'check-quotes' }, ...list(it.quotes).map(quoteBtn)) : null);
      });
      for (const s of list(shown.soe)) {
        cards.push(
          h('li', { className: 'proof-item suggest' },
            h('div', { className: 'proof-head' }, h('span', { className: 'proof-tag', textContent: '쇠맛' }), h('span', { textContent: `${s.type} · ${s.reason}` })),
            h('div', { className: 'check-quotes' }, quoteBtn(s.quote))),
        );
      }
      if (!shown.saved) {
        const save = h('button', { type: 'button', className: 'mini-btn primary', textContent: '확정 저장' });
        save.addEventListener('click', async () => {
          await ctx.updateChapter(ch, { check: { at: Date.now(), items: shown.items.map(({ name, grade, reason }) => ({ name, grade, reason })), soe: list(shown.soe) } });
          fresh = null;
          renderCheck();
        });
        cards.push(h('li', { className: 'proof-btns' }, save));
      }
      el.list.replaceChildren(...cards);
    }

    if (conflicts && conflicts.chapterId === ch?.id) {
      el.cSum.textContent = conflicts.list.length ? `어긋나는 곳 ${conflicts.list.length}개${conflicts.cost ? ' · ' + conflicts.cost : ''}` : `어긋나는 곳을 못 찾았어.${conflicts.cost ? ' · ' + conflicts.cost : ''}`;
      el.cList.replaceChildren(
        ...conflicts.list.map((c) =>
          h('li', { className: 'proof-item' },
            h('div', { className: 'proof-head' }, h('span', { className: 'proof-tag', textContent: '충돌' }), h('span', { textContent: c.problem })),
            c.quote ? h('div', { className: 'check-quotes' }, quoteBtn(c.quote)) : null,
            c.ref ? h('p', { className: 'hint', textContent: `설정: ${c.ref}` }) : null),
        ),
      );
    } else {
      el.cSum.textContent = '';
      el.cList.replaceChildren();
    }
  }

  el.run.addEventListener('click', async () => {
    const ch = ctx.chapter();
    if (!ch || !ctx.editor.value.trim()) return (el.sum.textContent = '본문이 비어 있어.');
    el.run.disabled = true;
    el.sum.textContent = 'AI가 점검하는 중…';
    el.list.replaceChildren();
    try {
      const names = items();
      const res = await ai.ask({ system: CHECK, user: `점검 항목:\n${names.map((n) => '- ' + n).join('\n')}\n\n이번 회차 원고:\n${ctx.editor.value}`, json: true });
      const data = parse(res.text);
      const got = list(data.items);
      fresh = {
        chapterId: ch.id,
        items: names.map((name) => {
          const it = got.find((x) => x.name === name) ?? got[names.indexOf(name)] ?? {};
          return { name, grade: GRADES.includes(it.grade) ? it.grade : '△', reason: String(it.reason ?? ''), quotes: list(it.quotes).map(String) };
        }),
        soe: names.includes('쇠맛 점검') ? list(data.soe).filter((s) => s.quote).map((s) => ({ type: String(s.type ?? '쇠맛'), quote: String(s.quote), reason: String(s.reason ?? '') })) : [],
        cost: ai.fmtWon(ai.estimateWon(res.provider, res.model, res.usage)),
      };
    } catch (err) {
      el.sum.textContent = err.message;
      return;
    } finally {
      el.run.disabled = false;
    }
    renderCheck();
  });

  el.cRun.addEventListener('click', async () => {
    const ch = ctx.chapter();
    if (!ch || !ctx.editor.value.trim()) return (el.cSum.textContent = '본문이 비어 있어.');
    const no = ctx.noOf(ch);
    el.cRun.disabled = true;
    el.cSum.textContent = 'AI가 설정과 비교하는 중…';
    el.cList.replaceChildren();
    try {
      const before = `지금까지의 설정\n회차 요약(${no - 1}화까지):\n${summariesText(ctx, { upto: no - 1 }) || '없음'}\n\n위키(${no - 1}화 기준 인물 상태 포함):\n${await loreText(ctx, { upto: no - 1 })}`;
      const res = await ai.ask({ system: CONFLICT, user: `${before}\n\n이번 회차(${no}화) 원고:\n${ctx.editor.value}`, json: true });
      conflicts = {
        chapterId: ch.id,
        list: list(parse(res.text).conflicts).filter((c) => c && c.problem).map((c) => ({ quote: String(c.quote ?? ''), problem: String(c.problem), ref: String(c.ref ?? '') })),
        cost: ai.fmtWon(ai.estimateWon(res.provider, res.model, res.usage)),
      };
    } catch (err) {
      el.cSum.textContent = err.message;
      return;
    } finally {
      el.cRun.disabled = false;
    }
    renderCheck();
  });

  return { render: renderCheck };
}
