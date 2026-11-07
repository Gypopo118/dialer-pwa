import { icons } from '../utils/icons.js';
import { uiStore } from '../store.js';
import { blockedStore } from '../blocked-store.js';
import { contactRowTemplate } from './contact-list-screen.js';
import { buildRecentsList, filterRecents } from '../recents-model.js';
import { contactsAdapter } from '../adapters/contacts-adapter.js';
import { callLogAdapter } from '../adapters/call-log-adapter.js';
import { telephonyAdapter } from '../adapters/telephony-adapter.js';
import { nativeBridge } from '../adapters/native-bridge.js';
import { formatPhoneForDisplay, formatDuration, formatRecentMeta, sanitizePhoneNumber, dialSearchKey, groupKeyForNumber } from '../utils/format.js';
import { avatarHtml, warmPhotoCache, swapCachedPhotos } from '../utils/photo-cache.js';
import { attachListScrollGesture } from '../utils/list-scroll-gesture.js';
import { pushLayer, popLayerSilently, registerOverlay } from '../utils/back-stack.js';

const KEYPAD_LAYOUT = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['*', '0', '#'],
];
const SIDE_COL = ['search', 'paste', 'add-contact', 'contacts'];
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
  document.getElementById('search-close').innerHTML = icons.close;

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
    // Набранные цифры вживую фильтруют историю (smart dial), но список
    // не пересобирается: строки уже в DOM, фильтр только скрывает/показывает
    // их. Применяем следующим кадром — цифра успевает отрисоваться раньше
    // любой работы со списком.
    if (state.dialInput !== lastDialFilter) {
      lastDialFilter = state.dialInput;
      onDialInputChanged(state.dialInput || '');
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
    updateFakeCaret();
  }
  function placeCaret(pos) {
    const p = Math.max(0, Math.min(pos, dialInput.value.length));
    lastCaret = { start: p, end: p };
    dialInput.focus({ preventScroll: true });
    try { dialInput.setSelectionRange(p, p); } catch (_) { /* noop */ }
    updateFakeCaret();
  }
  dialInput.addEventListener('input', () => {
    rememberCaret();
    if (dialInput.value !== uiStore.get().dialInput) uiStore.set({ dialInput: dialInput.value });
  });
  dialInput.addEventListener('click', rememberCaret);
  dialInput.addEventListener('keyup', rememberCaret);
  dialInput.addEventListener('select', rememberCaret);
  // Свайп по полю ввода двигает курсор (работает и без системной клавиатуры).
  // Долгое нажатие + ведение пальцем — точное перетаскивание курсора с лупой:
  // над полем всплывает увеличенный фрагмент номера вокруг каретки.
  let swipeX = null, swipeY = null, swipeCaret = 0;
  let dragMode = false, dragTimer = null, dragStartX = 0, dragStartY = 0;
  const loupe = document.createElement('div');
  loupe.className = 'dial-loupe';
  loupe.hidden = true;
  dialBlock.appendChild(loupe);
  // Своя каретка: белый мигающий штрих поверх поля. Нативная в readonly
  // WebView часто не рисуется, а фокус уводят кнопки клавиатуры.
  const caretEl = document.createElement('div');
  caretEl.className = 'dial-caret';
  caretEl.hidden = true;
  dialInput.parentElement.appendChild(caretEl);
  function updateFakeCaret() {
    const v = dialInput.value || '';
    if (!v || dialBlock.classList.contains('dial-block--hidden')) {
      caretEl.hidden = true;
      return;
    }
    const { start } = effectiveCaret();
    const m = loupeMetrics();
    const rowRect = dialInput.parentElement.getBoundingClientRect();
    const pos = Math.max(0, Math.min(start, m.len));
    const x = m.startX + pos * m.charW - rowRect.left;
    const fontSize = parseFloat(getComputedStyle(dialInput).fontSize) || 32;
    caretEl.style.left = x + 'px';
    caretEl.style.height = Math.round(fontSize * 1.05) + 'px';
    caretEl.hidden = false;
  }
  function escapeLoupe(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function loupeMetrics() {
    const rect = dialInput.getBoundingClientRect();
    const blockRect = dialBlock.getBoundingClientRect();
    const fontSize = parseFloat(getComputedStyle(dialInput).fontSize) || 32;
    const charW = fontSize * 0.6 + 1; // цифра + letter-spacing
    const len = (dialInput.value || '').length;
    const textW = Math.min(len * charW, rect.width);
    // Текст отцентрован: начало строки + скролл поля.
    const startX = rect.left + (rect.width - textW) / 2 - dialInput.scrollLeft;
    return { blockRect, charW, len, startX };
  }
  function caretFromX(clientX) {
    const m = loupeMetrics();
    if (!m.len) return 0;
    return Math.max(0, Math.min(m.len, Math.round((clientX - m.startX) / m.charW)));
  }
  function showLoupe(caret) {
    const m = loupeMetrics();
    const v = dialInput.value || '';
    const from = Math.max(0, caret - 4), to = Math.min(v.length, caret + 5);
    const w = 170;
    loupe.innerHTML = `<span>${escapeLoupe(v.slice(from, caret))}</span>`
      + `<span class="dial-loupe__caret">${escapeLoupe(v.slice(caret, caret + 1)) || '&#8203;'}</span>`
      + `<span>${escapeLoupe(v.slice(caret + 1, to))}</span>`;
    loupe.hidden = false;
    const caretX = m.startX - m.blockRect.left + caret * m.charW;
    loupe.style.left = Math.max(8, Math.min(m.blockRect.width - w - 8, caretX - w / 2)) + 'px';
  }
  function hideLoupe() { loupe.hidden = true; }
  dialInput.addEventListener('contextmenu', (e) => e.preventDefault());
  dialInput.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    swipeX = t.clientX; swipeY = t.clientY;
    swipeCaret = effectiveCaret().start;
    dragMode = false;
    dragStartX = t.clientX; dragStartY = t.clientY;
    if (dragTimer) clearTimeout(dragTimer);
    dragTimer = setTimeout(() => {
      dragTimer = null;
      if (swipeX === null) return;
      // Палец стоит на месте — входим в перетаскивание курсора с лупой.
      dragMode = true;
      const c = caretFromX(dragStartX);
      placeCaret(c);
      showLoupe(c);
    }, 450);
  }, { passive: true });
  dialInput.addEventListener('touchmove', (e) => {
    if (!dragMode) {
      // Палец ушёл до срабатывания таймера — это свайп, а не перетаскивание.
      if (dragTimer) {
        const t = e.touches[0];
        if (Math.hypot(t.clientX - dragStartX, t.clientY - dragStartY) > 12) {
          clearTimeout(dragTimer);
          dragTimer = null;
        }
      }
      return;
    }
    e.preventDefault(); // не даём скроллу и выделению дёргать поле
    const c = caretFromX(e.touches[0].clientX);
    placeCaret(c);
    showLoupe(c);
  }, { passive: false });
  dialInput.addEventListener('touchcancel', () => {
    if (dragTimer) { clearTimeout(dragTimer); dragTimer = null; }
    dragMode = false;
    hideLoupe();
    swipeX = null;
  }, { passive: true });
  dialInput.addEventListener('touchend', (e) => {
    if (dragTimer) { clearTimeout(dragTimer); dragTimer = null; }
    if (dragMode) {
      // Отпустили после перетаскивания: курсор уже стоит, свайп-сдвиг не нужен.
      dragMode = false;
      hideLoupe();
      swipeX = null;
      rememberCaret();
      return;
    }
    if (swipeX === null) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - swipeX, dy = t.clientY - swipeY;
    swipeX = null;
    if (Math.abs(dx) < 12 && Math.abs(dy) < 12) {
      // Тап: поле readonly, поэтому нативный тап каретку не ставит
      // (и системную клавиатуру не будит) — ставим вручную по координате.
      placeCaret(caretFromX(t.clientX));
      return;
    }
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
    const raw = uiStore.get().dialInput;
    if (!raw) return;
    // Страховка второго уровня: скобки/пробелы/дефисы не должны доехать
    // до tel: URI (первый уровень — чистка при вставке из буфера).
    const number = sanitizePhoneNumber(raw) || raw;
    if (!number) return;
    const contact = await contactsAdapter.findByNumber(number);
    telephonyAdapter.call(number, contact);
  });

  // ===== Клавиатура набора =====
  // Короткий виброотклик клавиш — самый короткий вариант (20 мс),
  // тот же, что и при долгом нажатии «0».
  function vibrateKeyFeedback() {
    if (navigator.vibrate) { try { navigator.vibrate(20); } catch (_) { /* noop */ } }
  }

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
        // «0» с маленьким «+» справа от цифры (как в обычных звонилках):
        // короткий тап — «0», долгое нажатие — «+».
        key.innerHTML = digit === '0'
          ? `<span class="digit digit--zero">0<span class="plus-side">+</span></span>`
          : `<span class="digit">${digit}</span>`;
        keypadEl.appendChild(key);
      });
    });

    // Долгое нажатие «0»: ноль уже стоит в поле (вставлен на касании),
    // через 500 мс меняем именно его на «+». Короткий тап даёт «0» сразу,
    // удержание — «+», и «0+» в поле не появляется.
    let zeroTimer = null;
    let zeroIndex = -1;

    function startZeroLongPress(index) {
      clearTimeout(zeroTimer);
      zeroIndex = index;
      zeroTimer = setTimeout(() => {
        zeroTimer = null;
        vibrateKeyFeedback();
        const cur = uiStore.get().dialInput || '';
        if (zeroIndex >= 0 && cur[zeroIndex] === '0') {
          uiStore.set({ dialInput: cur.slice(0, zeroIndex) + '+' + cur.slice(zeroIndex + 1) });
          placeCaret(zeroIndex + 1);
        } else {
          // Поле изменилось другим нажатием — обычное поведение long-press:
          // «+» в текущую позицию каретки.
          const { start, end } = effectiveCaret();
          uiStore.set({ dialInput: cur.slice(0, start) + '+' + cur.slice(end) });
          placeCaret(start + 1);
        }
        zeroIndex = -1;
      }, 500);
    }

    function cancelZeroLongPress() {
      clearTimeout(zeroTimer);
      zeroTimer = null;
      zeroIndex = -1;
    }

    // Цифра вводится в момент касания (pointerdown), а не по отпусканию:
    // click приходит только на touchend и добавлял 40–120 мс задержки,
    // из-за чего цифра казалась отставшей от уже вспыхнувшей клавиши.
    // При сдвиге пальца браузер мог вовсе не синтезировать click — цифра
    // терялась. click остаётся только для клавиатуры и скринридера
    // (у них detail === 0); у клика от пальца/мыши detail >= 1, иначе
    // каждая цифра вводилась бы дважды.
    keypadEl.querySelectorAll('.key[data-digit]').forEach((key) => {
      const digit = key.dataset.digit;
      key.addEventListener('pointerdown', (e) => {
        if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
        const index = appendDigit(digit);
        if (digit === '0') startZeroLongPress(index);
      });
      key.addEventListener('click', (e) => {
        if (e.detail !== 0) return;
        appendDigit(digit);
      });
    });

    const zeroKey = keypadEl.querySelector('.key[data-digit="0"]');
    zeroKey.addEventListener('pointerup', cancelZeroLongPress);
    zeroKey.addEventListener('pointercancel', cancelZeroLongPress);

    // Отклик нажатия любой клавиши, как в штатной клавиатуре Google:
    // вибрация в момент касания + корпус клавиши быстро светлеет до
    // светло-серого, а после отпускания плавно гаснет обратно.
    keypadEl.querySelectorAll('.key').forEach((key) => {
      const unlit = () => key.classList.remove('key--lit');
      key.addEventListener('pointerdown', () => {
        vibrateKeyFeedback();
        key.classList.add('key--lit');
      }, { passive: true });
      key.addEventListener('pointerup', unlit, { passive: true });
      key.addEventListener('pointercancel', unlit, { passive: true });
      key.addEventListener('pointerleave', unlit, { passive: true });
    });

    keypadEl.querySelector('[data-side="search"]').addEventListener('click', () => {
      document.getElementById('search-toggle').click();
    });
    keypadEl.querySelector('[data-side="paste"]').addEventListener('click', pasteFromClipboard);
    keypadEl.querySelector('[data-side="add-contact"]').addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('dialer:add-contact-blank'));
    });
    keypadEl.querySelector('[data-side="contacts"]').addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('dialer:open-contacts'));
    });
  }

  // Вставка номера из буфера обмена: чистим скобки/пробелы/дефисы,
  // вставляем в позицию курсора (выделение заменяется).
  async function pasteFromClipboard() {
    let raw = '';
    // 1. APK: системный буфер через нативный мост. В WebView штатный
    // navigator.clipboard.readText() часто заблокирован и молча падает —
    // именно поэтому кнопка «молчала» на устройстве.
    try {
      const native = await nativeBridge.getClipboardText();
      if (typeof native === 'string' && native) raw = native;
    } catch (_) { /* noop — пробуем веб-путь */ }
    // 2. Браузер (PWA): стандартный Clipboard API.
    if (!raw) {
      try {
        raw = await navigator.clipboard.readText();
      } catch (_) {
        return;
      }
    }
    const cleaned = sanitizePhoneNumber(raw);
    if (!cleaned) return;
    const cur = uiStore.get().dialInput || '';
    const { start, end } = effectiveCaret();
    uiStore.set({ dialInput: cur.slice(0, start) + cleaned + cur.slice(end) });
    placeCaret(start + cleaned.length);
    showKeyboard();
  }

  // Номер извне — меню «Открыть с помощью» в браузере (tel:-intent из ОС).
  // Заменяет содержимое поля набора (курсор в конец) и показывает
  // клавиатуру, чтобы номер был виден сразу, даже если пользователь
  // до этого свернул её. Чистка та же, что при вставке из буфера.
  function setExternalNumber(raw) {
    const cleaned = sanitizePhoneNumber(raw);
    if (!cleaned) return;
    uiStore.set({ dialInput: cleaned });
    lastCaret = { start: cleaned.length, end: cleaned.length };
    showKeyboard();
  }

  function sideIconFor(name) {
    if (name === 'search') return icons.search;
    if (name === 'paste') return icons.paste;
    if (name === 'add-contact') return icons.addContact;
    if (name === 'contacts') return icons.contacts;
    return '';
  }

  // Возвращает позицию вставленного символа: по ней long-press «0» находит
  // именно тот ноль, который поставило это же нажатие.
  function appendDigit(d) {
    const cur = uiStore.get().dialInput || '';
    const { start, end } = effectiveCaret();
    uiStore.set({ dialInput: cur.slice(0, start) + d + cur.slice(end) });
    placeCaret(start + d.length);
    showKeyboard();
    return start;
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
  // История рисуется один раз на смену данных (#recents-history). Набор цифр
  // не пересобирает DOM: фильтр только скрывает/показывает уже существующие
  // строки. Поэтому цифра не ждёт перерисовку списка даже на длинной истории.
  const historyEl = document.getElementById('recents-history');
  const contactsEl = document.getElementById('recents-contacts');
  const emptyEl = document.getElementById('recents-empty');

  let renderSeq = 0;
  let lastRecentsHtml = '';
  let lastContactsHtml = '';
  let historyCache = []; // [{ el, key, dialKey, row }]
  let visibleRowCount = 0;
  let lastAppliedDkey = null;
  let savedScrollTop = 0;
  let filterRaf = 0;

  // Строку поиска (в отличие от набора) пересобираем целиком: там матчинг
  // идёт и по именам, а не только по цифрам. Дебаунс остаётся прежним.
  let renderTimer = null;
  function scheduleRender(delay = 150) {
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      renderTimer = null;
      renderRecents();
    }, delay);
  }

  // Поиск контактов при наборе — отдельный дебаунс: история фильтруется
  // мгновенно, контакты догоняют после паузы и на цифры не влияют.
  let contactsTimer = null;
  let contactsSeq = 0;
  function scheduleContacts(digits) {
    if (contactsTimer) { clearTimeout(contactsTimer); contactsTimer = null; }
    const seq = ++contactsSeq;
    if (!digits) { renderContactsBlock([]); return; }
    contactsTimer = setTimeout(async () => {
      contactsTimer = null;
      if (seq !== contactsSeq) return;
      let found = [];
      try {
        found = await contactsAdapter.search(digits);
      } catch (_) {
        found = [];
      }
      if (seq !== contactsSeq) return;
      const cur = (uiStore.get().dialInput || '').replace(/[^\d+]/g, '');
      if (cur !== digits) return; // номер уже изменился
      renderContactsBlock(filterContactMatches(found, digits));
    }, 250);
  }

  // Контакт уже виден в истории (в любом написании) — не дублируем.
  // Сверяемся со всей историей, а не только с видимыми строками.
  function filterContactMatches(found, digits) {
    const dkey = dialSearchKey(digits);
    const inHistory = new Set();
    allRows.forEach((r) => (r.entries || []).forEach((e) => inHistory.add(groupKeyForNumber(e.number))));
    return found.filter((c) =>
      (c.numbers || []).some((n) => dialSearchKey(n).includes(dkey))
      && !((c.numbers || []).some((n) => inHistory.has(groupKeyForNumber(n))))
    );
  }

  async function refreshRecents() {
    allRows = await buildRecentsList();
    renderRecents();
  }

  // Полная отрисовка истории: только смена данных или поиск, не набор.
  function renderHistory(rows) {
    const html = rows.map(rowTemplate).join('');
    if (html === lastRecentsHtml && historyCache.length) { syncEmptyState(); return; }
    lastRecentsHtml = html;
    const keepScroll = recentsEl.scrollTop;
    historyEl.innerHTML = html;
    const byKey = new Map(rows.map((r) => [r.key, r]));
    historyCache = [];
    historyEl.querySelectorAll('.recent-row[data-key]').forEach((el) => {
      const row = byKey.get(el.dataset.key);
      if (!row) { el.remove(); return; }
      historyCache.push({ el, key: row.key, dialKey: dialSearchKey(row.number), row });
      bindHistoryRow(el, row);
    });
    visibleRowCount = historyCache.length;
    setScrollTop(keepScroll);
    syncEmptyState();
  }

  function bindHistoryRow(el, row) {
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-call]')) return;
      contextMenu.open(row);
    });
    el.querySelector('[data-call]').addEventListener('click', () => {
      telephonyAdapter.call(row.number, row.contact);
    });
  }

  function renderContactsBlock(list) {
    const html = list.length
      ? `<div class="recents-group-label">Контакты</div>` + list.map(contactRowTemplate).join('')
      : '';
    if (html === lastContactsHtml) { syncEmptyState(); return; }
    lastContactsHtml = html;
    contactsEl.innerHTML = html;
    contactsEl.hidden = !html;
    bindContactRows(list);
    syncEmptyState();
  }

  function bindContactRows(list) {
    const byId = new Map(list.map((c) => [String(c.id), c]));
    contactsEl.querySelectorAll('[data-contact]').forEach((el) => {
      const c = byId.get(el.dataset.contact);
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

  // Фильтр набора: только видимость готовых строк. Ни innerHTML, ни новых
  // узлов, ни повторной привязки слушателей.
  function applyDialFilter(dkey) {
    const { searchOpen, searchQuery } = uiStore.get();
    // При непустом поиске список строк уже сужен renderHistory — не трогаем.
    if (searchOpen && (searchQuery || '').trim()) return;
    const filtering = !!dkey;
    const was = !!lastAppliedDkey;
    if (filtering && !was) savedScrollTop = recentsEl.scrollTop;
    let visible = 0;
    for (const item of historyCache) {
      const show = !filtering || item.dialKey.includes(dkey);
      if (show) visible++;
      if (item.el.hidden === show) item.el.hidden = !show;
    }
    visibleRowCount = visible;
    if (filtering && !was) setScrollTop(0);
    else if (!filtering && was) setScrollTop(savedScrollTop);
    lastAppliedDkey = dkey;
    syncEmptyState();
  }

  function syncEmptyState() {
    const { searchOpen, searchQuery } = uiStore.get();
    const dkey = dialSearchKey((uiStore.get().dialInput || '').replace(/[^\d+]/g, ''));
    const hasContacts = !contactsEl.hidden && contactsEl.childElementCount > 0;
    if (visibleRowCount === 0 && !hasContacts) {
      const filtered = (searchOpen && (searchQuery || '').trim()) || dkey;
      emptyEl.textContent = filtered ? 'Ничего не найдено' : 'Пока нет истории звонков';
      emptyEl.hidden = false;
    } else {
      emptyEl.hidden = true;
    }
  }

  function setScrollTop(top) {
    // .recents имеет scroll-behavior: smooth — для фильтра нужен мгновенный.
    recentsEl.style.scrollBehavior = 'auto';
    recentsEl.scrollTop = top;
    recentsEl.style.scrollBehavior = '';
  }

  // Цифра уже в поле (синхронно). Фильтр — следующим кадром, чтобы ввод
  // не ждал список; контакты — отдельным дебаунсом.
  function onDialInputChanged(value) {
    const digits = (value || '').replace(/[^\d+]/g, '');
    const dkey = dialSearchKey(digits);
    if (filterRaf) cancelAnimationFrame(filterRaf);
    filterRaf = requestAnimationFrame(() => {
      filterRaf = 0;
      applyDialFilter(dkey);
    });
    scheduleContacts(digits);
  }

  // Поиск и refresh: единственные пути полной отрисовки. Набор сюда не ходит.
  async function renderRecents() {
    const seq = ++renderSeq;
    const { searchQuery, searchOpen, dialInput: dial } = uiStore.get();
    const q = (searchQuery || '').trim();
    const dkey = dialSearchKey((dial || '').replace(/[^\d+]/g, ''));

    // При наборе база — вся история: её сужает applyDialFilter. При поиске
    // список строк сужается сразу (поиск матчит и имена, и номера).
    let rows = allRows;
    if (searchOpen && q) rows = filterRecents(allRows, q);

    renderHistory(rows);
    applyDialFilter(dkey);

    if (!searchOpen || !q) {
      if (!dkey) {
        renderContactsBlock([]);
        afterRenderPhotos(rows, []);
      }
      return; // контактами набора управляет scheduleContacts
    }

    let found = [];
    try {
      found = await contactsAdapter.search(q);
    } catch (_) {
      found = [];
    }
    if (seq !== renderSeq) return;
    renderContactsBlock(found);
    afterRenderPhotos(rows, found);
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
    const isFailedOut = row.lastType === 'outgoing' && !(row.lastDurationSec > 0);
    const arrow = (row.lastType === 'incoming' || row.lastType === 'missed') ? icons.arrowIn : icons.arrowOut;
    const colorClass = `call-arrow--${row.lastType === 'missed' ? 'missed' : row.lastType === 'incoming' ? 'in' : (isFailedOut ? 'failed' : 'out')}`;
    const numberText = formatPhoneForDisplay(row.number);
    const primaryText = row.contact && row.contact.nameResolved !== false
      ? row.contact.name
      : (row.lastCachedName || numberText);
    const titleIsNumber = primaryText === numberText;
    const secondaryText = titleIsNumber ? null : numberText;
    const avatarContent = avatarHtml({
      name: titleIsNumber ? null : primaryText,
      photoUrl: isKnown ? row.contact.photoUrl : null,
      contactId: isKnown ? row.contact.id : null,
      fallbackHtml: icons.person,
    });
    const meta = formatRecentMeta(row.lastTimestamp);

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
            ${secondaryText ? `<span class="recent-number">${secondaryText}</span><span class="dot">·</span>` : ''}
            <span class="clock-ico">${icons.clock}</span>
            <span class="dur">${row.lastDurationSec > 0 ? formatDuration(row.lastDurationSec) : '—'}</span>
          </div>
        </div>
        <div class="recent-meta">
          <span class="recent-time"><span class="recent-time__day">${meta.top}</span><span class="recent-time__clock">${meta.bottom}</span></span>
          <button class="recent-call-btn" data-call>${icons.phone}</button>
        </div>
      </div>
    `;
  }

  return { refreshRecents, setExternalNumber };
}
