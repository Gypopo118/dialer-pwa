import { icons } from '../utils/icons.js';
import { telephonyAdapter } from '../adapters/telephony-adapter.js';
import { formatDuration, formatPhoneForDisplay, initialsFromName } from '../utils/format.js';
import { pushLayer, popLayerSilently } from '../utils/back-stack.js';

const LAYER = 'call-screen';

export function initCallScreen() {
  const root = document.getElementById('call-screen');
  let timerInterval = null;
  let isOpen = false;

  telephonyAdapter.onStateChange((state) => render(state));
  render(telephonyAdapter.getState());

  function render(state) {
    if (state.status === 'idle') {
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
    const avatarContent = state.photoUrl
      ? `<img src="${state.photoUrl}" alt="">`
      : (state.contactName ? initialsFromName(state.contactName) : icons.phone);

    root.innerHTML = `
      <div class="call-screen__status">${statusText}</div>
      <div class="call-screen__avatar">${avatarContent}</div>
      <div class="call-screen__name">${displayName}</div>
      <div class="call-screen__number">${formatPhoneForDisplay(state.number || '')}</div>
      <div class="call-screen__timer" data-timer ${isActive ? '' : 'hidden'}>00:00</div>
      <div class="call-screen__spacer"></div>
      ${isActive || state.status === 'outgoing-ringing' ? `
        <div class="call-toggles">
          <button class="call-toggle" data-toggle="speaker" aria-pressed="${state.speakerOn}">
            <span class="call-toggle__circle">${icons.speaker}</span>
            <span class="call-toggle__label">Громкая связь</span>
          </button>
          <button class="call-toggle" data-toggle="mute" aria-pressed="${state.micMuted}">
            <span class="call-toggle__circle">${icons.micMute}</span>
            <span class="call-toggle__label">Выкл. мой звук</span>
          </button>
        </div>
      ` : ''}
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
    root.querySelector('[data-toggle="speaker"]')?.addEventListener('click', () =>
      telephonyAdapter.setSpeakerOn(!telephonyAdapter.getState().speakerOn));
    root.querySelector('[data-toggle="mute"]')?.addEventListener('click', () =>
      telephonyAdapter.setMicMuted(!telephonyAdapter.getState().micMuted));

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
