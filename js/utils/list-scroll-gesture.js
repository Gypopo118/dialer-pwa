// Отслеживает вертикальный скролл/свайп по списку недавних звонков.
// Как только пользователь начинает прокручивать список (жест вверх/вниз),
// клавиатура автоматически скрывается — вызывается onAutoHide().
// Пока список стоит на месте (пользователь просто читает), клавиатуру не
// трогаем — так пользователь не будет терять клавиатуру при обычном тапе.

export function attachListScrollGesture(listEl, { onAutoHide }) {
  let startY = null;
  let triggered = false;

  listEl.addEventListener('touchstart', (e) => {
    startY = e.touches[0].clientY;
    triggered = false;
  }, { passive: true });

  listEl.addEventListener('touchmove', (e) => {
    if (triggered || startY === null) return;
    const dy = Math.abs(e.touches[0].clientY - startY);
    if (dy > 10) {
      triggered = true;
      onAutoHide();
    }
  }, { passive: true });

  // Скролл колёсиком/трекпадом (десктоп-тестирование) — тот же эффект.
  let wheelArmed = true;
  listEl.addEventListener('wheel', () => {
    if (!wheelArmed) return;
    wheelArmed = false;
    onAutoHide();
    setTimeout(() => { wheelArmed = true; }, 400);
  }, { passive: true });
}
