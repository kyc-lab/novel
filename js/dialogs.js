// 앱 안에서 띄우는 "물어보기" 창. (브라우저 기본 창은 설치한 앱에서 안 뜨는 경우가 있어서 직접 만든다)

const dlg = document.querySelector('#askDlg');
const msgEl = dlg.querySelector('#askMsg');
const inputEl = dlg.querySelector('#askInput');
const okBtn = dlg.querySelector('#askOk');
const cancelBtn = dlg.querySelector('#askCancel');

cancelBtn.addEventListener('click', () => dlg.close('cancel'));
dlg.addEventListener('click', (e) => {
  if (e.target === dlg) dlg.close('cancel');
});

function ask({ message, input = false, value = '', okLabel = '확인', danger = false }) {
  return new Promise((resolve) => {
    msgEl.textContent = message;
    inputEl.hidden = !input;
    inputEl.value = value;
    okBtn.textContent = okLabel;
    okBtn.classList.toggle('danger-btn', danger);
    dlg.returnValue = '';
    dlg.showModal();
    if (input) {
      inputEl.focus();
      inputEl.select();
    } else {
      cancelBtn.focus(); // 지우기 같은 건 실수로 엔터 쳐도 취소되게
    }
    dlg.addEventListener(
      'close',
      () => {
        const ok = dlg.returnValue === 'ok';
        if (input) resolve(ok ? inputEl.value.trim() : null);
        else resolve(ok);
      },
      { once: true },
    );
  });
}

// 글자를 입력받는다. 취소하면 null, 확인하면 입력한 글자.
export const askText = (message, value = '') => ask({ message, input: true, value });

// 예/아니오를 묻는다. 확인하면 true.
export const askConfirm = (message, okLabel = '확인', danger = false) =>
  ask({ message, okLabel, danger });
