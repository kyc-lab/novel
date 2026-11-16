// AI 기능들이 같이 쓰는 "설정 자료" 만들기: 회차 요약 목록, 위키(인물 상태 포함)를 글로 정리한다.
// ctx 는 app.js 가 넘겨주는 도우미 모음(지금 작품·회차·위키 문서 등).

import { compute, describe, oneLine } from './status.js';

const cut = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
const plain = (s) => s.replace(/\[\[([^\[\]|]+)(?:\|([^\[\]]+))?\]\]/g, (_, a, b) => (b ?? a)).replace(/^#+\s*/gm, '');

// "N화 제목: 요약" 줄들. upto 화까지. 요약이 없는 회차는 앞부분 조금.
export function summariesText(ctx, { upto = Infinity, headChars = 150 } = {}) {
  return ctx
    .chapters()
    .map((ch, i) => [ch, i + 1])
    .filter(([, no]) => no <= upto)
    .map(([ch, no]) => {
      const head = `${no}화${ch.title ? ' ' + ch.title : ''}`;
      if (ch.summary) return `${head}: ${ch.summary}`;
      const body = ch.body.replace(/\s+/g, ' ').trim();
      return body ? `${head}: (요약 없음 · 앞부분) ${cut(body, headChars)}` : `${head}: (비어 있음)`;
    })
    .join('\n');
}

// 위키 정리: 인물은 (upto화 기준) 상태 한 줄, 나머지 문서는 앞부분.
export async function loreText(ctx, { upto = Infinity, bodyChars = 300, max = 12000 } = {}) {
  const docs = (await ctx.wikiDocs()).filter((d) => d.title.trim());
  const persons = docs.filter((d) => d.category === '인물');
  const others = docs.filter((d) => d.category !== '인물');
  const lines = [];
  for (const p of persons) {
    const rows = describe(compute(p.status ?? [], upto));
    const st = rows.length ? rows.map(([k, v]) => `${k}: ${v}`).join(' / ') : '';
    const body = cut(plain(p.body).replace(/\s+/g, ' ').trim(), bodyChars);
    lines.push(`[인물] ${p.title}${st ? ' — ' + st : ''}${body ? ' · ' + body : ''}`);
  }
  for (const d of others) {
    const body = cut(plain(d.body).replace(/\s+/g, ' ').trim(), bodyChars);
    lines.push(`[${d.category}] ${d.title}${body ? ': ' + body : ''}`);
  }
  return cut(lines.join('\n') || '없음', max);
}

export { oneLine };
