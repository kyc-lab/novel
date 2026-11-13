// 글자수 세기. 기호·이모지도 1자로 센다(… 와 ⋯ 는 1자, ... 는 3자).

export function countChars(text, { spaces = true, newlines = false } = {}) {
  let t = text;
  if (!newlines) t = t.replace(/[\r\n]/g, '');
  if (!spaces) t = t.replace(/[^\S\r\n]/g, '');
  return [...t].length;
}

export const fmt = (n) => n.toLocaleString('ko-KR');
