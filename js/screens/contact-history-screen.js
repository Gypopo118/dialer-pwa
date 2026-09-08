import { icons } from '../utils/icons.js';
import { callLogAdapter } from '../adapters/call-log-adapter.js';
import { contactsAdapter } from '../adapters/contacts-adapter.js';
import { telephonyAdapter } from '../adapters/telephony-adapter.js';
import { nativeBridge } from '../adapters/native-bridge.js';
import { blockedStore } from '../blocked-store.js';
import {
  formatPhoneForDisplay, formatDuration, formatClockTime, formatDayLabel, initialsFromName,
} from '../utils/format.js';
import { pushLayer, popLayerSilently } from '../utils/back-stack.js';

const LAYER = 'contact-history';

export function initContactHistoryScreen({ onClosed, onContactChanged }) {
  const screen = document.getElementById('screen-contact-history');
  let current = null; // { number, contact }

  async function open(row) {
    current = { number: row.number, contact: row.contact };
    screen.hidden = false;
    screen.classList.add('screen--enter-right');
    requestAnimationFrame(() => screen.classList.remove('screen--enter-right'));
    pushLayer(LAYER, () => close(true));
    await render();
  }

  function close(viaGesture) {
    if (screen.hidden) return;
    screen.hidden = true;
    current = null;
    if (!viaGesture) popLayerSilently(LAYER);
    onClosed?.();
  }

  async function render() {
    const { number, contact } = current;
    const entries = await callLogAdapter.getEntriesForNumber(number);
    const isKnown = !!contact;
    const blocked = blockedStore.isBlocked(number);
    // В APK правка идёт через системный редактор Google (пункт «Изменить»),
    // поэтому inline-правка в карточке отключена — иначе правился бы
    // невидимый локальный стор. В браузере оставляем как было.
    let native = false;
    try {
      native = await nativeBridge.isAvailable();
    } catch (_) {
      native = false;
    }
    const inlineEditable = isKnown && !native;

    screen.innerHTML = `
      <div class="contact-history">
        <div class="contact-header">
          <div class="contact-header__top">
            <button class="icon-btn" data-action="back">${icons.chevronLeft}</button>
          </div>
          <div class="contact-header__avatar">${isKnown ? initialsFromName(contact.name) : icons.person}</div>
          <div class="contact-header__name" data-field="name" ${inlineEditable ? 'contenteditable="true"' : ''}>${isKnown ? contact.name : formatPhoneForDisplay(number)}</div>
          ${isKnown ? `<div class="contact-header__number" data-field="number" ${inlineEditable ? 'contenteditable="true"' : ''}>${formatPhoneForDisplay(number)}</div>` : ''}
          <div class="contact-header__actions">
            <button class="contact-action" data-action="call">
              <span class="circle circle--call">${icons.phone}</span>
              <span>Позвонить</span>
            </button>
            ${isKnown ? `
              <button class="contact-action" data-action="block">
                <span class="circle">${icons.block}</span>
                <span>${blocked ? 'Разблок' : 'Блок'}</span>
              </button>
            ` : `
              <button class="contact-action" data-action="add-remove">
                <span class="circle">${icons.personAdd}</span>
                <span>В контакты</span>
              </button>
            `}
          </div>
        </div>
        <div class="history-list">
          ${renderEntries(entries, blocked)}
        </div>
      </div>
    `;

    screen.querySelector('[data-action="back"]').addEventListener('click', () => close());
    screen.querySelector('[data-action="call"]').addEventListener('click', () => {
      telephonyAdapter.call(number, contact);
    });
    screen.querySelector('[data-action="add-remove"]')?.addEventListener('click', () => {
      if (!isKnown) {
        window.dispatchEvent(new CustomEvent('dialer:add-contact-blank', { detail: { number } }));
      }
    });
    screen.querySelector('[data-action="block"]')?.addEventListener('click', () => {
      if (blockedStore.isBlocked(number)) blockedStore.unblock(number);
      else blockedStore.block(number);
      onContactChanged?.();
      render();
    });

    const nameField = screen.querySelector('[data-field="name"]');
    nameField?.addEventListener('blur', async () => {
      const newName = nameField.textContent.trim();
      if (contact && newName && newName !== contact.name) {
        await contactsAdapter.update(contact.id, { name: newName });
        current.contact = { ...contact, name: newName };
        onContactChanged?.();
      }
    });

    const numberField = screen.querySelector('[data-field="number"]');
    numberField?.addEventListener('blur', async () => {
      const newNumber = numberField.textContent.trim();
      if (contact && newNumber && newNumber !== formatPhoneForDisplay(number)) {
        await contactsAdapter.update(contact.id, { numbers: [newNumber] });
        onContactChanged?.();
      }
    });
  }

  function renderEntries(entries, blocked) {
    if (!entries.length) {
      return `<div class="recents-empty">Звонков с этим номером ещё не было</div>`;
    }
    let html = '';
    let lastDay = null;
    for (const e of entries) {
      const dayLabel = formatDayLabel(e.timestamp);
      if (dayLabel !== lastDay) {
        html += `<div class="history-day-label">${dayLabel}</div>`;
        lastDay = dayLabel;
      }
      const arrow = e.type === 'outgoing' ? icons.arrowOut : e.type === 'incoming' ? icons.arrowIn : icons.arrowMissed;
      const colorClass = `call-arrow--${e.type === 'missed' ? 'missed' : e.type === 'incoming' ? 'in' : 'out'}`;
      const typeLabel = { outgoing: 'Исходящий', incoming: 'Входящий', missed: 'Пропущенный' }[e.type];
      html += `
        <div class="history-item">
          <span class="call-arrow ${colorClass}">${arrow}</span>
          <div class="history-item__meta">
            <span class="history-item__type">${typeLabel}${blocked ? ` <span class="blocked-badge" title="Заблокированный контакт">${icons.block}</span>` : ''}</span>
            <span class="history-item__time">${formatClockTime(e.timestamp)}</span>
          </div>
          <span class="history-item__duration">${e.durationSec > 0 ? formatDuration(e.durationSec) : ''}</span>
        </div>
      `;
    }
    return html;
  }

  return { open, close, refresh };

  async function refresh() {
    if (!current || screen.hidden) return;
    try {
      current.contact = await contactsAdapter.findByNumber(current.number);
    } catch (_) {
      // noop
    }
    await render();
  }
}
