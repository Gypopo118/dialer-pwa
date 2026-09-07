// ============================================================================
// АДАПТЕР ЖУРНАЛА ЗВОНКОВ
// ----------------------------------------------------------------------------
// Реальный журнал звонков Android доступен только нативно через
// CallLog.Calls ContentProvider (разрешение READ_CALL_LOG / WRITE_CALL_LOG).
// Чтобы приложение вообще получало новые звонки в журнал, оно также должно
// быть назначено диалером по умолчанию (RoleManager.ROLE_DIALER, Android 10+)
// и/или реализовывать ConnectionService для перехвата вызовов.
//
// ПРИ ПЕРЕХОДЕ НА CAPACITOR / НАТИВНЫЙ APK:
//   - Заменить getEntries()/appendEntry() на нативный плагин, читающий/
//     пишущий CallLog.Calls.
//   - onCallLogChanged(callback) должен подписываться на
//     ContentObserver для CallLog.Calls.CONTENT_URI и дергать callback.
// ============================================================================

import { mockCallLog } from '../mock-data.js';

const STORAGE_KEY = 'dialer.calllog.v1';
const listeners = new Set();

function loadStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw).map((e) => ({ ...e, timestamp: new Date(e.timestamp) }));
  } catch (e) { /* игнорируем повреждённое хранилище */ }
  const seeded = mockCallLog.map((e) => ({ ...e }));
  saveStore(seeded);
  return seeded;
}

function saveStore(list) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(
    list.map((e) => ({ ...e, timestamp: e.timestamp.toISOString() }))
  ));
}

let entries = loadStore();

function notify() {
  listeners.forEach((cb) => cb());
}

export const callLogAdapter = {
  // TODO(native): заменить на CallLog.Calls query, сортировка по DATE DESC.
  async getEntries() {
    return [...entries].sort((a, b) => b.timestamp - a.timestamp);
  },

  async getEntriesForNumber(number) {
    const norm = number.replace(/[^\d+]/g, '');
    return entries
      .filter((e) => e.number.replace(/[^\d+]/g, '') === norm)
      .sort((a, b) => b.timestamp - a.timestamp);
  },

  // Добавление записи после завершения звонка (мок-телефония вызывает это
  // из telephony-adapter.js). В нативной версии запись появляется в
  // CallLog автоматически через систему — этот метод тогда не нужен.
  async appendEntry({ number, type, durationSec }) {
    entries.push({
      id: `call-${Date.now()}`,
      number,
      type, // 'outgoing' | 'incoming' | 'missed'
      durationSec,
      timestamp: new Date(),
    });
    saveStore(entries);
    notify();
  },

  async clearForNumber(number) {
    const norm = number.replace(/[^\d+]/g, '');
    entries = entries.filter((e) => e.number.replace(/[^\d+]/g, '') !== norm);
    saveStore(entries);
    notify();
  },

  // TODO(native): подписка на ContentObserver CallLog вместо ручного notify().
  onChange(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
  },
};
