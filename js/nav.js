// 폰·태블릿 세로 화면의 아래 바(5칸). 앞의 4칸은 설정에서 순서를 바꿀 수 있고, 나머지는 "더보기" 안으로.
// "더보기"와 그 안의 "설정"은 고정이다.

import * as settings from './settings.js';

export const ITEMS = {
  chapters: { label: '회차', icon: '☰' },
  ask: { label: '질문', icon: '?' },
  proof: { label: '맞춤법', icon: '가' },
  check: { label: '점검', icon: '✓' },
  draft: { label: '초안', icon: '✎' },
  lore: { label: '설정집', icon: '◈' },
  hooks: { label: '떡밥', icon: '◎' },
  wiki: { label: '위키', icon: '▤' },
};
export const DEFAULT_ORDER = ['chapters', 'ask', 'proof', 'check', 'draft', 'lore', 'hooks', 'wiki'];
const BAR = 4;

export function order() {
  const saved = settings.get().navOrder;
  const list = Array.isArray(saved) ? saved.filter((id) => ITEMS[id]) : [];
  return [...list, ...DEFAULT_ORDER.filter((id) => !list.includes(id))];
}

const $ = (sel) => document.querySelector(sel);

function button(id, run) {
  const it = ITEMS[id];
  const b = document.createElement('button');
  b.type = 'button';
  b.dataset.id = id;
  b.innerHTML = `<span class="ico"></span><span class="lbl"></span>`;
  b.querySelector('.ico').textContent = it.icon;
  b.querySelector('.lbl').textContent = it.label;
  b.addEventListener('click', () => run(id));
  return b;
}

// actions: { run(id), openSettings(), isActive(id) }
export function init(actions) {
  const bar = $('#mobileNav');
  const more = $('#navMore');
  const moreList = $('#navMoreList');

  const closeMore = () => (more.hidden = true);
  const run = (id) => {
    closeMore();
    actions.run(id);
    render();
  };

  function render() {
    const ids = order();
    const moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.innerHTML = '<span class="ico">⋯</span><span class="lbl">더보기</span>';
    moreBtn.addEventListener('click', () => {
      more.hidden = !more.hidden;
    });
    bar.replaceChildren(...ids.slice(0, BAR).map((id) => button(id, run)), moreBtn);
    for (const b of bar.querySelectorAll('[data-id]')) b.classList.toggle('on', actions.isActive(b.dataset.id));

    const settingsBtn = document.createElement('button');
    settingsBtn.type = 'button';
    settingsBtn.innerHTML = '<span class="ico">⚙</span><span class="lbl">설정</span>';
    settingsBtn.addEventListener('click', () => {
      closeMore();
      actions.openSettings();
    });
    moreList.replaceChildren(...ids.slice(BAR).map((id) => button(id, run)), settingsBtn);
  }

  more.addEventListener('click', (e) => {
    if (e.target === more) closeMore();
  });

  // ── 설정 창: 아래 바 순서 편집 ──
  const box = $('#navOrder');
  function renderOrder() {
    const ids = order();
    box.replaceChildren(
      ...ids.map((id, i) => {
        const li = document.createElement('li');
        li.className = i < BAR ? 'in-bar' : '';
        const name = document.createElement('span');
        name.textContent = `${ITEMS[id].label}${i < BAR ? '' : ' · 더보기'}`;
        const up = document.createElement('button');
        up.type = 'button';
        up.className = 'mini-btn';
        up.textContent = '↑';
        up.disabled = i === 0;
        up.addEventListener('click', () => move(i, -1));
        const down = document.createElement('button');
        down.type = 'button';
        down.className = 'mini-btn';
        down.textContent = '↓';
        down.disabled = i === ids.length - 1;
        down.addEventListener('click', () => move(i, 1));
        li.append(name, up, down);
        return li;
      }),
    );
  }
  function move(i, dir) {
    const ids = order();
    [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
    settings.update({ navOrder: ids });
    renderOrder();
    render();
  }
  $('#navOrderReset').addEventListener('click', () => {
    settings.update({ navOrder: [] });
    renderOrder();
    render();
  });

  render();
  renderOrder();
  return { render, renderOrder };
}
