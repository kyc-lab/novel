// 맞춤법·문장 교정. AI에게 원고를 보내 틀린 곳 목록을 받고, 작가가 하나씩 "고치기 / 무시"한다.
// AI 회사가 바뀌어도 이 파일은 ai.ask() 만 부른다.

import * as ai from './ai.js';
import { replaceText } from './symbols.js';

const CHUNK = 3000; // 한 번에 AI에게 보내는 글자 수(문단 단위로 자른다)

const TYPE_LABEL = { spelling: '맞춤법', spacing: '띄어쓰기', suggest: '문장 제안' };

const SYSTEM = `너는 한국어 웹소설 교정자다. 작가의 원고에서 다음을 찾는다.
1. spelling: 맞춤법 오류(틀린 철자, 잘못된 활용, 되/돼 같은 혼동)
2. spacing: 띄어쓰기 오류
3. suggest: 문장 제안(가까운 곳에서 같은 표현 반복, 어색하거나 주어·서술어가 안 맞는 문장)

지킬 것:
- 작가의 문체와 말투는 고치지 않는다. 대사의 구어체·줄임말·사투리·의도적인 비문은 그대로 둔다.
- ⋯ “ ” ‘ ’ 「 」 『 』 ― ♡ ★ 같은 특수기호와 문장부호 습관은 고치지 않는다.
- 확실한 오류만 spelling/spacing으로 낸다. 애매하면 suggest로 내거나 빼라.
- suggest는 정말 거슬리는 것만, 많아야 8개.
- original: 원고에 있는 글자를 한 글자도 바꾸지 말고 그대로 복사한다. 원고에서 한 곳으로 찾을 수 있게 틀린 부분 앞뒤 단어까지 넣어 5~40자로 잡는다. 줄바꿈은 넣지 않는다.
- fixed: original과 같은 범위를 고친 결과.
- reason: 왜 고치는지 짧은 한국어(25자 안팎).
- 원고에 나오는 순서대로 나열한다.

출력은 JSON 객체 하나만: {"items":[{"type":"spelling","original":"...","fixed":"...","reason":"..."}]}
고칠 게 없으면 {"items":[]}`;

// 문단 경계에서 CHUNK 글자 안팎으로 자른다.
function chunks(text) {
  const parts = [];
  let buf = '';
  for (const para of text.split(/(?<=\n)/)) {
    if (buf && buf.length + para.length > CHUNK) {
      parts.push(buf);
      buf = '';
    }
    buf += para;
  }
  if (buf.trim()) parts.push(buf);
  return parts;
}

function parseItems(text) {
  try {
    const data = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    return Array.isArray(data.items) ? data.items : [];
  } catch {
    return [];
  }
}

// 원고를 검사해서 { items, usage, won, provider, model } 을 돌려준다.
// items: [{ id, type, original, fixed, reason, pos }] — pos는 원고에서의 위치
export async function check(body, onProgress = () => {}) {
  const parts = chunks(body);
  const items = [];
  const usage = { input: 0, output: 0 };
  let provider;
  let model;
  let offset = 0;
  for (let i = 0; i < parts.length; i++) {
    onProgress(i + 1, parts.length);
    const part = parts[i];
    const res = await ai.ask({ system: SYSTEM, user: `원고:\n${part}`, json: true, effort: 'low' });
    provider = res.provider;
    model = res.model;
    usage.input += res.usage.input;
    usage.output += res.usage.output;
    let from = 0; // 같은 글자가 여러 번 나오면, 앞의 항목 다음부터 찾는다
    for (const it of parseItems(res.text)) {
      const original = String(it.original ?? '');
      const fixed = String(it.fixed ?? '');
      if (!original || original === fixed || original.includes('\n')) continue;
      let at = part.indexOf(original, from);
      if (at < 0) at = part.indexOf(original);
      if (at < 0) continue; // AI가 원고에 없는 글자를 냈으면 버린다
      from = at + original.length;
      items.push({
        id: crypto.randomUUID(),
        type: TYPE_LABEL[it.type] ? it.type : 'suggest',
        original,
        fixed,
        reason: String(it.reason ?? ''),
        pos: offset + at,
      });
    }
    offset += part.length;
  }
  items.sort((a, b) => a.pos - b.pos);
  return { items, usage, provider, model, won: ai.estimateWon(provider, model, usage) };
}

// ───────── 패널 화면 ─────────

const $ = (sel) => document.querySelector(sel);

