// ============================================================================
// ЭКРАН «КОНТАКТЫ»
// ----------------------------------------------------------------------------
// Раздел контактов: устройство (в APK — включая синхронизированные Google
// через ContactsContract) либо моки в браузере. Поиск по имени/номеру,
// звонок кнопкой, тап — карточка контакта с историей.
// Строка contactRowTemplate переиспользуется главным экраном для совпадений
// при поиске и живом фильтре набора.
// ============================================================================

import { icons } from '../utils/icons.js';
import { contactsAdapter } from '../adapters/contacts-adapter.js';
import { telephonyAdapter } from '../adapters/telephony-adapter.js';
import { blockedStore } from '../blocked-store.js';
import { formatPhoneForDisplay, initialsFromName } from '../utils/format.js';
import { pushLayer, popLayerSilently } from '../utils/back-stack.js';

const LAYER = 'contact-list';

function escapeAttr(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function contactRowTemplate(c) {
  const number = (c.numbers && c.numbers[0]) || '';
  return `
    <div class="recent-row" data-contact="${c.id}">
      <div class="avatar">${initialsFromName(c.name || '?')}</div>
      <div class="recent-main">
        <div class="recent-line1">
          <span class="recent-name">${c.name || formatPhoneForDisplay(number)}</span>
        </div>
        <div class="recent-sub">
          ${blockedStore.isBlocked(number) ? `<span class="blocked-badge" title="Заблокированный контакт">${icons.block}</span>` : ''}
          <span>${formatPhoneForDisplay(number)}</span>
        </div>
      </div>
      <div class="recent-meta">
        <button class="recent-call-btn" data-call aria-label="Позвонить">${icons.phone}</button>
      </div>
    </div>
  `;
}

export function initContactListScreen({ onOpenContact }) {
  const screen = document.getElementById('screen-contacts');
  let seq = 0;

  async function open() {
    screen.hidden = false;
    screen.classList.add('screen--enter-right');
    requestAnimationFrame(() => screen.classList.remove('screen--enter-right'));
    pushLayer(LAYER, () => close(true));
    await render('', false);
  }

  function close(viaGesture) {
    if (screen.hidden) return;
    screen.hidden = true;
    if (!viaGesture) popLayerSilently(LAYER);
  }

  async function render(query, keepFocus) {
    const my = ++seq;
    let list = [];
    try {
      list = query ? await contactsAdapter.search(query) : await contactsAdapter.getAll();
    } catch (_) {
      list = [];
    }
    if (my !== seq || screen.hidden) return;
    screen.innerHTML = `
      <div class="contacts-screen">
        <div class="contacts-header">
          <button class="icon-btn" data-action="back" aria-label="Назад">${icons.chevronLeft}</button>
          <span class="contacts-title">Контакты</span>
          <span class="contacts-count">${list.length}</span>
        </div>
        <div class="contacts-search">
          <span class="contacts-search__icon">${icons.search}</span>
          <input data-field="search" type="text" placeholder="Поиск контактов"
            autocomplete="off" value="${escapeAttr(query)}">
        </div>
        <div class="contacts-list">
          ${list.length ? list.map(contactRowTemplate).join('') : `<div class="recents-empty">Контакты не найдены</div>`}
        </div>
      </div>
    `;
    const searchInput = screen.querySelector('[data-field="search"]');
    searchInput.addEventListener('input', () => render(searchInput.value, true));
    if (keepFocus) {
      searchInput.focus();
      try {
        searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
      } catch (_) {
        // noop
      }
    }
    screen.querySelector('[data-action="back"]').addEventListener('click', () => close());
    screen.querySelectorAll('[data-contact]').forEach((el) => {
      const c = list.find((x) => String(x.id) === el.dataset.contact);
      if (!c) return;
      const number = (c.numbers && c.numbers[0]) || '';
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-call]')) return;
        onOpenContact?.({ number, contact: c });
      });
      el.querySelector('[data-call]')?.addEventListener('click', () => {
        telephonyAdapter.call(number, c);
      });
    });
  }

  return { open, close };
}
