// ============================================================================
// СТЕК "НАЗАД"
// ----------------------------------------------------------------------------
// Жест "назад" (свайп от края экрана) в установленном PWA/TWA на Android
// транслируется браузером в обычную навигацию history (событие popstate).
// Поэтому каждый "слой" интерфейса (клавиатура открыта, контекстное меню,
// экран истории контакта, экран звонка) при появлении делает
// history.pushState(...), а закрывается — по popstate, а не напрямую.
// Тогда системный свайп-назад закрывает слои по одному, и только когда
// стек пуст — сворачивает само приложение (стандартное поведение браузера/
// TWA, doesn't require extra code).
//
// ПРИ ПЕРЕХОДЕ НА CAPACITOR: дополнительно подписаться на CapacitorApp
// ('backButton') и вызывать popLayer() же самой функцией, чтобы аппаратная
// кнопка "назад" вела себя идентично жесту.
// ============================================================================

const stack = [];
let ignoreNextPopstate = false;

export function layerDepth() {
  return stack.length;
}

// Аппаратная кнопка «назад» в нативной оболочке (Capacitor): ведёт себя
// как жест — закрывает верхний слой через history. На корневом экране
// приложение не закрывается, а сворачивается.
export async function initNativeBackButton() {
  try {
    const cap = window.Capacitor;
    if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return false;
    const App = (cap.Plugins && cap.Plugins.App)
      || (typeof cap.registerPlugin === 'function' ? cap.registerPlugin('App') : null);
    if (!App || typeof App.addListener !== 'function') return false;
    await App.addListener('backButton', () => {
      if (layerDepth() > 0) {
        history.back();
      } else {
        try {
          App.minimizeApp();
        } catch (_) {
          // noop
        }
      }
    });
    return true;
  } catch (_) {
    return false;
  }
}

export function pushLayer(name, onPop) {
  stack.push({ name, onPop });
  history.pushState({ dialerLayer: name, depth: stack.length }, '');
}

export function popLayerSilently(name) {
  // Слой закрыли не жестом (например, кнопкой), а явным действием —
  // убираем его из стека и откатываем history на шаг, но не даём
  // popstate-обработчику запустить onPop повторно для того же слоя.
  const idx = [...stack].reverse().findIndex((l) => l.name === name);
  if (idx === -1) return;
  stack.splice(stack.length - 1 - idx, 1);
  ignoreNextPopstate = true;
  history.back();
}

window.addEventListener('popstate', () => {
  if (ignoreNextPopstate) {
    ignoreNextPopstate = false;
    return;
  }
  const layer = stack.pop();
  if (layer) layer.onPop();
});

// ===== Дополнительно: свайп от края экрана как явный триггер (для
// окружений, где системный жест не эмулирует popstate — например, при
// тестировании в десктоп-браузере). Работает поверх того же history.back().
const EDGE_ZONE = 24; // px от края экрана, где начинается распознавание
const SWIPE_THRESHOLD = 60;

let touchStartX = null;
let touchStartEdge = null;

window.addEventListener('touchstart', (e) => {
  const x = e.touches[0].clientX;
  if (x <= EDGE_ZONE) { touchStartX = x; touchStartEdge = 'left'; }
  else if (x >= window.innerWidth - EDGE_ZONE) { touchStartX = x; touchStartEdge = 'right'; }
  else { touchStartX = null; touchStartEdge = null; }
}, { passive: true });

window.addEventListener('touchend', (e) => {
  if (touchStartX === null) return;
  const endX = e.changedTouches[0].clientX;
  const delta = endX - touchStartX;
  const isBackSwipe = (touchStartEdge === 'left' && delta > SWIPE_THRESHOLD) ||
                       (touchStartEdge === 'right' && delta < -SWIPE_THRESHOLD);
  touchStartX = null;
  if (isBackSwipe) history.back();
}, { passive: true });
