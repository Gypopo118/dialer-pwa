import { initHomeScreen } from './screens/home-screen.js';
import { initContactListScreen } from './screens/contact-list-screen.js';
import { initContactHistoryScreen } from './screens/contact-history-screen.js';
import { initCallScreen } from './screens/call-screen.js';
import { initContextMenu } from './components/context-menu.js';
import { contactsAdapter } from './adapters/contacts-adapter.js';
import { nativeBridge } from './adapters/native-bridge.js';
import { initNativeTelephony, syncNativeCallState } from './adapters/telephony-adapter.js';
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

// Форма нового контакта — только запасной вариант для браузера (PWA).
// В APK открывается системный редактор (контакт сразу в Google/телефоне).
const contactForm = initContactForm({
  onSaved: async ({ name, number }) => {
    await contactsAdapter.create({ name, number });
    home.refreshRecents();
    contactHistoryScreen.refresh();
  },
});

// Создание контакта: в APK — системный редактор Android (сохранение
// в выбранный аккаунт, обычно Google), в браузере — локальная форма.
async function openAddContact({ name = '', number = '', numberEditable = false } = {}) {
  try {
    if (await nativeBridge.isAvailable()) {
      await nativeBridge.openContactEditor({ name, number });
      home.refreshRecents();
      contactHistoryScreen.refresh();
      return;
    }
  } catch (_) {
    // noop — падаем на локальную форму
  }
  contactForm.open({ name, number, numberEditable, title: 'Новый контакт' });
}

// Правка контакта: в APK — системный редактор Google по ID контакта
// (сохранение туда же, списки обновляются по возврату), в браузере —
// наша карточка с inline-правкой.
async function openEditContact(row) {
  const contact = row && row.contact;
  try {
    if (contact && await nativeBridge.isAvailable()) {
      const m = /^device-(\d+)$/.exec(contact.id || '');
      if (m) {
        await nativeBridge.openContactEditorForEdit({ contactId: m[1] });
        home.refreshRecents();
        contactHistoryScreen.refresh();
        return;
      }
    }
  } catch (_) {
    // noop — падаем на карточку
  }
  contactHistoryScreen.open(row);
}

const contextMenu = initContextMenu({
  onOpenHistory: (row) => contactHistoryScreen.open(row),
  onOpenAddContact: (row) => {
    openAddContact({ name: '', number: row.number, numberEditable: false });
  },
  onOpenEditContact: (row) => {
    openEditContact(row);
  },
  onChanged: () => home.refreshRecents(),
});

const home = initHomeScreen({
  contextMenu,
  onOpenContact: ({ number, contact }) => contactHistoryScreen.open({ number, contact }),
});
initCallScreen();

// Раздел контактов: кнопка на клавиатуре вместо «C».

const contactListScreen = initContactListScreen({
  onOpenContact: ({ number, contact }) => contactHistoryScreen.open({ number, contact }),
});
window.addEventListener('dialer:open-contacts', () => contactListScreen.open());

window.addEventListener('dialer:add-contact-blank', (e) => {
  openAddContact({
    name: '',
    number: (e.detail && e.detail.number) || uiStore.get().dialInput || '',
    numberEditable: true,
  });
});

// Возврат из системного редактора контактов: обновить списки.
// Это и есть «автоопрос» — свежие данные при каждом возврате в приложение.
(async function initResumeRefresh() {
  try {
    const cap = window.Capacitor;
    if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return;
    const App = (cap.Plugins && cap.Plugins.App)
      || (typeof cap.registerPlugin === 'function' ? cap.registerPlugin('App') : null);
    if (!App || typeof App.addListener !== 'function') return;
    await App.addListener('resume', () => {
      home.refreshRecents();
      contactHistoryScreen.refresh();
      // Возврат из уведомления о звонке: показать живой экран приёма/разговора.
      syncNativeCallState().catch(() => {});
    });
  } catch (_) {
    // noop
  }
})();

// ===== Первый запуск: нативный режим (APK) или моки (PWA) =====
// В APK: подписываемся на события Telecom, импортируем контакты устройства
// и просим назначить приложение диалером по умолчанию (системный диалог).
(async function onFirstLaunch() {
  try {
    const native = await initNativeTelephony();
    if (native) {
      await contactsAdapter.syncFromDevice();
      home.refreshRecents();
      // Уведомления о звонках (Android 13+): иначе входящий при свёрнутом
      // приложении нечем показать.
      try {
        await nativeBridge.ensureNotifications();
      } catch (_) { /* noop */ }
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
