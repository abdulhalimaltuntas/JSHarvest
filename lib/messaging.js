// lib/messaging.js
// Popup'a tek yonlu yayin yardimcisi. Popup kapaliyken runtime.sendMessage
// "Receiving end does not exist" hatasi verir; bu hata bilincli olarak yutulur.

import { api } from './browser-api.js';

export function broadcast(payload) {
  try {
    const result = api.runtime.sendMessage(payload);
    if (result && typeof result.catch === 'function') {
      result.catch(() => { /* dinleyici yok */ });
    }
  } catch {
    // Dinleyici yoksa senkron hata firlatilabilir.
  }
  // lastError okunmazsa konsol "Unchecked runtime.lastError" ile dolar.
  if (api.runtime.lastError) { /* bilincli olarak yutuluyor */ }
}
