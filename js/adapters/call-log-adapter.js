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
import { nativeBridge } from './native-bridge.js';

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
  // В APK читаем системный CallLog (там же лежат звонки с SIM). В браузере — моки.
  async getEntries() {
    const sys = await nativeBridge.getCallLog(200);
    if (sys && Array.isArray(sys.entries)) {
      return sys.entries.map((e) => ({
        id: e.id,
        number: e.number || '',
        type: e.type,
        durationSec: e.durationSec || 0,
        timestamp: new Date(e.timestamp),
      }));
    }
    return [...entries].sort((a, b) => b.timestamp - a.timestamp);
  },

  async getEntriesForNumber(number) {
    const norm = number.replace(/[^\d+]/g, '');
    const all = await this.getEntries();
    return all
      .filter((e) => (e.number || '').replace(/[^\d+]/g, '') === norm)
      .sort((a, b) => b.timestamp - a.timestamp);
  },

  // Добавление записи после завершения звонка. В APK запись появляется
  // в системном CallLog автоматически — сюда писать не нужно.
  async appendEntry({ number, type, durationSec }) {
    if (await nativeBridge.isAvailable()) return null;
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
  // Вызывается телефонией, когда InCallService сообщает о конце звонка:
  // системный лог уже обновлён, нужно только перерисовать список.
  refreshFromSystem() {
    notify();
  },

  onChange(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
  },
};
