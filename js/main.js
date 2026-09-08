import { initHomeScreen } from './screens/home-screen.js';
import { initContactHistoryScreen } from './screens/contact-history-screen.js';
import { initCallScreen } from './screens/call-screen.js';
import { initContextMenu } from './components/context-menu.js';
import { contactsAdapter } from './adapters/contacts-adapter.js';
import { nativeBridge } from './adapters/native-bridge.js';
import { initNativeTelephony } from './adapters/telephony-adapter.js';
import { initContactForm } from './components/contact-form.js';
import { initNativeBackButton } from './utils/back-stack.js';
import { uiStore } from './store.js';

// История в браузере используется как стек "назад" (см. utils/back-stack.js).
// Кладём базовый уровень, чтобы popstate всегда было от чего отталкиваться.
history.replaceState({ dialerLayer: 'root', depth: 0 }, '');

const contactHistoryScreen = initContactHistoryScreen({
  onClosed: () => {},
  onContactChanged: () => home.refreshRecents(),
});

// Форма нового контакта вместо window.prompt(): поле имени сразу в фокусе.
const contactForm = initContactForm({
  onSaved: async ({ name, number }) => {
    await contactsAdapter.create({ name, number });
    home.refreshRecents();
    contactHistoryScreen.refresh();
  },
});

const contextMenu = initContextMenu({
  onOpenHistory: (row) => contactHistoryScreen.open(row),
  onOpenAddContact: (row) => {
    contactForm.open({ name: '', number: row.number, numberEditable: false, title: 'Новый контакт' });
  },
  onOpenEditContact: (row) => contactHistoryScreen.open(row),
  onChanged: () => home.refreshRecents(),
});

const home = initHomeScreen({ contextMenu });
initCallScreen();

window.addEventListener('dialer:add-contact-blank', (e) => {
  contactForm.open({
    name: '',
    number: (e.detail && e.detail.number) || uiStore.get().dialInput || '',
    numberEditable: true,
    title: 'Новый контакт',
  });
});

// ===== Первый запуск: нативный режим (APK) или моки (PWA) =====
// В APK: подписываемся на события Telecom, импортируем контакты устройства
// и просим назначить приложение диалером по умолчанию (системный диалог).
(async function onFirstLaunch() {
  try {
    const native = await initNativeTelephony();
    if (native) {
      await contactsAdapter.syncFromDevice();
      home.refreshRecents();
      // Просим роль при каждом запуске, пока не назначены: без неё
      // Android не отдаёт звонки нашему InCallService и показывает чужой UI.
      try {
        const st = await nativeBridge.isDefaultDialer();
        if (!st.isDefault) await nativeBridge.requestDefaultDialerRole();
      } catch (_) { /* пользователь отказался — спросим при следующем запуске */ }
      return;
    }
  } catch (e) {
    console.warn('[dialer] native init failed, fallback to mocks:', e);
  }
  // Браузерный PWA: моки (прежнее поведение).
  const FLAG = 'dialer.firstLaunchDone';
  if (localStorage.getItem(FLAG)) return;
  localStorage.setItem(FLAG, '1');
  await contactsAdapter.syncFromDevice();
})();

// ===== Системная кнопка «назад» в APK: предыдущий экран, а не выход =====
initNativeBackButton();

// ===== Service worker для офлайн-работы PWA =====
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}
