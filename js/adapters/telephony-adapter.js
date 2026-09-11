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
import { contactsAdapter } from './contacts-adapter.js';
import { nativeBridge } from './native-bridge.js';
import { blockedStore } from '../blocked-store.js';

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

// ---------- Нативный режим (APK): события из InCallService ----------
// В native-режиме звонком управляет система (Telecom), а веб-UI только
// отображает состояние, приходящее событием 'telecomEvent'.
let nativeMode = false;
let endWatchdog = null;

function isNative() {
  return nativeMode;
}

// Системный CallLog дописывается с задержкой после отбоя: первый опрос
// часто приходит раньше записи. Дотягиваем список ещё дважды по таймеру.
function schedulePostCallRefresh() {
  [1200, 3500].forEach((ms) => setTimeout(() => {
    try {
      callLogAdapter.refreshFromSystem();
    } catch (_) {
      // noop
    }
  }, ms));
}

// Страховка красной трубки: если 'disconnected' из InCallService не придёт
// (например, звонок обслужил старый диалер, т.к. мы ещё не default),
// экран звонка всё равно гаснет и возвращает в список/клавиатуру.
function armEndWatchdog() {
  if (endWatchdog) clearTimeout(endWatchdog);
  endWatchdog = setTimeout(() => {
    endWatchdog = null;
    if (state.status !== 'idle') {
      try {
        callLogAdapter.refreshFromSystem();
      } catch (_) { /* noop */ }
      telephonyAdapter._reset();
    }
  }, 2500);
}

export async function initNativeTelephony() {
  if (nativeMode) return true;
  let ok = false;
  try {
    ok = await nativeBridge.isAvailable();
  } catch (_) {
    ok = false;
  }
  if (!ok) return false;
  nativeMode = true;
  try {
    await nativeBridge.onTelecomEvent(handleNativeEvent);
  } catch (_) {
    // События недоступны — исходящие всё равно идут через placeCall.
  }
  // WebView мог стартовать позже звонка (приложение убито/свёрнуто):
  // подтягиваем живое состояние, чтобы показать экран приёма/разговора.
  try {
    await syncNativeCallState();
  } catch (_) {
    // noop
  }
  return true;
}

export async function syncNativeCallState() {
  if (!nativeMode) return false;
  let snap = null;
  try {
    snap = await nativeBridge.getCurrentCall();
  } catch (_) {
    return false;
  }
  if (!snap || !snap.event || snap.event === 'other') return false;
  if (snap.event === 'disconnected' || snap.event === 'silenced') return false;
  await handleNativeEvent(snap);
  return true;
}

async function handleNativeEvent(e) {
  if (!e || !nativeMode) return;
  const number = e.number || state.number || '';
  let contact = null;
  try {
    contact = number ? await contactsAdapter.findByNumber(number) : null;
  } catch (_) {
    contact = null;
  }
  const base = {
    number,
    contactName: contact ? contact.name : null,
    photoUrl: contact && contact.photoUrl ? contact.photoUrl : null,
    speakerOn: state.speakerOn,
    micMuted: state.micMuted,
  };
  if (e.event === 'ringing-incoming') {
    // Заблокированный номер не звонит: сразу отбой, запись остаётся
    // в системном журнале, экран не показываем.
    try {
      if (blockedStore.isBlocked(number)) {
        try {
          await nativeBridge.hangUpCall();
        } catch (_) { /* noop */ }
        try {
          callLogAdapter.refreshFromSystem();
        } catch (_) { /* noop */ }
        return;
      }
    } catch (_) { /* noop */ }
    setState({ ...base, status: 'incoming-ringing', direction: 'incoming', startedAt: null });
  } else if (e.event === 'dialing') {
    setState({ ...base, status: 'outgoing-ringing', direction: 'outgoing', startedAt: null });
  } else if (e.event === 'active') {
    // startedAt не затираем: повторное событие не должно ронять таймер.
    setState({ ...base, status: 'active', direction: state.direction || 'outgoing', startedAt: state.startedAt || Date.now() });
  } else if (e.event === 'disconnected' || e.event === 'silenced') {
    // Запись уже в системном CallLog — обновляем список и гасим экран звонка.
    // Плюс дотяжки: провайдер может дописать строку позже нашего опроса.
    try {
      callLogAdapter.refreshFromSystem();
    } catch (_) { /* noop */ }
    schedulePostCallRefresh();
    telephonyAdapter._reset();
  }
}

