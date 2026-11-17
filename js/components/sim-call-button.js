// ============================================================================
// УМНАЯ КНОПКА ВЫЗОВА (капсула) С ПЕРЕКЛЮЧЕНИЕМ SIM
// ----------------------------------------------------------------------------
// Одна SIM или ни одной — классическая зелёная кнопка с трубкой и без стрелок.
// Две SIM — карусель: текущая карта (трубка + имя оператора + стрелки),
// соседняя карта другого цвета выезжает при горизонтальном свайпе. Панели
// не смешиваются: между заливками чёткая вертикальная граница. Свайп
// блокирует клик, порог 27% ширины, на пороге — системный тактильный tick.
// ============================================================================

import { icons } from '../utils/icons.js';
import { nativeBridge } from '../adapters/native-bridge.js';
import {
  loadSims,
  loadSelectedSimId,
  saveSelectedSimId,
  subscribeSimsChanged,
} from '../adapters/sims-adapter.js';

const SWIPE_THRESHOLD_RATIO = 0.27; // 25–30% ширины капсулы
const TOUCH_SLOP = 8;               // «это уже свайп, а не тап»
const SNAP_MS = 240;
const HAPTIC_MS = 10;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function createSimCallButton({ button, onCall, isEnabled }) {
  let sims = [];
  let selectedId = null;
  let selectedIndex = 0;
  let dual = false;
  let viewport = null;
  let track = null;
  let panels = [];
  let width = 0;
  let drag = null;
  let settling = false;
  let suppressClick = false;
  let enabled = true;

  button.classList.add('call-btn--smart');
  button.removeAttribute('disabled');
  buildSingle();
  setEnabled(isEnabled ? isEnabled() : true);
  bindEvents();
  initSims();

  async function initSims() {
    try {
      const list = await loadSims();
      const stored = await loadSelectedSimId();
      applySims(list, stored);
    } catch (_) {
      // остаёмся в классическом режиме
    }
    try {
      await subscribeSimsChanged((next) => applySims(next, selectedId));
    } catch (_) {
      // реактивных обновлений не будет — не критично
    }
    try {
      await nativeBridge.onAppResume(() => {
        // Возврат из настроек: разрешение/SIM могли измениться. Тихо,
        // без повторного диалога разрешений.
        loadSims({ silent: true })
          .then((list) => applySims(list, selectedId))
          .catch(() => {});
      });
    } catch (_) {
      // noop
    }
  }

  function applySims(list, preferredId) {
    sims = Array.isArray(list) ? list : [];
    const preferred = Number(preferredId);
    const hit = sims.find((s) => s.subscriptionId === preferred);
    const nextId = hit ? hit.subscriptionId : (sims[0] ? sims[0].subscriptionId : null);
    const changed = nextId != null && nextId !== selectedId;
    selectedId = nextId;
    if (changed) saveSelectedSimId(nextId);
    render();
  }

  function currentSim() {
    return sims.find((s) => s.subscriptionId === selectedId) || sims[0] || null;
  }

  function render() {
    const nextDual = sims.length >= 2;
    if (nextDual !== dual) {
      dual = nextDual;
      if (dual) buildDual();
      else buildSingle();
    }
    if (!dual) {
      updateSingleAria();
      return;
    }
    const idx = sims.findIndex((s) => s.subscriptionId === selectedId);
    selectedIndex = idx >= 0 ? idx : 0;
    updatePanels();
    updateDualAria();
  }

  function buildSingle() {
    button.innerHTML = `<span class="call-btn__single">${icons.phone}</span>`;
    viewport = null;
    track = null;
    panels = [];
  }

  function buildDual() {
    button.innerHTML = `
      <span class="call-btn__viewport">
        <span class="call-btn__track">
          <span class="call-btn__panel"></span>
          <span class="call-btn__panel"></span>
          <span class="call-btn__panel"></span>
        </span>
      </span>`;
    viewport = button.querySelector('.call-btn__viewport');
    track = button.querySelector('.call-btn__track');
    panels = Array.from(track.children);
    requestAnimationFrame(resetTrack);
  }

  function updateSingleAria() {
    const sim = sims[0] || null;
    button.setAttribute('aria-label', sim ? `Позвонить с ${sim.name}` : 'Позвонить');
  }

  function updateDualAria() {
    const sim = currentSim();
    button.setAttribute('aria-label', sim
      ? `Позвонить с ${sim.name}. Смахните влево или вправо, чтобы сменить SIM.`
      : 'Позвонить');
  }

  function updatePanels() {
    if (!track || panels.length !== 3) return;
    const n = sims.length;
    const prev = sims[(selectedIndex - 1 + n) % n];
    const cur = sims[selectedIndex];
    const next = sims[(selectedIndex + 1) % n];
    setPanel(panels[0], prev);
    setPanel(panels[1], cur);
    setPanel(panels[2], next);
    resetTrack();
  }

  function setPanel(el, sim) {
    if (!el || !sim) return;
    const color = sim.slotIndex === 0 ? 'call-btn__panel--green' : 'call-btn__panel--orange';
    el.className = `call-btn__panel ${color}`;
    el.innerHTML =
      `<span class="call-btn__arrow">${icons.chevronLeft}</span>` +
      `<span class="call-btn__phone">${icons.phone}</span>` +
      `<span class="call-btn__name">${escapeHtml(sim.name)}</span>` +
      `<span class="call-btn__arrow">${icons.chevronRight}</span>`;
  }

  function resetTrack() {
    if (!track || !viewport) return;
    width = viewport.clientWidth || width;
    track.style.transition = 'none';
    track.style.transform = `translateX(${-width}px)`;
  }

  function bindEvents() {
    button.addEventListener('pointerdown', onPointerDown);
    button.addEventListener('pointermove', onPointerMove);
    button.addEventListener('pointerup', onPointerUp);
    button.addEventListener('pointercancel', onPointerCancel);
    button.addEventListener('click', onClick);
    window.addEventListener('resize', () => {
      if (!drag && !settling) resetTrack();
    });
  }

  function onPointerDown(e) {
    suppressClick = false;
    if (!dual || settling) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!e.isPrimary) return;
    width = viewport ? viewport.clientWidth : button.clientWidth;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, active: false, crossed: false };
    try { button.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.active) {
      if (Math.abs(dx) < TOUCH_SLOP && Math.abs(dy) < TOUCH_SLOP) return;
      if (Math.abs(dx) <= Math.abs(dy)) return; // вертикальный жест — не наш
      drag.active = true;
      track.style.transition = 'none';
      button.classList.add('call-btn--dragging');
    }
    if (e.cancelable) e.preventDefault();
    drag.dx = Math.max(-width, Math.min(width, dx));
    track.style.transform = `translateX(${(-width + drag.dx).toFixed(1)}px)`;
    const passed = Math.abs(drag.dx) >= width * SWIPE_THRESHOLD_RATIO;
    if (passed && !drag.crossed) {
      drag.crossed = true;
      hapticTick();
    } else if (!passed && drag.crossed) {
      drag.crossed = false;
    }
  }

  function onPointerUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (!d.active) return; // обычный тап: click придёт штатно
    suppressClick = true;
    button.classList.remove('call-btn--dragging');
    const passed = Math.abs(d.dx) >= width * SWIPE_THRESHOLD_RATIO;
    const dir = d.dx < 0 ? 1 : -1; // влево — следующая, вправо — предыдущая
    settling = true;
    track.style.transition = `transform ${SNAP_MS}ms cubic-bezier(.22,1,.36,1)`;
    track.style.transform = `translateX(${passed ? (dir > 0 ? -2 * width : 0) : -width}px)`;
    setTimeout(() => finishSnap(passed, dir), SNAP_MS + 30);
  }

  function onPointerCancel(e) {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    button.classList.remove('call-btn--dragging');
    if (!track) return;
    settling = true;
    track.style.transition = `transform ${SNAP_MS}ms cubic-bezier(.22,1,.36,1)`;
    track.style.transform = `translateX(${-width}px)`;
    setTimeout(() => {
      resetTrack();
      settling = false;
    }, SNAP_MS + 30);
  }

  function finishSnap(passed, dir) {
    if (passed && sims.length >= 2) {
      const n = sims.length;
      selectedIndex = (selectedIndex + dir + n) % n;
      selectedId = sims[selectedIndex].subscriptionId;
      saveSelectedSimId(selectedId);
      updatePanels();
      updateDualAria();
    } else {
      resetTrack();
    }
    settling = false;
  }

  function onClick(e) {
    if (suppressClick) {
      suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (!enabled) return;
    onCall(currentSim());
  }

  async function hapticTick() {
    try {
      const res = await nativeBridge.hapticTick();
      if (res && res.ok) return;
    } catch (_) { /* noop */ }
    try {
      if (navigator.vibrate) navigator.vibrate(HAPTIC_MS);
    } catch (_) { /* noop */ }
  }

  function setEnabled(on) {
    enabled = !!on;
    button.setAttribute('aria-disabled', enabled ? 'false' : 'true');
  }

  return { setEnabled };
}
