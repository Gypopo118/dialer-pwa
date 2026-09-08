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
import { normalizeNumber, normalizeText } from '../utils/format.js';

const STORAGE_KEY = 'dialer.contacts.v1';

function loadStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* игнорируем повреждённое хранилище */ }
  const seeded = mockContacts.map((c) => ({ ...c }));
  saveStore(seeded);
  return seeded;
}

function saveStore(list) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

let contacts = loadStore();

export const contactsAdapter = {
  // В APK — контакты устройства (включая синхронизированные Google).
  // В браузере — локальные моки.
  async getAll() {
    const sys = await nativeBridge.getContacts();
    if (sys && Array.isArray(sys.contacts)) {
      const sysList = sys.contacts
        .filter((c) => c.number)
        .map((c) => ({
          id: c.id,
          name: c.name || c.number,
          numbers: [c.number],
          photoUrl: c.photoUri || null,
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

  async findByNumber(number) {
    const norm = number.replace(/[^\d+]/g, '');
    const all = await this.getAll();
    return all.find((c) => (c.numbers || []).some((n) => (n || '').replace(/[^\d+]/g, '') === norm)) || null;
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
    const known = new Set();
    contacts.forEach((c) => (c.numbers || []).forEach((n) => known.add((n || '').replace(/[^\d+]/g, ''))));
    let imported = 0;
    for (const dc of sys.contacts) {
      if (!dc.number) continue;
      const norm = (dc.number || '').replace(/[^\d+]/g, '');
      if (!norm || known.has(norm)) continue;
      known.add(norm);
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
