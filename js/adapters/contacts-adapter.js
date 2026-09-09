// ============================================================================
// АДАПТЕР КОНТАКТОВ
// ----------------------------------------------------------------------------
// В браузере PWA НЕ имеет доступа к контактам Android/Google — это ограничение
// платформы, а не текущей реализации. Ниже — mock-реализация с тем же
// интерфейсом, который должен предоставить нативный слой после сборки в APK.
//
// ПРИ ПЕРЕХОДЕ НА CAPACITOR / НАТИВНЫЙ APK, замените тело методов на вызовы:
//   - @capacitor-community/contacts (getContacts, createContact, updateContact)
//     или собственный нативный плагин поверх Android ContactsContract /
//     Google People API (для аватаров, синхронизированных с Google-аккаунтом).
//   - Для автоматического импорта после установки: вызвать syncFromDevice()
//     в момент первого запуска (см. main.js -> onFirstLaunch), запросив
//     разрешение READ_CONTACTS / WRITE_CONTACTS.
//   - Аватар контакта: Google People API отдаёт photoUrl, если он есть у
//     пользователя в Google-аккаунте; ContactsContract.Contacts.PHOTO_URI —
//     локальный fallback.
// ============================================================================

import { mockContacts } from '../mock-data.js';
import { nativeBridge } from './native-bridge.js';
import { normalizeNumber, normalizeText, numbersEqual } from '../utils/format.js';

const STORAGE_KEY = 'dialer.contacts.v1';

function loadStore() {
  let initial = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) initial = JSON.parse(raw);
  } catch (e) { /* игнорируем повреждённое хранилище */ }
  if (!initial) {
    const seeded = mockContacts.map((c) => ({ ...c }));
    saveStore(seeded);
    return seeded;
  }
  // Разовая чистка старых дублей: один номер — один контакт, первый выигрывает.
  const seen = [];
  const clean = [];
  let changed = false;
  for (const c of initial) {
    const nums = (c.numbers || []).map((n) => (n || '').replace(/[^\d+]/g, '')).filter(Boolean);
    if (nums.length && nums.every((n) => seen.some((k) => numbersEqual(k, n)))) {
      changed = true;
      continue;
    }
    nums.forEach((n) => {
      if (!seen.some((k) => numbersEqual(k, n))) seen.push(n);
    });
    clean.push(c);
  }
  if (changed) saveStore(clean);
  return clean;
}

function saveStore(list) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

let contacts = loadStore();

// Кэш провайдера: чтение контактов — самая тяжёлая операция (нативный
// IPC + обход провайдера), поэтому при быстром наборе берём из памяти.
// Сбрасывается при resume и после правок в системном редакторе.
let sysKnown = false;
let sysCache = null;

async function systemContacts() {
  if (sysKnown) return sysCache;
  sysKnown = true;
  let list = null;
  try {
    const sys = await nativeBridge.getContacts();
    if (sys && Array.isArray(sys.contacts)) list = sys.contacts;
  } catch (_) {
    list = null;
  }
  sysCache = list;
  return sysCache;
}

export const contactsAdapter = {
  // В APK — контакты устройства (включая синхронизированные Google).
  // В браузере — локальные моки.
  async getAll() {
    const raw = await systemContacts();
    if (raw) {
      // Один человек — одна строка: все номера одного CONTACT_ID склеиваем.
      const byId = new Map();
      for (const c of raw) {
        if (!c.number) continue;
        const key = c.id || ('noid:' + c.number);
        let entry = byId.get(key);
        if (!entry) {
          entry = { id: c.id, name: null, numbers: [], photoUrl: null };
          byId.set(key, entry);
        }
        if (!entry.numbers.includes(c.number)) entry.numbers.push(c.number);
        if (c.name && !entry.name) entry.name = c.name;
        if (!entry.photoUrl && c.photoUri) entry.photoUrl = c.photoUri;
      }
      const sysList = [...byId.values()].map((e) => ({
        id: e.id || ('device-noid-' + e.numbers[0]),
        name: e.name || e.numbers[0],
        numbers: e.numbers,
        photoUrl: e.photoUrl,
        source: 'device',
      }));
      // Плюс локальные контакты приложения, которых нет в системе.
      const sysNums = new Set();
      sysList.forEach((c) => (c.numbers || []).forEach((n) => sysNums.add(normalizeNumber(n || ''))));
      const localOnly = contacts.filter(
        (c) => !((c.numbers || []).some((n) => sysNums.has(normalizeNumber(n || ''))))
      );
      return [...sysList, ...localOnly.map((c) => ({ ...c, numbers: [...(c.numbers || [])] }))];
    }
    return contacts.map((c) => ({ ...c }));
  },

  // Сброс кэша провайдера: вызывать при resume и после правок
  // в системном редакторе, чтобы подхватить свежие данные.
  async refreshCache() {
    sysKnown = false;
    sysCache = null;
  },

  async findByNumber(number) {
    const all = await this.getAll();
    return all.find((c) => (c.numbers || []).some((n) => numbersEqual(n, number))) || null;
  },

  async search(query) {
    const q = normalizeText(query);
    if (!q) return [];
    const nq = q.replace(/[^\d+]/g, '');
    const all = await this.getAll();
    return all.filter((c) =>
      normalizeText(c.name).includes(q) ||
      (nq && (c.numbers || []).some((n) => (n || '').replace(/[^\d+]/g, '').includes(nq)))
    );
  },

  // TODO(native): при сборке в APK — записывать сразу и в Google-аккаунт
  // пользователя через People API (contacts.people.createContact),
  // чтобы новый контакт синхронизировался, как того требует ТЗ.
  async create({ name, number, photoUrl = null }) {
    const contact = {
      id: `local-${Date.now()}`,
      name,
      numbers: [number],
      photoUrl,
      source: 'local', // после нативной интеграции: 'google'
    };
    contacts.push(contact);
    saveStore(contacts);
    return contact;
  },

  async update(id, patch) {
    const idx = contacts.findIndex((c) => c.id === id);
    if (idx === -1) return null;
    contacts[idx] = { ...contacts[idx], ...patch };
    saveStore(contacts);
    return contacts[idx];
  },

  async remove(id) {
    contacts = contacts.filter((c) => c.id !== id);
    saveStore(contacts);
  },

  // В APK импортирует контакты устройства в локальный стор (смёржить по номеру).
  // Прямая запись в Google-аккаунт — следующий шаг (People API + OAuth).
  async syncFromDevice() {
    const sys = await nativeBridge.getContacts();
    if (!sys || !Array.isArray(sys.contacts)) {
      console.info('[contactsAdapter] syncFromDevice: нативного слоя нет, пропуск.');
      return { imported: 0 };
    }
    const known = [];
    contacts.forEach((c) => (c.numbers || []).forEach((n) => {
      const norm = (n || '').replace(/[^\d+]/g, '');
      if (norm && !known.some((k) => numbersEqual(k, norm))) known.push(norm);
    }));
    let imported = 0;
    for (const dc of sys.contacts) {
      if (!dc.number) continue;
      const norm = (dc.number || '').replace(/[^\d+]/g, '');
      if (!norm || known.some((k) => numbersEqual(k, norm))) continue;
      known.push(norm);
      contacts.push({
        id: dc.id || `device-${Date.now()}-${imported}`,
        name: dc.name || dc.number,
        numbers: [dc.number],
        photoUrl: dc.photoUri || null,
        source: 'device',
      });
      imported++;
    }
    saveStore(contacts);
    return { imported };
  },
};
