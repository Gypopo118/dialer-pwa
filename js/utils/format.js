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
  const now = new Date();
  const isSameDay = date.toDateString() === now.toDateString();
  if (isSameDay) return formatClockTime(date);

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Вчера';

  const diffDays = Math.floor((now - date) / 86400000);
  if (diffDays < 7) {
    return date.toLocaleDateString('ru-RU', { weekday: 'short' });
  }
  return date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
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
