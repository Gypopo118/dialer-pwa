import { callLogAdapter } from './adapters/call-log-adapter.js';
import { contactsAdapter } from './adapters/contacts-adapter.js';
import { normalizeNumber, normalizeText } from './utils/format.js';

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
    const key = normalizeNumber(entry.number);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  const rows = [];
  for (const [key, list] of groups) {
    list.sort((a, b) => b.timestamp - a.timestamp);
    const last = list[0];
    const contact = contacts.find((c) =>
      c.numbers.some((n) => normalizeNumber(n) === key)
    );
    rows.push({
      key,
      number: entry_number(list),
      contact: contact || null,
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
