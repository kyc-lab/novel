// 앱 안에서 띄우는 "물어보기" 창. (브라우저 기본 창은 설치한 앱에서 안 뜨는 경우가 있어서 직접 만든다)

const dlg = document.querySelector('#askDlg');
const form = dlg.querySelector('form');
const msgEl = dlg.querySelector('#askMsg');
const inputEl = dlg.querySelector('#askInput');
const okBtn = dlg.querySelector('#askOk');
const cancelBtn = dlg.querySelector('#askCancel');

let current = null; // 지금 떠 있는 질문 { resolve, input }

// 답이 정해지면 창을 닫고 결과를 돌려준다.
// (창이 "닫혔다"는 신호를 기다리지 않고 버튼에서 바로 처리한다 — 화면이 가려져 있으면 그 신호가 늦게 올 수 있어서)
function finish(ok) {
  if (!current) return;
  const { resolve, input } = current;
  current = null;
  if (dlg.open) dlg.close();
  if (input) resolve(ok ? inputEl.value.trim() : null);
  else resolve(ok);
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  finish(true);
});
cancelBtn.addEventListener('click', () => finish(false));
dlg.addEventListener('click', (e) => {
  if (e.target === dlg) finish(false); // 창 바깥(어두운 부분)
});
dlg.addEventListener('cancel', () => finish(false)); // Esc · 뒤로 가기
dlg.addEventListener('close', () => finish(false)); // 그 밖의 경로로 닫힌 경우

function ask({ message, input = false, value = '', okLabel = '확인', cancelLabel = '취소', danger = false }) {
  finish(false); // 혹시 이전 질문이 떠 있으면 취소로 정리
  return new Promise((resolve) => {
    current = { resolve, input };
    msgEl.textContent = message;
    cancelBtn.textContent = cancelLabel;
    inputEl.hidden = !input;
    inputEl.value = value;
    okBtn.textContent = okLabel;
    okBtn.classList.toggle('danger-btn', danger);
    dlg.showModal();
    if (input) {
      inputEl.focus();
      inputEl.select();
    } else {
      cancelBtn.focus(); // 지우기 같은 건 실수로 엔터 쳐도 취소되게
    }
  });
}

// 글자를 입력받는다. 취소하면 null, 확인하면 입력한 글자.
export const askText = (message, value = '') => ask({ message, input: true, value });

// 예/아니오를 묻는다. 확인하면 true.
export const askConfirm = (message, okLabel = '확인', danger = false) =>
  ask({ message, okLabel, danger });

// 둘 중 하나를 고르게 한다. 오른쪽 버튼(okLabel)을 누르면 true, 왼쪽 버튼이나 그냥 닫으면 false.
export const askChoice = (message, cancelLabel, okLabel) => ask({ message, okLabel, cancelLabel });
