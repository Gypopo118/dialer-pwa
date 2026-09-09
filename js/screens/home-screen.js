import { icons } from '../utils/icons.js';
import { uiStore } from '../store.js';
import { blockedStore } from '../blocked-store.js';
import { contactRowTemplate } from './contact-list-screen.js';
import { buildRecentsList, filterRecents } from '../recents-model.js';
import { contactsAdapter } from '../adapters/contacts-adapter.js';
import { callLogAdapter } from '../adapters/call-log-adapter.js';
import { telephonyAdapter } from '../adapters/telephony-adapter.js';
import { formatPhoneForDisplay, formatDuration, formatRelativeTime, normalizeNumber } from '../utils/format.js';
import { avatarHtml, warmPhotoCache, swapCachedPhotos } from '../utils/photo-cache.js';
import { attachListScrollGesture } from '../utils/list-scroll-gesture.js';
import { pushLayer, popLayerSilently, registerOverlay } from '../utils/back-stack.js';

const KEYPAD_LAYOUT = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['*', '0', '#'],
];
const SIDE_COL = ['search', 'add-contact', 'plus', 'contacts'];
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
  // После завершения любого звонка (успешного, missed, отклонённого) поле
  // ввода очищается — номер уже есть в истории, держать его в поле не нужно.
  let lastCallStatus = telephonyAdapter.getState().status;
  telephonyAdapter.onStateChange((s) => {
    if (lastCallStatus !== 'idle' && s.status === 'idle') {
      uiStore.set({ dialInput: '' });
    }
    lastCallStatus = s.status;
  });
  let lastDialFilter = null;
  uiStore.subscribe((state) => {
    syncDialInput(state.dialInput || '');
    dialInput.classList.toggle('dial-input--empty', !state.dialInput);
    backspaceBtn.hidden = !state.dialInput;
    callBtn.toggleAttribute('disabled', !state.dialInput);
    // Набранные цифры вживую фильтруют историю (smart dial).
    if (state.dialInput !== lastDialFilter) {
      lastDialFilter = state.dialInput;
      scheduleRender();
    }
  });
  dialInput.value = uiStore.get().dialInput || '';

  // ===== Поле ввода — настоящий <input> с курсором =====
  // Тап ставит курсор между цифрами, свайп влево/вправо двигает его.
  // inputmode="none" подавляет системную клавиатуру — набор идёт своей.
  // lastCaret помнит позицию: тап по кнопкам уводит фокус с поля,
  // а вставка/удаление должны идти там, где стоял курсор, а не в конце.
  let lastCaret = null;
  function rememberCaret() {
    try {
      lastCaret = {
        start: dialInput.selectionStart ?? dialInput.value.length,
        end: dialInput.selectionEnd ?? dialInput.value.length,
      };
    } catch (_) { /* noop */ }
  }
  function effectiveCaret() {
    if (document.activeElement === dialInput) rememberCaret();
    const len = (uiStore.get().dialInput || '').length;
    if (!lastCaret) return { start: len, end: len };
    return {
      start: Math.max(0, Math.min(lastCaret.start, len)),
      end: Math.max(0, Math.min(lastCaret.end, len)),
    };
  }
  function syncDialInput(value) {
    if (dialInput.value === value) return;
    dialInput.value = value;
  }
  function placeCaret(pos) {
    const p = Math.max(0, Math.min(pos, dialInput.value.length));
    lastCaret = { start: p, end: p };
    dialInput.focus({ preventScroll: true });
    try { dialInput.setSelectionRange(p, p); } catch (_) { /* noop */ }
  }
  dialInput.addEventListener('input', () => {
    rememberCaret();
    if (dialInput.value !== uiStore.get().dialInput) uiStore.set({ dialInput: dialInput.value });
  });
  dialInput.addEventListener('click', rememberCaret);
  dialInput.addEventListener('keyup', rememberCaret);
  dialInput.addEventListener('select', rememberCaret);
  // Свайп по полю ввода двигает курсор (работает и без системной клавиатуры).
  let swipeX = null, swipeY = null, swipeCaret = 0;
  dialInput.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    swipeX = t.clientX; swipeY = t.clientY;
    swipeCaret = effectiveCaret().start;
  }, { passive: true });
  dialInput.addEventListener('touchend', (e) => {
    if (swipeX === null) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - swipeX, dy = t.clientY - swipeY;
    swipeX = null;
    if (Math.abs(dx) > 24 && Math.abs(dy) < 40) {
      const steps = Math.max(-10, Math.min(10, Math.round(dx / 28)));
      placeCaret(swipeCaret + steps);
    }
  }, { passive: true });

  refreshRecents();

  // ===== Строка поиска =====
  // Dial-клавиатура на время поиска уходит под системную (не перекрывает
  // экран) и возвращается при закрытии поиска. У поиска свой слой —
  // «назад» сначала закрывает поиск, а не сворачивает приложение.
  const SEARCH_LAYER = 'search';
  let searchHadKeyboard = false;
  let searchHadPeek = false;
  document.getElementById('search-toggle').addEventListener('click', () => {
    if (uiStore.get().searchOpen) return;
    uiStore.set({ searchOpen: true });
    searchHadKeyboard = uiStore.get().keyboardVisible;
    searchHadPeek = !keyboardPeek.hidden && !searchHadKeyboard;
    hideKeyboard();
    keyboardPeek.hidden = true;
    searchBar.hidden = false;
    pushLayer(SEARCH_LAYER, () => closeSearch(true));
    searchInput.focus();
  });
  searchInput.addEventListener('input', () => {
    uiStore.set({ searchQuery: searchInput.value });
    scheduleRender(150);
  });
  document.getElementById('search-close').addEventListener('click', closeSearch);
  registerOverlay({ isOpen: () => uiStore.get().searchOpen, close: () => closeSearch(true) });
  function closeSearch(viaGesture) {
    if (!uiStore.get().searchOpen) return;
    uiStore.set({ searchOpen: false, searchQuery: '' });
    searchInput.value = '';
    searchBar.hidden = true;
    if (!viaGesture) popLayerSilently(SEARCH_LAYER);
    renderRecents();
    if (searchHadKeyboard) {
      searchHadKeyboard = false;
      showKeyboard();
    } else {
      keyboardPeek.hidden = !searchHadPeek;
    }
  }

  // ===== Поле ввода =====
  // Удаление идёт в позиции курсора (или выделенного фрагмента),
  // а не всегда с конца — можно вырезать лишнюю цифру из середины.
  backspaceBtn.addEventListener('click', () => {
    const cur = uiStore.get().dialInput || '';
    const { start, end } = effectiveCaret();
    if (end !== start) {
      uiStore.set({ dialInput: cur.slice(0, start) + cur.slice(end) });
      placeCaret(start);
    } else if (start > 0) {
      uiStore.set({ dialInput: cur.slice(0, start - 1) + cur.slice(start) });
      placeCaret(start - 1);
    }
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
      key.addEventListener('click', () => {
        // Долгое нажатие «0» уже вставило «+» — повторный клик пропускаем.
        if (key.dataset.digit === '0' && Date.now() - zeroLongFired < 700) return;
        appendDigit(key.dataset.digit);
      });
    });
    let longPressTimer = null;
    let zeroLongFired = 0;
    const zeroKey = keypadEl.querySelector('.key[data-digit="0"]');
    zeroKey.addEventListener('touchstart', () => {
      longPressTimer = setTimeout(() => {
        // Долгое нажатие «0» меняет ноль перед курсором на «+».
        zeroLongFired = Date.now();
        const cur = uiStore.get().dialInput || '';
        const { start, end } = effectiveCaret();
        if (end !== start) {
          uiStore.set({ dialInput: cur.slice(0, start) + '+' + cur.slice(end) });
          placeCaret(start + 1);
        } else if (start > 0 && cur[start - 1] === '0') {
          uiStore.set({ dialInput: cur.slice(0, start - 1) + '+' + cur.slice(start) });
          placeCaret(start);
        }
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
    keypadEl.querySelector('[data-side="contacts"]').addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('dialer:open-contacts'));
    });
  }

  function sideIconFor(name) {
    if (name === 'search') return icons.search;
    if (name === 'add-contact') return icons.addContact;
    if (name === 'plus') return icons.plus;
    if (name === 'contacts') return icons.contacts;
    return '';
  }

  function appendDigit(d) {
    const cur = uiStore.get().dialInput || '';
    const { start, end } = effectiveCaret();
    uiStore.set({ dialInput: cur.slice(0, start) + d + cur.slice(end) });
    placeCaret(start + d.length);
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
  let renderSeq = 0;
  let lastRecentsHtml = '';

  // Ввод не ждёт фильтр: цифра ложится в поле синхронно, а тяжёлый
  // пересчёт списка едет с дебаунсом после паузы в наборе.
  let renderTimer = null;
  function scheduleRender(delay = 180) {
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      renderTimer = null;
      renderRecents();
    }, delay);
  }

  async function refreshRecents() {
    allRows = await buildRecentsList();
    renderRecents();
  }

  // Поиск и набор фильтруют список вживую:
  // - строка поиска — по именам и номерам, включая контакты без истории;
  // - набранные цифры — по истории звонков (+ совпавшие контакты ниже).
  async function renderRecents() {
    const seq = ++renderSeq;
    const { searchQuery, searchOpen, dialInput: dial } = uiStore.get();
    const q = (searchQuery || '').trim();
    const digits = (dial || '').replace(/[^\d+]/g, '');

    let rows = allRows;
    let matchedContacts = [];
    if (searchOpen && q) {
      rows = filterRecents(allRows, q);
      try {
        matchedContacts = await contactsAdapter.search(q);
      } catch (_) {
        matchedContacts = [];
      }
    } else if (digits) {
      rows = allRows.filter((row) => row.number.replace(/[^\d+]/g, '').includes(digits));
      try {
        const found = await contactsAdapter.search(digits);
        const inHistory = new Set(rows.map((r) => r.key));
        matchedContacts = found.filter((c) =>
          (c.numbers || []).some((n) => n.replace(/[^\d+]/g, '').includes(digits))
          && !((c.numbers || []).some((n) => inHistory.has(normalizeNumber(n))))
        );
      } catch (_) {
        matchedContacts = [];
      }
    }
    if (seq !== renderSeq) return;
    const hasFilter = (searchOpen && q) || digits;
    if (!rows.length && !matchedContacts.length) {
      lastRecentsHtml = '';
      recentsEl.innerHTML = `<div class="recents-empty">${hasFilter ? 'Ничего не найдено' : 'Пока нет истории звонков'}</div>`;
      return;
    }
    const html = rows.map(rowTemplate).join('')
      + (matchedContacts.length
        ? `<div class="recents-group-label">Контакты</div>` + matchedContacts.map(contactRowTemplate).join('')
        : '');
    // Тот же HTML повторно не трогаем: слушатели живы, скролл не прыгает.
    if (html === lastRecentsHtml) return;
    lastRecentsHtml = html;
    const keepScroll = recentsEl.scrollTop;
    recentsEl.innerHTML = html;
    recentsEl.scrollTop = keepScroll;
    bindHistoryRows(rows);
    bindContactRows(matchedContacts);
    afterRenderPhotos(rows, matchedContacts);
  }

  function bindHistoryRows(rows) {
    recentsEl.querySelectorAll('.recent-row[data-key]').forEach((el) => {
      const row = rows.find((r) => r.key === el.dataset.key);
      if (!row) return;
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-call]')) return;
        contextMenu.open(row);
      });
      el.querySelector('[data-call]').addEventListener('click', () => {
        telephonyAdapter.call(row.number, row.contact);
      });
    });
  }

  function bindContactRows(list) {
    recentsEl.querySelectorAll('[data-contact]').forEach((el) => {
      const c = list.find((x) => String(x.id) === el.dataset.contact);
      if (!c) return;
      const number = (c.numbers && c.numbers[0]) || '';
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-call]')) return;
        contextMenu.open({ number, contact: c });
      });
      el.querySelector('[data-call]')?.addEventListener('click', () => {
        telephonyAdapter.call(number, c);
      });
    });
  }

  function afterRenderPhotos(rows, matchedContacts) {
    const urls = [];
    rows.forEach((r) => {
      if (r.contact && r.contact.photoUrl) urls.push(r.contact.photoUrl);
    });
    matchedContacts.forEach((c) => {
      if (c.photoUrl) urls.push(c.photoUrl);
    });
    warmPhotoCache(urls);
    swapCachedPhotos(recentsEl);
  }

  function rowTemplate(row) {
    const isKnown = !!row.contact;
    const arrow = row.lastType === 'outgoing' ? icons.arrowOut : row.lastType === 'incoming' ? icons.arrowIn : icons.arrowMissed;
    const colorClass = `call-arrow--${row.lastType === 'missed' ? 'missed' : row.lastType === 'incoming' ? 'in' : 'out'}`;
    const primaryText = isKnown ? row.contact.name : formatPhoneForDisplay(row.number);
    const secondaryText = isKnown ? formatPhoneForDisplay(row.number) : null;
    const avatarContent = avatarHtml({
      name: isKnown ? row.contact.name : null,
      photoUrl: isKnown ? row.contact.photoUrl : null,
      fallbackHtml: icons.person,
    });

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
            ${blockedStore.isBlocked(row.number) ? `<span class="blocked-badge" title="Заблокированный контакт">${icons.block}</span>` : ''}
            ${secondaryText ? `<span>${secondaryText}</span><span class="dot">·</span>` : ''}
            <span class="clock-ico">${icons.clock}</span>
            <span class="dur">${row.lastDurationSec > 0 ? formatDuration(row.lastDurationSec) : '—'}</span>
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
