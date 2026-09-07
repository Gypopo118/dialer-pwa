// ============================================================================
// АДАПТЕР ТЕЛЕФОНИИ
// ----------------------------------------------------------------------------
// Реальные звонки, управление громкой связью и микрофоном на Android
// возможны только через нативный TelecomManager / ConnectionService
// (плюс роль диалера по умолчанию для приёма входящих). Веб-PWA не может
// инициировать, принимать или управлять телефонным вызовом ОС напрямую —
// максимум, что доступно браузеру, это открыть системный номеронабиратель
// через ссылку tel:, без какого-либо контроля над самим звонком.
//
// Ниже — симулятор состояния звонка для демонстрации UX (экран звонка,
// таймер, спикер, mute), с тем же публичным интерфейсом, который должен
// реализовать нативный слой.
//
// ПРИ ПЕРЕХОДЕ НА CAPACITOR / НАТИВНЫЙ APK:
//   - call(number): TelecomManager.placeCall() через нативный плагин.
//   - answer()/decline()/hangUp(): Connection.onAnswer/onReject/onDisconnect.
//   - setSpeakerOn(bool): AudioManager.setSpeakerphoneOn() (или
//     CallAudioState в ConnectionService).
//   - setMicMuted(bool): Connection.onMute() либо CallAudioState с
//     ROUTE_MUTE — гарантирует, что собеседник не слышит пользователя,
//     сам пользователь продолжает слышать собеседника (согласно ТЗ).
//   - Входящий звонок обнаруживается через собственный ConnectionService /
//     CallScreeningService, а не из веб-кода.
// ============================================================================

import { callLogAdapter } from './call-log-adapter.js';

const listeners = new Set();

let state = {
  status: 'idle', // idle | outgoing-ringing | incoming-ringing | active | ended
  direction: null, // 'outgoing' | 'incoming'
  number: null,
  contactName: null,
  photoUrl: null,
  speakerOn: false,
  micMuted: false,
  startedAt: null,
};

function emit() {
  listeners.forEach((cb) => cb({ ...state }));
}

function setState(patch) {
  state = { ...state, ...patch };
  emit();
}

export const telephonyAdapter = {
  getState() {
    return { ...state };
  },

  onStateChange(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
  },

  // TODO(native): TelecomManager.placeCall(Uri.fromParts("tel", number, null), ...)
  async call(number, contact = null) {
    setState({
      status: 'outgoing-ringing',
      direction: 'outgoing',
      number,
      contactName: contact?.name || null,
      photoUrl: contact?.photoUrl || null,
      speakerOn: false,
      micMuted: false,
      startedAt: null,
    });
    // Симуляция взятия трубки собеседником через 2.5с — только для демо UX.
    this._simTimer = setTimeout(() => {
      if (state.status === 'outgoing-ringing') {
        setState({ status: 'active', startedAt: Date.now() });
      }
    }, 2500);
  },

  // Вызывается только из демо-кнопок ("Симулировать входящий"), в реальном
  // приложении входящий звонок инициирует нативный ConnectionService.
  async simulateIncoming(number, contact = null) {
    setState({
      status: 'incoming-ringing',
      direction: 'incoming',
      number,
      contactName: contact?.name || null,
      photoUrl: contact?.photoUrl || null,
      speakerOn: false,
      micMuted: false,
      startedAt: null,
    });
  },

  async answer() {
    if (state.status !== 'incoming-ringing') return;
    setState({ status: 'active', startedAt: Date.now() });
  },

  async decline() {
    if (state.status !== 'incoming-ringing') return;
    await callLogAdapter.appendEntry({ number: state.number, type: 'missed', durationSec: 0 });
    this._reset();
  },

  async hangUp() {
    if (state.status === 'idle') return;
    const durationSec = state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0;
    const type = state.status === 'incoming-ringing'
      ? 'missed'
      : (state.direction === 'outgoing' ? 'outgoing' : 'incoming');
    if (state.number) {
      await callLogAdapter.appendEntry({ number: state.number, type, durationSec });
    }
    this._reset();
  },

  // TODO(native): AudioManager.setSpeakerphoneOn(bool)
  setSpeakerOn(on) {
    setState({ speakerOn: on });
  },

  // TODO(native): маршрутизация аудио так, чтобы собеседник не слышал
  // пользователя, а пользователь продолжал слышать собеседника.
  setMicMuted(muted) {
    setState({ micMuted: muted });
  },

  _reset() {
    clearTimeout(this._simTimer);
    setState({
      status: 'idle', direction: null, number: null, contactName: null,
      photoUrl: null, speakerOn: false, micMuted: false, startedAt: null,
    });
  },
};
