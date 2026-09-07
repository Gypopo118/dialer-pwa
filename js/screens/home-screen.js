import { icons } from '../utils/icons.js';
import { uiStore } from '../store.js';
import { buildRecentsList, filterRecents } from '../recents-model.js';
import { contactsAdapter } from '../adapters/contacts-adapter.js';
import { callLogAdapter } from '../adapters/call-log-adapter.js';
import { telephonyAdapter } from '../adapters/telephony-adapter.js';
import { formatPhoneForDisplay, formatDuration, formatRelativeTime, initialsFromName } from '../utils/format.js';
import { attachListScrollGesture } from '../utils/list-scroll-gesture.js';
import { pushLayer, popLayerSilently } from '../utils/back-stack.js';

const KEYPAD_LAYOUT = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['*', '0', '#'],
];
const SIDE_COL = ['search', 'add-contact', 'plus', 'clear'];
const KEYBOARD_LAYER = 'keyboard';

export function initHomeScreen({ contextMenu }) {
  const recentsEl = document.getElementById('recents');
  const searchBar = document.getElementById('search-bar');
  const searchInput = document.getElementById('search-input');
  const dialInput = document.getElementById('dial-input');
  const backspaceBtn = document.getElementById('backspace-btn');
  const keypadEl = document.getElementById('keypad');
  const callBtn = document.getElementById('call-btn');
  const dialBlock = document.getElementById('dial-block');
  const keyboardPeek = document.getElementById('keyboard-peek');

  let allRows = [];
  let keyboardWasPushed = false;

  backspaceBtn.innerHTML = icons.backspace;
  callBtn.innerHTML = icons.phone;
  document.getElementById('search-icon').innerHTML = icons.search;
  document.getElementById('search-close').innerHTML = '&times;';

  buildKeypad();
  attachListScrollGesture(recentsEl, { onAutoHide: hideKeyboard });

  // Клавиатура по умолчанию открыта — регистрируем это как слой стека
  // "назад", чтобы самый первый свайп-назад скрывал именно её, а не сразу
  // сворачивал приложение (см. utils/back-stack.js).
  if (uiStore.get().keyboardVisible) {
    pushLayer(KEYBOARD_LAYER, () => hideKeyboard());
    keyboardWasPushed = true;
  }

  callLogAdapter.onChange(refreshRecents);
  uiStore.subscribe((state) => {
    dialInput.textContent = state.dialInput || '';
    dialInput.classList.toggle('dial-input--empty', !state.dialInput);
    backspaceBtn.hidden = !state.dialInput;
    callBtn.toggleAttribute('disabled', !state.dialInput);
  });

  refreshRecents();

  // ===== Строка поиска =====
  document.getElementById('search-toggle').addEventListener('click', () => {
    uiStore.set({ searchOpen: true });
    searchBar.hidden = false;
    searchInput.focus();
  });
  searchInput.addEventListener('input', () => {
    uiStore.set({ searchQuery: searchInput.value });
    renderRecents();
  });
  document.getElementById('search-close').addEventListener('click', closeSearch);
  function closeSearch() {
    uiStore.set({ searchOpen: false, searchQuery: '' });
    searchInput.value = '';
    searchBar.hidden = true;
    renderRecents();
  }

  // ===== Поле ввода =====
  backspaceBtn.addEventListener('click', () => {
    const cur = uiStore.get().dialInput;
    uiStore.set({ dialInput: cur.slice(0, -1) });
  });
  let bsTimer = null;
  backspaceBtn.addEventListener('touchstart', () => {
    bsTimer = setTimeout(() => uiStore.set({ dialInput: '' }), 550);
  }, { passive: true });
  backspaceBtn.addEventListener('touchend', () => clearTimeout(bsTimer));

  callBtn.addEventListener('click', async () => {
    const number = uiStore.get().dialInput;
    if (!number) return;
    const contact = await contactsAdapter.findByNumber(number);
    telephonyAdapter.call(number, contact);
  });

  // ===== Клавиатура набора =====
  function buildKeypad() {
    keypadEl.innerHTML = '';
    KEYPAD_LAYOUT.forEach((row, rowIdx) => {
      const sideKey = document.createElement('button');
      sideKey.className = 'key key--side';
      sideKey.dataset.side = SIDE_COL[rowIdx];
      sideKey.innerHTML = sideIconFor(SIDE_COL[rowIdx]);
      keypadEl.appendChild(sideKey);

      row.forEach((digit) => {
        const key = document.createElement('button');
        key.className = 'key';
        key.dataset.digit = digit;
        key.innerHTML = digit === '0'
          ? `<span class="digit">0</span><span class="sub">+</span>`
          : `<span class="digit">${digit}</span>`;
        keypadEl.appendChild(key);
      });
    });

    keypadEl.querySelectorAll('.key[data-digit]').forEach((key) => {
      key.addEventListener('click', () => appendDigit(key.dataset.digit));
    });
    let longPressTimer = null;
    const zeroKey = keypadEl.querySelector('.key[data-digit="0"]');
    zeroKey.addEventListener('touchstart', () => {
      longPressTimer = setTimeout(() => {
        const cur = uiStore.get().dialInput;
        uiStore.set({ dialInput: cur.slice(0, -1) + '+' });
      }, 500);
    }, { passive: true });
    zeroKey.addEventListener('touchend', () => clearTimeout(longPressTimer));

    keypadEl.querySelector('[data-side="search"]').addEventListener('click', () => {
      document.getElementById('search-toggle').click();
    });
    keypadEl.querySelector('[data-side="add-contact"]').addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('dialer:add-contact-blank'));
    });
    keypadEl.querySelector('[data-side="plus"]').addEventListener('click', () => appendDigit('+'));
    keypadEl.querySelector('[data-side="clear"]').addEventListener('click', () => uiStore.set({ dialInput: '' }));
  }

  function sideIconFor(name) {
    if (name === 'search') return icons.search;
    if (name === 'add-contact') return icons.addContact;
    if (name === 'plus') return icons.plus;
    if (name === 'clear') return `<span class="digit" style="font-size:17px">C</span>`;
    return '';
  }

  function appendDigit(d) {
    const cur = uiStore.get().dialInput;
    uiStore.set({ dialInput: cur + d });
    showKeyboard();
  }

  // ===== Показ/скрытие клавиатуры (свайп по списку недавних) =====
  function hideKeyboard() {
    if (!uiStore.get().keyboardVisible) return;
    uiStore.set({ keyboardVisible: false });
    dialBlock.classList.add('dial-block--hidden');
    keyboardPeek.hidden = false;
    if (keyboardWasPushed) { popLayerSilently(KEYBOARD_LAYER); keyboardWasPushed = false; }
  }
  function showKeyboard() {
    if (uiStore.get().keyboardVisible) return;
    uiStore.set({ keyboardVisible: true });
    dialBlock.classList.remove('dial-block--hidden');
    keyboardPeek.hidden = true;
    pushLayer(KEYBOARD_LAYER, () => hideKeyboard());
    keyboardWasPushed = true;
  }
  keyboardPeek.addEventListener('click', showKeyboard);

  // ===== Список недавних =====
  async function refreshRecents() {
    allRows = await buildRecentsList();
    renderRecents();
  }

  function renderRecents() {
    const { searchQuery } = uiStore.get();
    const rows = filterRecents(allRows, searchQuery);
    if (!rows.length) {
      recentsEl.innerHTML = `<div class="recents-empty">${searchQuery ? 'Ничего не найдено' : 'Пока нет истории звонков'}</div>`;
      return;
    }
    recentsEl.innerHTML = rows.map(rowTemplate).join('');
    recentsEl.querySelectorAll('.recent-row').forEach((el) => {
      const row = rows.find((r) => r.key === el.dataset.key);
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-call]')) return;
        contextMenu.open(row);
      });
      el.querySelector('[data-call]').addEventListener('click', () => {
        telephonyAdapter.call(row.number, row.contact);
      });
    });
  }

  function rowTemplate(row) {
    const isKnown = !!row.contact;
    const arrow = row.lastType === 'outgoing' ? icons.arrowOut : row.lastType === 'incoming' ? icons.arrowIn : icons.arrowMissed;
    const colorClass = `call-arrow--${row.lastType === 'missed' ? 'missed' : row.lastType === 'incoming' ? 'in' : 'out'}`;
    const primaryText = isKnown ? row.contact.name : formatPhoneForDisplay(row.number);
    const secondaryText = isKnown ? formatPhoneForDisplay(row.number) : null;
    const avatarContent = isKnown ? initialsFromName(row.contact.name) : icons.phone;

    return `
      <div class="recent-row" data-key="${row.key}">
        <div class="avatar">${avatarContent}</div>
        <div class="recent-main">
          <div class="recent-line1">
            <span class="recent-name ${isKnown ? '' : 'recent-name--unknown'}">${primaryText}</span>
            ${row.count > 1 ? `<span class="recent-count">${row.count}</span>` : ''}
          </div>
          <div class="recent-sub">
            <span class="call-arrow ${colorClass}">${arrow}</span>
            ${secondaryText ? `<span>${secondaryText}</span><span class="dot">·</span>` : ''}
            ${icons.clock}
            <span>${row.lastDurationSec > 0 ? formatDuration(row.lastDurationSec) : '—'}</span>
          </div>
        </div>
        <div class="recent-meta">
          <span class="recent-time">${formatRelativeTime(row.lastTimestamp)}</span>
          <button class="recent-call-btn" data-call>${icons.phone}</button>
        </div>
      </div>
    `;
  }

  return { refreshRecents };
}