export function initPanel({ editor, getChapter, beforeFix, isLocked }) {
  const el = {
    run: $('#proofRun'),
    info: $('#proofInfo'),
    sum: $('#proofSummary'),
    fixAll: $('#proofFixAll'),
    list: $('#proofList'),
  };
  let result = null; // { chapterId, items, ... }
  let savedHistory = false;

  function showInfo() {
    const ch = getChapter();
    const provider = ai.currentProvider();
    const name = ai.PROVIDERS[provider]?.name ?? provider;
    if (!ai.hasKey(provider)) {
      el.info.textContent = `${name} 키가 없어. 설정(⚙) → AI에서 키를 넣어줘.`;
      el.run.disabled = true;
      return;
    }
    el.run.disabled = false;
    el.info.textContent = `${ch ? [...editor.value].length.toLocaleString('ko-KR') + '자' : ''} · ${name}(${ai.currentModel(provider)})가 검사해.`;
  }

  function render() {
    const ch = getChapter();
    showInfo();
    if (!result) {
      el.sum.textContent = '';
      el.fixAll.hidden = true;
      el.list.replaceChildren();
      return;
    }
    if (!ch || result.chapterId !== ch.id) {
      el.sum.textContent = '다른 회차의 검사 결과야. 이 회차를 보려면 다시 검사해줘.';
      el.fixAll.hidden = true;
      el.list.replaceChildren();
      return;
    }
    const count = (t) => result.items.filter((it) => it.type === t).length;
    const parts = Object.entries(TYPE_LABEL).map(([t, label]) => `${label} ${count(t)}`);
    const cost = result.costText ? ' · ' + result.costText : '';
    el.sum.textContent = result.items.length
      ? `${parts.join(' · ')}${cost}`
      : result.found
        ? `다 처리했어. (찾은 곳 ${result.found}개)${cost}`
        : `고칠 곳을 못 찾았어.${cost}`;
    el.fixAll.hidden = !result.items.some((it) => it.type !== 'suggest');

    el.list.replaceChildren(
      ...result.items.map((it) => {
        const li = document.createElement('li');
        li.className = 'proof-item ' + it.type;
        li.dataset.id = it.id;
        const head = document.createElement('div');
        head.className = 'proof-head';
        const tag = document.createElement('span');
        tag.className = 'proof-tag';
        tag.textContent = TYPE_LABEL[it.type];
        const why = document.createElement('span');
        why.textContent = it.reason;
        head.append(tag, why);
        const diff = document.createElement('button');
        diff.type = 'button';
        diff.className = 'proof-diff';
        diff.dataset.act = 'go';
        diff.title = '원고에서 이 자리로 가기';
        const del = document.createElement('del');
        del.textContent = it.original;
        const ins = document.createElement('ins');
        ins.textContent = it.fixed;
        diff.append(del, ' → ', ins);
        const btns = document.createElement('div');
        btns.className = 'proof-btns';
        const fix = document.createElement('button');
        fix.type = 'button';
        fix.className = 'mini-btn primary';
        fix.dataset.act = 'fix';
        fix.textContent = '고치기';
        const skip = document.createElement('button');
        skip.type = 'button';
        skip.className = 'mini-btn';
        skip.dataset.act = 'skip';
        skip.textContent = '무시';
        btns.append(fix, skip);
        li.append(head, diff, btns);
        return li;
      }),
    );
  }

  // 지금 원고에서 그 항목의 위치를 다시 찾는다(검사 뒤에 글을 고쳤을 수 있으니까).
  function locate(it) {
    const text = editor.value;
    if (text.slice(it.pos, it.pos + it.original.length) === it.original) return it.pos;
    let best = -1;
    let at = text.indexOf(it.original);
    while (at >= 0) {
      if (best < 0 || Math.abs(at - it.pos) < Math.abs(best - it.pos)) best = at;
      at = text.indexOf(it.original, at + 1);
    }
    return best;
  }

  function remove(it) {
    result.items = result.items.filter((x) => x !== it);
  }

  async function fixItem(it) {
    if (isLocked()) return false;
    const at = locate(it);
    if (at < 0) {
      remove(it); // 원고가 바뀌어서 더는 없는 곳
      return false;
    }
    if (!savedHistory) {
      savedHistory = true;
      await beforeFix(); // 고치기 전 모습을 되돌리기 기록에 남긴다
    }
    replaceText(at, at + it.original.length, it.fixed);
    const delta = it.fixed.length - it.original.length;
    for (const other of result.items) if (other.pos > at) other.pos += delta;
    remove(it);
    return true;
  }

  function goTo(it) {
    const at = locate(it);
    if (at < 0) return;
    editor.focus();
    editor.setSelectionRange(at, at + it.original.length);
    // 선택한 곳이 화면 가운데쯤 오게 스크롤
    const before = editor.value.slice(0, at);
    const lines = before.split('\n').length;
    const lineH = parseFloat(getComputedStyle(editor).lineHeight) || 30;
    editor.scrollTop = Math.max(0, lines * lineH - editor.clientHeight / 2);
  }

  el.list.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn || !result) return;
    const it = result.items.find((x) => x.id === btn.closest('.proof-item').dataset.id);
    if (!it) return;
    if (btn.dataset.act === 'go') goTo(it);
    else if (btn.dataset.act === 'skip') remove(it);
    else if (btn.dataset.act === 'fix') await fixItem(it);
    render();
  });

  el.fixAll.addEventListener('click', async () => {
    if (!result || isLocked()) return;
    // 뒤에서부터 고치면 앞쪽 위치가 안 흔들린다.
    const targets = result.items.filter((it) => it.type !== 'suggest').sort((a, b) => b.pos - a.pos);
    for (const it of targets) await fixItem(it);
    render();
  });

  el.run.addEventListener('click', async () => {
    const ch = getChapter();
    if (!ch || !editor.value.trim()) {
      el.sum.textContent = '본문이 비어 있어.';
      return;
    }
    el.run.disabled = true;
    el.list.replaceChildren();
    el.fixAll.hidden = true;
    try {
      const res = await check(editor.value, (i, n) => {
        el.sum.textContent = n > 1 ? `검사하는 중… (${i}/${n})` : '검사하는 중…';
      });
      result = { ...res, chapterId: ch.id, costText: ai.fmtWon(res.won), found: res.items.length };
      savedHistory = false;
    } catch (err) {
      result = null;
      el.sum.textContent = err.message;
      el.run.disabled = false;
      return;
    }
    el.run.disabled = false;
    render();
  });

  return { render };
}
