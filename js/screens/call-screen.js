import { icons } from '../utils/icons.js';
import { telephonyAdapter } from '../adapters/telephony-adapter.js';
import { formatDuration, formatPhoneForDisplay } from '../utils/format.js';
import { avatarHtml } from '../utils/photo-cache.js';
import { pushLayer, popLayerSilently, registerOverlay } from '../utils/back-stack.js';

const LAYER = 'call-screen';

// Быстрые SMS-ответы на входящий: сброс + моментальная отправка.
const SMS_REPLIES = ['Привет, я перезвоню', 'Добрый день, я перезвоню'];

export function initCallScreen() {
  const root = document.getElementById('call-screen');
  let timerInterval = null;
  let isOpen = false;
  let padOpen = false;
  let lastState = telephonyAdapter.getState();

  telephonyAdapter.onStateChange((state) => render(state));
  registerOverlay({
    isOpen: () => isOpen,
    close: () => {
      // Как жест: сворачиваем UI звонка, сам звонок продолжается.
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
      <div class="call-screen__timer" data-timer ${isActive ? '' : 'hidden'}>00:00</div>
      <div class="call-screen__spacer"></div>
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
      ${isIncoming ? `
      <div class="call-replies">
        <button class="reply-btn" data-reply="0">Привет, я перезвоню</button>
        <button class="reply-btn" data-reply="1">Добрый день, я перезвоню</button>
      </div>
      ` : ''}
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

    if (isActive && !timerInterval) {
      timerInterval = setInterval(() => {
        const s = telephonyAdapter.getState();
        if (s.status !== 'active' || !s.startedAt) return;
        const el = root.querySelector('[data-timer]');
        if (el) el.textContent = formatDuration(Math.floor((Date.now() - s.startedAt) / 1000));
      }, 1000);
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
      root.classList.remove('call-screen--open');
      isOpen = false;
    });
  }

  function close() {
    if (!isOpen) { cleanupTimer(); return; }
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
