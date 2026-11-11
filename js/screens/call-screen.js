import { icons } from '../utils/icons.js';
import { telephonyAdapter } from '../adapters/telephony-adapter.js';
import { callLogAdapter } from '../adapters/call-log-adapter.js';
import { formatDuration, formatPhoneForDisplay, formatRecentMeta } from '../utils/format.js';
import { avatarHtml } from '../utils/photo-cache.js';
import { pushLayer, popLayerSilently, registerOverlay } from '../utils/back-stack.js';

const LAYER = 'call-screen';

// Сколько последних звонков максимум готовим разметкой. Сколько реально
// видно — решает высота свободного места: строки, не влезающие целиком,
// скрываются (список на экране приёма не прокручивается).
const MAX_HISTORY_ROWS = 7;

// Быстрые SMS-ответы на входящий: сброс + моментальная отправка.
const SMS_REPLIES = ['Привет, я перезвоню', 'Добрый день, я перезвоню'];

export function initCallScreen() {
  const root = document.getElementById('call-screen');
  let timerInterval = null;
  let isOpen = false;
  let padOpen = false;
  let lastState = telephonyAdapter.getState();
  let historySeq = 0;
  let historyObserver = null;

  telephonyAdapter.onStateChange((state) => render(state));
  registerOverlay({
    isOpen: () => isOpen,
    close: () => {
      // Как жест: сворачиваем UI звонка, сам звонок продолжается.
      historySeq++;
      disconnectHistoryObserver();
      root.classList.remove('call-screen--open');
      isOpen = false;
    },
  });
  render(telephonyAdapter.getState());

  function render(state) {
    lastState = state;
    if (state.status === 'idle') {
      padOpen = false;
      close();
      return;
    }
    if (!isOpen) open();
    disconnectHistoryObserver();

    const isIncoming = state.status === 'incoming-ringing';
    const isActive = state.status === 'active';
    const statusText = {
      'outgoing-ringing': 'Вызов…',
      'incoming-ringing': 'Входящий звонок',
      'active': 'Соединено',
    }[state.status] || '';

    const displayName = state.contactName || 'Неизвестный номер';
    const avatarContent = avatarHtml({
      name: state.contactName,
      photoUrl: state.photoUrl,
      contactId: state.contactId,
      fallbackHtml: icons.person,
    });

    root.innerHTML = `
      <div class="call-screen__status">${statusText}</div>
      <div class="call-screen__avatar">${avatarContent}</div>
      <div class="call-screen__name">${displayName}</div>
      <div class="call-screen__number">${formatPhoneForDisplay(state.number || '')}</div>
      ${isIncoming ? `
      <div class="call-replies">
        <button class="reply-btn" data-reply="0">Привет, я перезвоню</button>
        <button class="reply-btn" data-reply="1">Добрый день, я перезвоню</button>
      </div>
      <div class="call-history" data-history></div>
      ` : ''}
      <div class="call-screen__timer" data-timer ${isActive ? '' : 'hidden'}>00:00</div>
      ${isIncoming ? '' : '<div class="call-screen__spacer"></div>'}
      ${isActive || state.status === 'outgoing-ringing' ? (padOpen ? `
        <div class="dtmf">
          <div class="dtmf-head">
            <span class="dtmf-title">Набор номера</span>
            <button class="icon-btn" data-action="pad-close" aria-label="Закрыть клавиатуру">✕</button>
          </div>
          <div class="dtmf-grid">
            ${['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map((d) => `<button class="dtmf-key" data-dtmf="${d}">${d}</button>`).join('')}
          </div>
        </div>
      ` : `
        <div class="call-toggles">
          <button class="call-toggle" data-toggle="speaker" aria-pressed="${state.speakerOn}">
            <span class="call-toggle__circle">${icons.speaker}</span>
            <span class="call-toggle__label">Громкая связь</span>
          </button>
          <button class="call-toggle" data-toggle="dialpad" aria-pressed="false">
            <span class="call-toggle__circle">${icons.dialpad}</span>
            <span class="call-toggle__label">Клавиатура</span>
          </button>
          <button class="call-toggle" data-toggle="mute" aria-pressed="${state.micMuted}">
            <span class="call-toggle__circle">${icons.micMute}</span>
            <span class="call-toggle__label">Выкл. мой звук</span>
          </button>
        </div>
      `) : ''}
      <div class="call-actions ${isIncoming ? 'call-actions--incoming' : ''}">
        ${isIncoming ? `
          <button class="call-action-btn call-action-btn--decline" data-action="decline">${icons.hangup}</button>
          <button class="call-action-btn call-action-btn--accept" data-action="answer">${icons.phone}</button>
        ` : `
          <button class="call-action-btn call-action-btn--end" data-action="hangup">${icons.hangup}</button>
        `}
      </div>
    `;

    root.querySelector('[data-action="answer"]')?.addEventListener('click', () => telephonyAdapter.answer());
    root.querySelector('[data-action="decline"]')?.addEventListener('click', () => telephonyAdapter.decline());
    root.querySelector('[data-action="hangup"]')?.addEventListener('click', () => telephonyAdapter.hangUp());
    root.querySelectorAll('[data-reply]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const text = SMS_REPLIES[Number(btn.dataset.reply)];
        if (text) telephonyAdapter.declineWithMessage(text);
      });
    });
    root.querySelector('[data-toggle="speaker"]')?.addEventListener('click', () =>
      telephonyAdapter.setSpeakerOn(!telephonyAdapter.getState().speakerOn));
    root.querySelector('[data-toggle="mute"]')?.addEventListener('click', () =>
      telephonyAdapter.setMicMuted(!telephonyAdapter.getState().micMuted));
    root.querySelector('[data-toggle="dialpad"]')?.addEventListener('click', () => {
      padOpen = true;
      render(lastState);
    });
    root.querySelector('[data-action="pad-close"]')?.addEventListener('click', () => {
      padOpen = false;
      render(lastState);
    });
    root.querySelectorAll('[data-dtmf]').forEach((btn) => {
      btn.addEventListener('click', () => telephonyAdapter.playDtmf(btn.dataset.dtmf));
    });

    if (isIncoming) {
      const historyEl = root.querySelector('[data-history]');
      if (historyEl) loadIncomingHistory(state, historyEl);
    }

    if (isActive && !timerInterval) {
      timerInterval = setInterval(() => {
        const s = telephonyAdapter.getState();
        if (s.status !== 'active' || !s.startedAt) return;
        const el = root.querySelector('[data-timer]');
        if (el) el.textContent = formatDuration(Math.floor((Date.now() - s.startedAt) / 1000));
      }, 1000);
    }
  }

  // История звонков с номера, который сейчас звонит. Читаем без запроса
  // разрешений (silent): системный диалог поверх кнопок приёма недопустим.
  // null из адаптера = журнал недоступен — блок оставляем пустым, чтобы
  // не соврать «Новый звонок».
  async function loadIncomingHistory(state, container) {
    const seq = ++historySeq;
    let entries = null;
    try {
      entries = await callLogAdapter.getEntriesForNumber(state.number || '', { silent: true });
    } catch (_) {
      entries = null;
    }
    if (seq !== historySeq || !container.isConnected) return;
    if (entries === null) return;

    // Текущий звонок в системный журнал ещё не записан (запись появляется
    // после отбоя), но отсекаем его и по времени начала — это страховка.
    const cutoff = state.ringingAt ? state.ringingAt - 1000 : Infinity;
    const rows = entries
      .filter((e) => e.timestamp.getTime() < cutoff)
      .slice(0, MAX_HISTORY_ROWS);

    if (!rows.length) {
      container.innerHTML = '<div class="call-history__empty">Новый звонок</div>';
      return;
    }

    container.innerHTML = rows.map(historyRowTemplate).join('');
    requestAnimationFrame(() => fitHistoryRows(container));
    if (typeof ResizeObserver === 'function') {
      historyObserver = new ResizeObserver(() => fitHistoryRows(container));
      historyObserver.observe(container);
    }
  }

  // Строка истории того же вида, что плашки на главном экране, но без
  // аватара и кнопки вызова: номер и фото и так в шапке экрана приёма.
  function historyRowTemplate(entry) {
    const isFailedOut = entry.type === 'outgoing' && !(entry.durationSec > 0);
    const arrow = (entry.type === 'incoming' || entry.type === 'missed') ? icons.arrowIn : icons.arrowOut;
    const colorClass = `call-arrow--${entry.type === 'missed' ? 'missed' : entry.type === 'incoming' ? 'in' : (isFailedOut ? 'failed' : 'out')}`;
    const typeLabel = {
      outgoing: 'Исходящий',
      incoming: 'Входящий',
      missed: 'Пропущенный',
    }[entry.type] || 'Звонок';
    const meta = formatRecentMeta(entry.timestamp);

    return `
      <div class="call-history__row">
        <div class="call-history__main">
          <div class="call-history__type">${typeLabel}</div>
          <div class="recent-sub">
            <span class="call-arrow ${colorClass}">${arrow}</span>
            <span class="clock-ico">${icons.clock}</span>
            <span class="dur">${entry.durationSec > 0 ? formatDuration(entry.durationSec) : '—'}</span>
          </div>
        </div>
        <div class="recent-time">
          <span class="recent-time__day">${meta.top}</span>
          <span class="recent-time__clock">${meta.bottom}</span>
        </div>
      </div>
    `;
  }

  // Показываем только строки, влезающие целиком: половина обрезанной
  // плашки выглядит как баг. Вызывается после вставки и при изменении
  // высоты (поворот/раскладка клавиатуры).
  function fitHistoryRows(container) {
    const rows = [...container.querySelectorAll('.call-history__row')];
    if (!rows.length) return;
    rows.forEach((row) => { row.hidden = false; });
    const limit = container.clientHeight;
    for (const row of rows) {
      if (row.offsetTop + row.offsetHeight > limit) row.hidden = true;
    }
  }

  function disconnectHistoryObserver() {
    if (historyObserver) {
      historyObserver.disconnect();
      historyObserver = null;
    }
  }

  function open() {
    isOpen = true;
    root.classList.add('call-screen--open');
    pushLayer(LAYER, () => {
      // Свайп-назад во время звонка не должен незаметно "терять" вызов —
      // сворачиваем экран звонка, но сам звонок продолжается (как в Android:
      // сворачивание в шторку). Для прототипа — просто скрываем интерфейс,
      // сам мок-звонок остаётся активным до hangUp().
      // В APK этот путь не используется: при живом звонке MainActivity
      // сворачивает приложение, не трогая WebView (см. MainActivity.java).
      root.classList.remove('call-screen--open');
      isOpen = false;
    });
  }

  function close() {
    if (!isOpen) { cleanupTimer(); return; }
    historySeq++;
    disconnectHistoryObserver();
    root.classList.remove('call-screen--open');
    popLayerSilently(LAYER);
    isOpen = false;
    cleanupTimer();
  }

  function cleanupTimer() {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}
