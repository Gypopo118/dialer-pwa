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

import { nativeBridge } from './native-bridge.js';
import { numbersEqual, groupKeyForNumber } from '../utils/format.js';

const STORAGE_KEY = 'dialer.calllog.v1';
const listeners = new Set();

// id демо-записей из первых сборок (l1…l9). Заглушку убрали, но у тех, кто
// обновляет приложение поверх старой версии, записи могли остаться в
// localStorage — вычищаем их при загрузке.
const LEGACY_DEMO_ID = /^l\d+$/;

// Нативная оболочка (APK). Проверка синхронная: window.Capacitor
// инжектируется до наших скриптов.
function isNativeShell() {
  try {
    const cap = window.Capacitor;
    return !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
  } catch (_) {
    return false;
  }
}

function loadStore() {
  let parsed = [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) parsed = JSON.parse(raw);
  } catch (e) { /* игнорируем повреждённое хранилище */ }
  if (!Array.isArray(parsed)) return [];
  const cleaned = parsed.filter((e) => !LEGACY_DEMO_ID.test(String((e && e.id) || '')));
  if (cleaned.length !== parsed.length) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned)); } catch (_) { /* noop */ }
  }
  return cleaned.map((e) => ({ ...e, timestamp: new Date(e.timestamp) }));
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
  // silent: не поднимать диалог разрешений (нужно экрану входящего звонка —
  // системный запрос поверх кнопок «Принять/Отклонить» недопустим). Если
  // доступа нет, возвращаем null: «журнал недоступен» и «звонков не было» —
  // разные состояния, и выдавать второе за первое нельзя.
  async getEntries({ silent = false } = {}) {
    const sys = await nativeBridge.getCallLog(200, { silent });
    if (sys && sys.denied) return null;
    if (sys && Array.isArray(sys.entries)) {
      return sys.entries.map((e) => ({
        id: e.id,
        number: e.number || '',
        type: e.type,
        durationSec: e.durationSec || 0,
        timestamp: new Date(e.timestamp),
        cachedName: e.cachedName || null,
      }));
    }
    // В APK локального журнала нет: звонки пишет система. Пустой ответ здесь
    // означает «нет разрешения / провайдер недоступен», а не «нет истории»,
    // поэтому демо-моки из localStorage показывать нельзя — иначе на телефоне
    // после переустановки вместо журнала звонков видны выдуманные номера.
    if (await nativeBridge.isAvailable()) return [];
    // Плагин не отвечает, но мы всё равно в APK: это поломка моста, а не
    // браузерный режим. Пустая история честнее выдуманной.
    if (isNativeShell()) return [];
    return [...entries].sort((a, b) => b.timestamp - a.timestamp);
  },

  async getEntriesForNumber(number, opts) {
    const all = await this.getEntries(opts);
    if (all === null) return null;
    return all
      .filter((e) => numbersEqual(e.number || '', number))
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

  // «Удалить запись» в меню плашки недавних: убирает ВСЮ историю звонков
  // на этот номер (по правилу группировки плашек — хвост из 8 цифр).
  // В APK чистим системный CallLog нативным методом, в браузере — моки.
  async deleteForNumber(number) {
    if (await nativeBridge.isAvailable()) {
      await nativeBridge.deleteCallLogForNumber({ number });
      this.refreshFromSystem();
      return;
    }
    const key = groupKeyForNumber(number);
    entries = entries.filter((e) => groupKeyForNumber(e.number) !== key);
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
