import { icons } from '../utils/icons.js';
import { pushLayer, popLayerSilently, registerOverlay } from '../utils/back-stack.js';
import { contactsAdapter } from '../adapters/contacts-adapter.js';
import { callLogAdapter } from '../adapters/call-log-adapter.js';
import { blockedStore } from '../blocked-store.js';

const LAYER = 'context-menu';

export function initContextMenu({ onOpenHistory, onOpenAddContact, onOpenEditContact, onChanged }) {
  const scrim = document.getElementById('scrim');
  const sheet = document.getElementById('context-sheet');
  let currentRow = null;

  function close(viaGesture) {
    sheet.classList.remove('context-sheet--open');
    scrim.classList.remove('scrim--visible');
    if (!viaGesture) popLayerSilently(LAYER);
    currentRow = null;
  }

  function open(row) {
    currentRow = row;
    const isKnown = !!row.contact && row.contact.nameResolved !== false;
    const blocked = blockedStore.isBlocked(row.number);
    sheet.innerHTML = `
      <div class="context-sheet__handle"></div>
      <div class="context-sheet__title">${isKnown ? row.contact.name : row.number}</div>
      <button class="sheet-item" data-action="copy">${icons.copy}<span>Копировать номер</span></button>
      ${!isKnown ? `<button class="sheet-item" data-action="add">${icons.personAdd}<span>Добавить в контакты</span></button>` : ''}
      ${isKnown ? `<button class="sheet-item" data-action="edit">${icons.edit}<span>Изменить</span></button>` : ''}
      <button class="sheet-item ${blocked ? '' : 'sheet-item--danger'}" data-action="block">${icons.block}<span>${blocked ? 'Разблокировать' : 'Заблокировать'}</span></button>
      <button class="sheet-item" data-action="history">${icons.history}<span>История звонков</span></button>
    `;
    sheet.querySelectorAll('.sheet-item').forEach((btn) => {
      btn.addEventListener('click', () => handleAction(btn.dataset.action));
    });
    scrim.classList.add('scrim--visible');
    sheet.classList.add('context-sheet--open');
    pushLayer(LAYER, () => close(true));
  }

  async function handleAction(action) {
    const row = currentRow;
    if (!row) return;
    switch (action) {
      case 'copy':
        try { await navigator.clipboard.writeText(row.number); } catch (e) { /* без разрешения — молча игнорируем */ }
        close();
        break;
      case 'add':
        close();
        onOpenAddContact(row);
        break;
      case 'edit':
        close();
        onOpenEditContact(row);
        break;
      case 'block':
        // Локальный чёрный список: входящие с номера сразу отклоняются,
        // в истории остаются с бейджем. Повторный тап — разблокировать.
        if (blockedStore.isBlocked(row.number)) blockedStore.unblock(row.number);
        else blockedStore.block(row.number);
        close();
        onChanged?.();
        break;
      case 'history':
        // Атомарный переход «меню → история»: меню прячем БЕЗ history.back
        // (true = историю не трогать), а его слой заменяется слоем истории
        // внутри open() через replaceState. Старая схема (close с back
        // + тут же pushState) давала гонку: WebView оказывался на root-entry
        // и второй системный Back сворачивал приложение вместо возврата.
        close(true);
        onOpenHistory(row, { replaceLayer: LAYER });
        break;
    }
  }

  scrim.addEventListener('click', () => { if (currentRow) close(); });
  registerOverlay({ isOpen: () => !!currentRow, close: () => close(true) });

  return { open };
}
