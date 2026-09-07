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
  // TODO(native): заменить на чтение из ContactsContract / People API.
  async getAll() {
    return contacts.map((c) => ({ ...c }));
  },

  async findByNumber(number) {
    const norm = number.replace(/[^\d+]/g, '');
    return contacts.find((c) => c.numbers.some((n) => n.replace(/[^\d+]/g, '') === norm)) || null;
  },

  async search(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return contacts.filter((c) =>
      c.name.toLowerCase().includes(q) ||
      c.numbers.some((n) => n.replace(/[^\d+]/g, '').includes(q.replace(/[^\d+]/g, '')))
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

  // TODO(native): вызывается при первом запуске приложения (после выдачи
  // разрешения READ_CONTACTS) либо вручную из настроек ("Импортировать
  // контакты Google"). Должен смёржить нативный список с локальным.
  async syncFromDevice() {
    console.info('[contactsAdapter] syncFromDevice: заглушка. ' +
      'В нативной сборке — запрос READ_CONTACTS и чтение через People API.');
    return { imported: 0 };
  },
};
