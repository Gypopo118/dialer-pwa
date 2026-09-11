// ============================================================================
// КЭШ МИНИАТЮР КОНТАКТОВ + HTML АВАТАРА
// ----------------------------------------------------------------------------
// Фото лежат в провайдере устройства (content://, туда же синкается Google).
// Рендер никогда не ждёт кэш: сначала рисуется прямой URI поверх инициалов
// (битый img самоубивается через onerror), фоном URI складываются в Cache API
// и при повторных показах подменяются на blob-URL. Все ошибки молча игнорятся.
// ============================================================================

import { initialsFromName } from './format.js';

const CACHE_NAME = 'dialer-photos-v1';
const WARM_LIMIT = 60;

let cachePromise = null;

function cache() {
  if (!cachePromise) {
    cachePromise = (async () => {
      try {
        if (!('caches' in window)) return null;
        return await caches.open(CACHE_NAME);
      } catch (_) {
        return null;
      }
    })();
  }
  return cachePromise;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Слоёный аватар: снизу инициалы/силуэт, сверху фото. Нет фото или не
// загрузилось — остаётся нижний слой, дыр в UI не бывает.
export function avatarHtml({ name, photoUrl, contactId, fallbackHtml }) {
  const face = name ? esc(initialsFromName(name)) : fallbackHtml;
  if (!photoUrl) return face;
  const safe = esc(photoUrl);
  const cid = extractNumericId(contactId);
  const cidAttr = cid ? ` data-contact-id="${cid}"` : '';
  return (
    `<span class="avatar__face">${face}</span>` +
    `<img class="avatar__img" src="${safe}" data-photo-uri="${safe}"${cidAttr} alt="" loading="lazy" onerror="window.__dialerPhotoFallback&&window.__dialerPhotoFallback(this)">`
  );
}

function extractNumericId(id) {
  const m = /^device-(\d+)$/.exec(String(id || ''));
  return m ? m[1] : '';
}

// Запасной путь: прямой content:// не открылся в WebView — тянем байты
// через нативный мост (ContentResolver всегда может) и кэшируем в памяти.
const bridgePhotoCache = new Map();

async function photoFallback(img) {
  try {
    if (!img || img.dataset.fb) return;
    img.dataset.fb = '1';
    const cid = img.getAttribute('data-contact-id');
    if (!cid) {
      img.remove();
      return;
    }
    if (bridgePhotoCache.has(cid)) {
      const hit = bridgePhotoCache.get(cid);
      if (hit && img.isConnected) img.src = hit;
      else img.remove();
      return;
    }
    const { nativeBridge } = await import('../adapters/native-bridge.js');
    const res = await nativeBridge.getContactPhoto({ contactId: cid });
    if (res && res.photo && img.isConnected) {
      const url = 'data:image/jpeg;base64,' + res.photo;
      bridgePhotoCache.set(cid, url);
      img.src = url;
    } else {
      bridgePhotoCache.set(cid, null);
      img.remove();
    }
  } catch (_) {
    try {
      img.remove();
    } catch (_) {
      // noop
    }
  }
}

if (typeof window !== 'undefined') window.__dialerPhotoFallback = photoFallback;

export async function getCachedPhotoUrl(uri) {
  if (!uri) return null;
  try {
    const c = await cache();
    if (!c) return null;
    const res = await c.match(uri);
    if (!res) return null;
    const blob = await res.blob();
    if (!blob || !blob.size) return null;
    return URL.createObjectURL(blob);
  } catch (_) {
    return null;
  }
}

// Фоновая запись URI в кэш (не более лимита за раз).
export async function warmPhotoCache(uris) {
  try {
    const c = await cache();
    if (!c) return;
    const uniq = [...new Set((uris || []).filter(Boolean))].slice(0, WARM_LIMIT);
    for (const uri of uniq) {
      try {
        const hit = await c.match(uri);
        if (hit) continue;
        const res = await fetch(uri);
        if (res && res.ok) await c.put(uri, res.clone());
      } catch (_) {
        // один битый URI не валит остальные
      }
    }
  } catch (_) {
    // noop
  }
}

// Подмена прямых URI на закэшированные blob-URL у видимых img.
export function swapCachedPhotos(root) {
  if (!root || !root.querySelectorAll) return;
  root.querySelectorAll('img[data-photo-uri]').forEach((img) => {
    const uri = img.getAttribute('data-photo-uri');
    if (!uri || img.dataset.cached) return;
    getCachedPhotoUrl(uri).then((url) => {
      if (url && img.isConnected) {
        img.dataset.cached = '1';
        img.src = url;
      }
    });
  });
}
