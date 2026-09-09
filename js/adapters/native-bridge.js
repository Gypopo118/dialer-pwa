// ============================================================================
// НАТИВНЫЙ МОСТ (native bridge)
// ----------------------------------------------------------------------------
// Тонкая обёртка над Capacitor-плагином DialerTelecom (см. android/...).
// В браузере (обычная PWA) window.Capacitor отсутствует — все методы
// безопасно возвращают null/false, и адаптеры работают на моках.
// Импортов из '@capacitor/core' здесь нет специально: проект без сборщика,
// в WebView рантайм Capacitor уже инжектирован как window.Capacitor.
// ============================================================================

function getPlugin() {
  try {
    const cap = window.Capacitor;
    if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return null;
    if (cap.Plugins && cap.Plugins.DialerTelecom) return cap.Plugins.DialerTelecom;
    if (typeof cap.registerPlugin === 'function') return cap.registerPlugin('DialerTelecom');
    return null;
  } catch (_) {
    return null;
  }
}

let availCache = null;

async function ping() {
  if (availCache !== null) return availCache;
  try {
    const p = getPlugin();
    if (!p || typeof p.ping !== 'function') {
      availCache = false;
      return false;
    }
    await p.ping();
    availCache = true;
  } catch (_) {
    availCache = false;
  }
  return availCache;
}

export const nativeBridge = {
  async isAvailable() {
    return ping();
  },

  async isDefaultDialer() {
    const p = getPlugin();
    if (!p) return { isDefault: false };
    try {
      return await p.isDefaultDialer();
    } catch (_) {
      return { isDefault: false };
    }
  },

  async requestDefaultDialerRole() {
    const p = getPlugin();
    if (!p) return { isDefault: false };
    return p.requestDefaultDialerRole();
  },

  async placeCall(number) {
    return getPlugin().placeCall({ number });
  },

  async answerCall() {
    return getPlugin().answerCall();
  },

  async hangUpCall() {
    return getPlugin().hangUpCall();
  },

  async setSpeakerOn(on) {
    return getPlugin().setSpeakerOn({ on: !!on });
  },

  async setMicMuted(muted) {
    return getPlugin().setMicMuted({ muted: !!muted });
  },

  async getCurrentCall() {
    const p = getPlugin();
    if (!p) return null;
    try {
      return await p.getCurrentCall();
    } catch (_) {
      return null;
    }
  },

  async ensureNotifications() {
    const p = getPlugin();
    if (!p) return null;
    try {
      return await p.ensureNotifications();
    } catch (_) {
      return null;
    }
  },

  async playDtmfTone(tone) {
    const p = getPlugin();
    if (!p) return null;
    try {
      return await p.playDtmfTone({ tone: String(tone) });
    } catch (_) {
      return null;
    }
  },

  async openContactEditor({ name = '', number = '' } = {}) {
    const p = getPlugin();
    if (!p) return null;
    try {
      return await p.openContactEditor({ name, number });
    } catch (_) {
      return null;
    }
  },

  async openContactEditorForEdit({ contactId = '' } = {}) {
    const p = getPlugin();
    if (!p) return null;
    try {
      return await p.openContactEditorForEdit({ contactId: String(contactId) });
    } catch (_) {
      return null;
    }
  },

  async getContacts() {
    const p = getPlugin();
    if (!p) return null;
    try {
      return await p.getContacts();
    } catch (_) {
      return null;
    }
  },

  async getCallLog(limit = 200) {
    const p = getPlugin();
    if (!p) return null;
    try {
      return await p.getCallLog({ limit });
    } catch (_) {
      return null;
    }
  },

  // Подписка на события звонков из InCallService.
  // Возвращает async-функцию отписки.
  async onTelecomEvent(cb) {
    const p = getPlugin();
    if (!p || typeof p.addListener !== 'function') return () => {};
    try {
      const handle = await p.addListener('telecomEvent', cb);
      return () => {
        try {
          handle.remove();
        } catch (_) { /* noop */ }
      };
    } catch (_) {
      return () => {};
    }
  },
};