export const telephonyAdapter = {
  getState() {
    return { ...state };
  },

  onStateChange(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
  },

  // Реальный вызов в APK: TelecomManager.placeCall() через нативный плагин.
  // Мок-ветка ниже используется только в браузере (PWA).
  async call(number, contact = null) {
    if (isNative()) {
      try {
        await nativeBridge.placeCall(number);
      } catch (err) {
        console.warn('[telephony] placeCall failed:', err);
        return; // Экран не показываем: вызов не создан, висеть нечему.
      }
      // Состояние уточнится событием 'dialing' из InCallService;
      // оптимистично сразу показываем экран набора.
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
      return;
    }
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
  // Заблокированный номер сразу уходит в пропущенные — без экрана и звонка.
  async simulateIncoming(number, contact = null) {
    try {
      if (blockedStore.isBlocked(number)) {
        await callLogAdapter.appendEntry({ number, type: 'missed', durationSec: 0 });
        return;
      }
    } catch (_) { /* noop */ }
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
    if (isNative()) {
      try {
        await nativeBridge.answerCall();
      } catch (e) {
        console.warn('[telephony] answer failed:', e);
      }
      return; // 'active' придёт событием из InCallService.
    }
    if (state.status !== 'incoming-ringing') return;
    setState({ status: 'active', startedAt: Date.now() });
  },

  async decline() {
    if (isNative()) {
      try {
        await nativeBridge.hangUpCall();
      } catch (e) {
        console.warn('[telephony] decline failed:', e);
        try {
          callLogAdapter.refreshFromSystem();
        } catch (_) { /* noop */ }
        telephonyAdapter._reset();
        return;
      }
      armEndWatchdog();
      return;
    }
    if (state.status !== 'incoming-ringing') return;
    await callLogAdapter.appendEntry({ number: state.number, type: 'missed', durationSec: 0 });
    this._reset();
  },

  async hangUp() {
    if (isNative()) {
      try {
        await nativeBridge.hangUpCall();
      } catch (e) {
        console.warn('[telephony] hangUp failed:', e);
        // Наш InCallService звонка не видел (обслужил старый диалер) —
        // гасим экран сразу, иначе он зависнет с активной красной трубкой.
        try {
          callLogAdapter.refreshFromSystem();
        } catch (_) { /* noop */ }
        telephonyAdapter._reset();
        return;
      }
      armEndWatchdog();
      return; // 'disconnected' придёт событием, лог уже в системе.
    }
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

  // Натив: AudioManager/CallAudioState через InCallService; локально
  // состояние обновляем оптимистично (событий об аудиомаршруте нет).
  setSpeakerOn(on) {
    if (isNative()) {
      nativeBridge.setSpeakerOn(on).catch((e) => console.warn('[telephony] speaker failed:', e));
    }
    setState({ speakerOn: on });
  },

  // TODO(native): маршрутизация аудио так, чтобы собеседник не слышал
  // пользователя, а пользователь продолжал слышать собеседника.
  setMicMuted(muted) {
    if (isNative()) {
      nativeBridge.setMicMuted(muted).catch((e) => console.warn('[telephony] mute failed:', e));
    }
    setState({ micMuted: muted });
  },

  // DTMF-тон в активном звонке (IVR-меню вида «нажмите 1»). В браузере — тихий no-op.
  async playDtmf(tone) {
    if (!isNative()) return;
    try {
      await nativeBridge.playDtmfTone(tone);
    } catch (e) {
      console.warn('[telephony] dtmf failed:', e);
    }
  },

  _reset() {
    clearTimeout(this._simTimer);
    if (endWatchdog) {
      clearTimeout(endWatchdog);
      endWatchdog = null;
    }
    setState({
      status: 'idle', direction: null, number: null, contactName: null,
      photoUrl: null, speakerOn: false, micMuted: false, startedAt: null,
    });
  },
};
