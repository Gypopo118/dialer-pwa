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
import { formatPhoneForDisplay } from '../utils/format.js';
import { avatarHtml, warmPhotoCache, swapCachedPhotos } from '../utils/photo-cache.js';
import { pushLayer, popLayerSilently, registerOverlay } from '../utils/back-stack.js';

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
  const avatar = avatarHtml({ name: c.name, photoUrl: c.photoUrl, contactId: c.id, fallbackHtml: icons.person });
  return `
    <div class="recent-row" data-contact="${c.id}">
      <div class="avatar">${avatar}</div>
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

export function initContactListScreen({ onOpenMenu }) {
  const screen = document.getElementById('screen-contacts');
  let seq = 0;

  async function open() {
    screen.hidden = false;
    screen.classList.add('screen--enter-right');
    requestAnimationFrame(() => screen.classList.remove('screen--enter-right'));
    pushLayer(LAYER, () => close(true));
    buildShell();
    await updateList('');
  }

  // Шелл (шапка + поле поиска) строится один раз за открытие: пересборка
  // фокусного инпута посреди IME-композиции даёт дубли букв и дрожание.
  function buildShell() {
    screen.innerHTML = `
      <div class="contacts-screen">
        <div class="contacts-header">
          <button class="icon-btn" data-action="back" aria-label="Назад">${icons.chevronLeft}</button>
          <span class="contacts-title">Контакты</span>
          <span class="contacts-count" data-count></span>
        </div>
        <div class="contacts-search">
          <span class="contacts-search__icon">${icons.search}</span>
          <input data-field="search" type="text" placeholder="Поиск контактов"
            autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
        </div>
        <div class="contacts-list"></div>
      </div>
    `;
    screen.querySelector('[data-action="back"]').addEventListener('click', () => close());
    const searchInput = screen.querySelector('[data-field="search"]');
    let inputTimer = null;
    searchInput.addEventListener('input', () => {
      if (inputTimer) clearTimeout(inputTimer);
      inputTimer = setTimeout(() => {
        inputTimer = null;
        if (screen.hidden) return;
        updateList(searchInput.value);
      }, 150);
    });
  }

  function close(viaGesture) {
    if (screen.hidden) return;
    screen.hidden = true;
    if (!viaGesture) popLayerSilently(LAYER);
  }

  async function updateList(query) {
    const my = ++seq;
    let list = [];
    try {
      list = query ? await contactsAdapter.search(query) : await contactsAdapter.getAll();
    } catch (_) {
      list = [];
    }
    if (my !== seq || screen.hidden) return;
    const box = screen.querySelector('.contacts-list');
    if (!box) return;
    const keepScroll = box.scrollTop;
    const count = screen.querySelector('[data-count]');
    if (count) count.textContent = String(list.length);
    box.innerHTML = list.length
      ? list.map(contactRowTemplate).join('')
      : `<div class="recents-empty">Контакты не найдены</div>`;
    box.scrollTop = keepScroll;
    box.querySelectorAll('[data-contact]').forEach((el) => {
      const c = list.find((x) => String(x.id) === el.dataset.contact);
      if (!c) return;
      const number = (c.numbers && c.numbers[0]) || '';
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-call]')) return;
        onOpenMenu?.({ number, contact: c });
      });
      el.querySelector('[data-call]')?.addEventListener('click', () => {
        telephonyAdapter.call(number, c);
      });
    });
    warmPhotoCache(list.filter((c) => c.photoUrl).map((c) => c.photoUrl));
    swapCachedPhotos(box);
  }

  registerOverlay({ isOpen: () => !screen.hidden, close: () => close(true) });

  return { open, close };
}
