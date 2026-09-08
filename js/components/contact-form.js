// ============================================================================
// ФОРМА НОВОГО КОНТАКТА (bottom sheet)
// ----------------------------------------------------------------------------
// Замена window.prompt(): поле имени сразу в фокусе (системная клавиатура
// поднимается сама), каждое слово имени — с большой буквы (атрибут
// autocapitalize + JS-нормализация с сохранением каретки).
// Использует общие #scrim / #context-sheet, свой слой в back-stack.
// ============================================================================

import { pushLayer, popLayerSilently } from '../utils/back-stack.js';

const LAYER = 'contact-form';

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function capitalizeWords(value) {
  return value.replace(/(^|[\s\-–—])([a-zа-яё])/gi, (_, sep, ch) => sep + ch.toUpperCase());
}

export function initContactForm({ onSaved }) {
  const scrim = document.getElementById('scrim');
  const sheet = document.getElementById('context-sheet');
  let isOpen = false;

  function open({ name = '', number = '', numberEditable = false, title = 'Новый контакт' } = {}) {
    isOpen = true;
    sheet.innerHTML = `
      <div class="context-sheet__handle"></div>
      <div class="context-sheet__title">${escapeHtml(title)}</div>
      <label class="form-field">
        <span class="form-field__label">Имя</span>
        <input class="form-field__input" data-field="name" type="text" placeholder="Имя"
          autocomplete="off" autocapitalize="words" enterkeyhint="done" value="${escapeHtml(name)}">
      </label>
      <label class="form-field">
        <span class="form-field__label">Номер</span>
        <input class="form-field__input" data-field="number" type="tel" inputmode="tel"
          value="${escapeHtml(number)}" ${numberEditable ? '' : 'readonly'}>
      </label>
      <div class="sheet-actions">
        <button class="btn-ghost" data-action="cancel">Отмена</button>
        <button class="btn-primary" data-action="save">Сохранить</button>
      </div>
    `;
    const nameInput = sheet.querySelector('[data-field="name"]');
    const numberInput = sheet.querySelector('[data-field="number"]');

    nameInput.addEventListener('input', () => {
      const fixed = capitalizeWords(nameInput.value);
      if (fixed !== nameInput.value) {
        const s = nameInput.selectionStart;
        const e = nameInput.selectionEnd;
        nameInput.value = fixed;
        try {
          nameInput.setSelectionRange(s, e);
        } catch (_) {
          // noop
        }
      }
    });

    const save = () => {
      const n = nameInput.value.trim();
      const num = numberInput.value.trim();
      if (!n || !num) {
        (n ? numberInput : nameInput).focus();
        return;
      }
      const data = { name: n, number: num };
      close();
      onSaved?.(data);
    };

    sheet.querySelector('[data-action="save"]').addEventListener('click', save);
    sheet.querySelector('[data-action="cancel"]').addEventListener('click', () => close());
    nameInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') save();
    });

    scrim.classList.add('scrim--visible');
    sheet.classList.add('context-sheet--open');
    pushLayer(LAYER, () => close(true));
    // Курсор сразу в поле имени — системная клавиатура поднимается сама.
    try {
      nameInput.focus({ preventScroll: false });
    } catch (_) {
      try {
        nameInput.focus();
      } catch (_) {
        // noop
      }
    }
    requestAnimationFrame(() => {
      try {
        if (isOpen) nameInput.focus();
      } catch (_) {
        // noop
      }
    });
  }

  function close(viaGesture) {
    if (!isOpen) return;
    isOpen = false;
    sheet.classList.remove('context-sheet--open');
    scrim.classList.remove('scrim--visible');
    if (!viaGesture) popLayerSilently(LAYER);
  }

  scrim.addEventListener('click', () => close());

  return { open, close };
}
