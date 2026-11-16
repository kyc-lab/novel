// 원고 질문: "철수 몇 화에서 죽었지?" 같은 걸 묻는다.
// 비용을 아끼려고 먼저 요약·위키만 보고, 모자라면 필요한 회차 원문만(많아야 3개) 더 읽는다.

import * as ai from './ai.js';
import { summariesText, loreText } from './context.js';

const RULES = `너는 웹소설 작가의 원고 비서다. 주어진 자료만 근거로 작가의 질문에 한국어로 짧고 정확하게 답한다.
- 자료에 없는 내용은 지어내지 않는다. 모르면 모른다고 한다.
- chapters 에는 답의 근거가 된 회차 번호(숫자)를 넣는다.`;

const STEP1 = `${RULES}
- 요약·위키만으로 확실히 답할 수 있으면 answer 에 답을 쓰고 need 는 빈 배열로 둔다.
- 원문을 봐야 정확히 답할 수 있으면 answer 는 빈 문자열로 두고 need 에 읽어야 할 회차 번호를 많아야 3개 넣는다.
출력은 JSON 객체 하나: {"answer":"","chapters":[],"need":[]}`;

const STEP2 = `${RULES}
출력은 JSON 객체 하나: {"answer":"","chapters":[]}`;

const parse = (text) => {
  try {
    return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch {
    return {};
  }
};
const nums = (arr, max) =>
  [...new Set((Array.isArray(arr) ? arr : []).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= max))];

export async function answer(ctx, question) {
  const chapters = ctx.chapters();
  const total = chapters.length;
  const usage = { input: 0, output: 0 };
  const add = (res) => {
    usage.input += res.usage.input;
    usage.output += res.usage.output;
    return res;
  };
  const material = `회차 요약:\n${summariesText(ctx)}\n\n위키 설정:\n${await loreText(ctx)}`;

  const r1 = add(await ai.ask({ system: STEP1, user: `${material}\n\n질문: ${question}`, json: true, effort: 'low' }));
  let data = parse(r1.text);
  let read = [];
  const need = nums(data.need, total).slice(0, 3);
  if (!String(data.answer ?? '').trim() && need.length) {
    read = need;
    const originals = need
      .map((no) => {
        const ch = chapters[no - 1];
        return `── ${no}화${ch.title ? ' ' + ch.title : ''} 원문 ──\n${ch.body}`;
      })
      .join('\n\n');
    const r2 = add(await ai.ask({ system: STEP2, user: `${material}\n\n${originals}\n\n질문: ${question}`, json: true, effort: 'low' }));
    data = parse(r2.text);
  }
  return {
    answer: String(data.answer ?? '').trim() || '자료에서 답을 못 찾았어. 회차 완료 검토로 요약을 쌓아두면 더 잘 찾아.',
    chapters: nums(data.chapters, total),
    read,
    cost: ai.fmtWon(ai.estimateWon(r1.provider, r1.model, usage)),
  };
}

// ───────── 화면 ─────────

const $ = (sel) => document.querySelector(sel);

export function initPane(ctx) {
  const log = $('#askLog');
  const q = $('#askQ');
  const go = $('#askGo');

  const bubble = (cls, text) => {
    const li = document.createElement('li');
    li.className = cls;
    li.textContent = text;
    log.append(li);
    li.scrollIntoView({ block: 'nearest' });
    return li;
  };

  async function run() {
    const question = q.value.trim();
    if (!question || go.disabled) return;
    if (!ai.hasKey(ai.currentProvider())) {
      bubble('a err', 'AI 키가 없어. 설정(⚙) → AI에서 키를 넣어줘.');
      return;
    }
    q.value = '';
    bubble('q', question);
    const wait = bubble('a', '찾아보는 중…');
    go.disabled = true;
    try {
      const res = await answer(ctx, question);
      wait.textContent = res.answer;
      if (res.chapters.length) {
        const links = document.createElement('div');
        links.className = 'links';
        for (const no of res.chapters) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'mini-btn';
          b.textContent = `${no}화 열기`;
          b.addEventListener('click', () => ctx.openChapterNo(no));
          links.append(b);
        }
        wait.append(links);
      }
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = [res.read.length ? `원문 ${res.read.join('·')}화 읽음` : '요약·위키로 답함', res.cost].filter(Boolean).join(' · ');
      wait.append(meta);
    } catch (err) {
      wait.className = 'a err';
      wait.textContent = err.message;
    } finally {
      go.disabled = false;
    }
  }

  go.addEventListener('click', run);
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      run();
    }
  });
  return { render: () => {} };
}
