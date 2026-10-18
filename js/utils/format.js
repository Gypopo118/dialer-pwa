// Форматирование телефонов, времени и длительности звонков.

export function formatPhoneForDisplay(number) {
  const digits = number.replace(/[^\d+]/g, '');
  const m = digits.match(/^(\+?\d{1,3})(\d{3})(\d{3})(\d{2})(\d{2})$/);
  if (m) return `${m[1]} ${m[2]} ${m[3]}-${m[4]}-${m[5]}`;
  return number;
}

export function formatDuration(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatClockTime(date) {
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

export function formatRelativeTime(date) {
  const m = formatRecentMeta(date);
  return m.top === m.bottom ? m.top : `${m.top}, ${m.bottom}`;
}

// Двухстрочная метка для плашек истории: сверху день («Сегодня»,
// «Вчера» или полная дата ДД.ММ.ГГ), снизу время звонка. Время видно всегда,
// а не только за сегодняшний день. День недели не используем: «Четверг»
// не отвечает, какая именно это была неделя.
export function formatRecentMeta(date) {
  const d = date instanceof Date ? date : new Date(date);
  const time = formatClockTime(d);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return { top: 'Сегодня', bottom: time };
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return { top: 'Вчера', bottom: time };
  return {
    top: d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' }),
    bottom: time,
  };
}

// Чистка номера: скобки, пробелы, дефисы и прочий мусор убираются,
// остаётся опциональный ведущий «+» и цифры. Один путь для вставки
// из буфера и для вызова — tel: URI со скобками/пробелами ненадёжен.
export function sanitizePhoneNumber(raw) {
  const s = String(raw ?? '');
  if (!s.trim()) return '';
  const digits = s.replace(/\D/g, '');
  if (!digits) return '';
  const plusIdx = s.indexOf('+');
  const firstDigitIdx = s.search(/\d/);
  const keepPlus = plusIdx !== -1 && (firstDigitIdx === -1 || plusIdx < firstDigitIdx);
  return (keepPlus ? '+' : '') + digits;
}

export function formatDayLabel(date) {
  const now = new Date();
  const isSameDay = date.toDateString() === now.toDateString();
  if (isSameDay) return 'Сегодня';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Вчера';
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

export function initialsFromName(name) {
  if (!name) return '';
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]).join('').toUpperCase();
}

// Нормализация номера для группировки строк истории по одному собеседнику.
export function normalizeText(s) {
  // Для поиска по именам: регистр + ё/е (на клавиатурах часто без точек).
  return (s || '').toLowerCase().replace(/ё/g, 'е').trim();
}

export function normalizeNumber(number) {
  return number.replace(/[^\d+]/g, '');
}

// Ключ группировки строк истории: хвост из 8 цифр — один собеседник,
// тем же правилом, что и numbersEqual. Короткие сервисные номера
// (112 и т.п.) не схлопываются.
export function groupKeyForNumber(number) {
  const d = String(number || '').replace(/\D/g, '');
  return d.length >= 8 ? d.slice(-8) : d;
}

// Маскирование номера для диагностических логов: полный номер (PII) не пишем.
export function maskNumber(n) {
  const d = String(n || '').replace(/\D/g, '');
  return d.length <= 4 ? '•••' : '•••' + d.slice(-4);
}

// Ключ живого поиска при наборе: «0775», «775» и «+373775» — один номер.
// Значимые цифры без плюса и ведущих нулей; пустая строка = фильтр выкл.
export function dialSearchKey(s) {
  return String(s || '').replace(/[^\d]/g, '').replace(/^0+/, '');
}

// Сравнение номеров по хвосту цифр: оператор шлёт то в локальном формате
// (0533...), то в международном (+373...), а в контактах лежит один вариант.
export function numbersEqual(a, b, tail = 8) {
  const da = String(a || '').replace(/\D/g, '');
  const db = String(b || '').replace(/\D/g, '');
  if (!da || !db) return false;
  if (da === db) return true;
  if (da.length < tail || db.length < tail) return false;
  return da.slice(-tail) === db.slice(-tail);
}
