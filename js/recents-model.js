import { callLogAdapter } from './adapters/call-log-adapter.js';
import { contactsAdapter } from './adapters/contacts-adapter.js';
import { groupKeyForNumber, maskNumber, numbersEqual, normalizeText } from './utils/format.js';

// Возвращает по одной строке на номер (сгруппировано), отсортировано по
// времени последнего звонка. Каждая строка несёт: имя/номер контакта,
// счётчик всех звонков на этот номер, тип и время ПОСЛЕДНЕГО звонка.
export async function buildRecentsList() {
  const [entries, contacts] = await Promise.all([
    callLogAdapter.getEntries(),
    contactsAdapter.getAll(),
  ]);

  const groups = new Map();
  for (const entry of entries) {
    const key = groupKeyForNumber(entry.number);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  const rows = [];
  for (const [key, list] of groups) {
    list.sort((a, b) => b.timestamp - a.timestamp);
    const last = list[0];
    const contact = contacts.find((c) =>
      (c.numbers || []).some((n) => numbersEqual(n, last.number))
    );
    const lastCachedName = last.cachedName || null;
    if (localStorage.getItem('dialer.debugLookup') === '1') {
      const digits = String(last.number || '').replace(/\D/g, '');
      const path = contact ? 'tail' : (lastCachedName ? 'cached' : 'miss');
      console.info('[lookup]', maskNumber(last.number), 'len=' + digits.length, 'via=' + path);
    }
    rows.push({
      key,
      number: entry_number(list),
      contact: contact || null,
      lastCachedName,
      count: list.length,
      lastType: last.type,
      lastTimestamp: last.timestamp,
      lastDurationSec: last.durationSec,
      entries: list,
    });
  }

  rows.sort((a, b) => b.lastTimestamp - a.lastTimestamp);
  return rows;
}

function entry_number(list) {
  // Берём оригинальное написание номера из самой свежей записи.
  return list[0].number;
}

export function filterRecents(rows, query) {
  const q = normalizeText(query);
  if (!q) return rows;
  const qDigits = q.replace(/[^\d+]/g, '');
  return rows.filter((row) => {
    const name = normalizeText(row.contact?.name || '');
    const numberDigits = row.number.replace(/[^\d+]/g, '');
    return (name && name.includes(q)) || (qDigits && numberDigits.includes(qDigits));
  });
}
