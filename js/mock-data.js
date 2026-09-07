// Демонстрационные данные. Используются только пока не подключены реальные
// адаптеры (см. js/adapters/*). Удаляются/заменяются автоматически, когда
// syncFromDevice() в contacts-adapter.js начнёт читать реальные контакты.

export const mockContacts = [
  { id: 'c1', name: 'Марина Волкова', numbers: ['+373 777 12-34-56'], photoUrl: null, source: 'google' },
  { id: 'c2', name: 'Игорь Петренко', numbers: ['+373 555 98-76-54'], photoUrl: null, source: 'google' },
  { id: 'c3', name: 'Сервисный центр «Хайтек»', numbers: ['+373 533 4-40-40'], photoUrl: null, source: 'google' },
  { id: 'c4', name: 'Дарья Ковалёва', numbers: ['+373 777 22-11-09'], photoUrl: null, source: 'local' },
  { id: 'c5', name: 'Отдел кадров', numbers: ['+373 533 7-77-01'], photoUrl: null, source: 'google' },
];

const now = Date.now();
const h = 3600 * 1000;
const d = 24 * h;

export const mockCallLog = [
  { id: 'l1', number: '+373 777 12-34-56', type: 'outgoing', durationSec: 184, timestamp: new Date(now - 25 * 60 * 1000) },
  { id: 'l2', number: '+373 777 12-34-56', type: 'incoming', durationSec: 96, timestamp: new Date(now - 1 * d) },
  { id: 'l3', number: '+373 60 111 22 33', type: 'missed', durationSec: 0, timestamp: new Date(now - 2 * h) },
  { id: 'l4', number: '+373 555 98-76-54', type: 'incoming', durationSec: 431, timestamp: new Date(now - 4 * h) },
  { id: 'l5', number: '+373 555 98-76-54', type: 'outgoing', durationSec: 58, timestamp: new Date(now - 1 * d - 3 * h) },
  { id: 'l6', number: '+373 533 4-40-40', type: 'outgoing', durationSec: 212, timestamp: new Date(now - 2 * d) },
  { id: 'l7', number: '+373 69 900 12 34', type: 'missed', durationSec: 0, timestamp: new Date(now - 3 * d) },
  { id: 'l8', number: '+373 777 22-11-09', type: 'incoming', durationSec: 15, timestamp: new Date(now - 3 * d - 5 * h) },
  { id: 'l9', number: '+373 533 7-77-01', type: 'outgoing', durationSec: 340, timestamp: new Date(now - 5 * d) },
];
