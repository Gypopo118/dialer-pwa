// ============================================================================
// АДАПТЕР SIM-КАРТ
// ----------------------------------------------------------------------------
// Нативная часть — DialerTelecomPlugin (SubscriptionManager + TelecomManager):
// getSims() отдаёт активные SIM с телефонным аккаунтом, onSimsChanged() —
// событие при смене лотка/настроек. В браузере (PWA) SIM нет: пустой список,
// кнопка вызова остаётся в классическом режиме.
// Выбранная SIM хранится в SharedPreferences (через мост) и в localStorage
// как запасной путь для PWA.
// ============================================================================

import { nativeBridge } from './native-bridge.js';

const STORAGE_KEY = 'dialer.selectedSimId';
const MAX_SIMS = 2; // умная капсула рассчитана на две карты

function normalize(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : [])
    .map((s) => ({
      subscriptionId: Number(s && s.subscriptionId),
      slotIndex: Number(s && s.slotIndex),
      name: String((s && s.name) || '').trim(),
      phoneAccountId: String((s && s.phoneAccountId) || ''),
    }))
    .filter((s) => Number.isFinite(s.subscriptionId) && Number.isFinite(s.slotIndex) && s.slotIndex >= 0)
    .filter((s) => {
      if (seen.has(s.subscriptionId)) return false;
      seen.add(s.subscriptionId);
      return true;
    })
    .sort((a, b) => a.slotIndex - b.slotIndex)
    .slice(0, MAX_SIMS)
    .map((s) => ({ ...s, name: s.name || `SIM ${s.slotIndex + 1}` }));
}

function readLocalSelected() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (_) {
    return null;
  }
}

function writeLocalSelected(id) {
  try { localStorage.setItem(STORAGE_KEY, String(id)); } catch (_) { /* noop */ }
}

export async function loadSims({ silent = false } = {}) {
  const res = await nativeBridge.getSims({ silent });
  return normalize(res && res.sims);
}

export async function loadSelectedSimId() {
  // 1) APK: SharedPreferences (переживает перезапуск WebView/приложения).
  const native = await nativeBridge.getSelectedSim();
  const nativeId = native && Number(native.subscriptionId);
  if (Number.isFinite(nativeId) && nativeId > 0) return nativeId;
  // 2) PWA и запасной путь: localStorage.
  return readLocalSelected();
}

export function saveSelectedSimId(id) {
  const n = Number(id);
  if (!Number.isFinite(n) || n <= 0) return;
  writeLocalSelected(n);
  // Нативное хранилище — не ждём: это только восстановление выбора в UI.
  nativeBridge.setSelectedSim(n).catch(() => {});
}

export async function subscribeSimsChanged(cb) {
  return nativeBridge.onSimsChanged((payload) => {
    cb(normalize(payload && payload.sims));
  });
}
