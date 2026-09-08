// ============================================================================
// СТОР ЗАБЛОКИРОВАННЫХ НОМЕРОВ
// ----------------------------------------------------------------------------
// Локальный чёрный список (нормализованные номера) в localStorage.
// Поведение: входящие с заблокированных номеров сразу отклоняются
// (в истории остаются как пропущенные с бейджем), вызова/звонка нет.
//
// Про натив: системный BlockedNumberContract доступен только диалеру
// по умолчанию; синхронизация локального списка в системный провайдер —
// следующий шаг, когда роль default dialer стабильно получается на железе.
// ============================================================================

import { normalizeNumber } from './utils/format.js';

const STORAGE_KEY = 'dialer.blocked.v1';
const listeners = new Set();

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch (_) {
    // игнорируем повреждённое хранилище
  }
  return new Set();
}

let blocked = load();

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...blocked]));
  } catch (_) {
    // приватный режим и т.п. — блокировка живёт до перезапуска
  }
}

function notify() {
  listeners.forEach((cb) => {
    try {
      cb();
    } catch (_) {
      // noop
    }
  });
}

export const blockedStore = {
  isBlocked(number) {
    if (!number) return false;
    return blocked.has(normalizeNumber(String(number)));
  },

  block(number) {
    const key = normalizeNumber(String(number || ''));
    if (!key || blocked.has(key)) return false;
    blocked.add(key);
    save();
    notify();
    return true;
  },

  unblock(number) {
    const key = normalizeNumber(String(number || ''));
    if (!blocked.delete(key)) return false;
    save();
    notify();
    return true;
  },

  getAll() {
    return [...blocked];
  },

  onChange(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
  },
};
