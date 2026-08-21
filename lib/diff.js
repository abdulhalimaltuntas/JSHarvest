// lib/diff.js
// Iki yakalama arasindaki farki hesaplar. Saf fonksiyon.
//
// Kullanim: bir sayfanin "onceki" snapshot'i ile "simdiki" listesini
// karsilastirip eklenen / kaldirilan / degisen script'leri bulur. Hem gelistirme
// (deploy oncesi/sonrasi) hem recon (yeni endpoint izleme) icin degerli.

/** Kayitlari dedupe anahtarina gore haritalar. */
function indexByKey(entries) {
  const map = new Map();
  for (const entry of entries || []) {
    const key = entry.key || entry.normalizedUrl || entry.url;
    if (key) map.set(key, entry);
  }
  return map;
}

/**
 * @param {Array} previous  onceki yakalama kayitlari
 * @param {Array} current   simdiki yakalama kayitlari
 * @returns {{ added: Array, removed: Array, changed: Array, unchanged: number,
 *            summary: {added:number,removed:number,changed:number} }}
 */
export function diffCaptures(previous, current) {
  const prev = indexByKey(previous);
  const curr = indexByKey(current);

  const added = [];
  const removed = [];
  const changed = [];
  let unchanged = 0;

  for (const [key, entry] of curr) {
    if (!prev.has(key)) {
      added.push(entry);
      continue;
    }
    const before = prev.get(key);
    // "Degisti" sinyali: statu, boyut veya sourcemap durumu farkliysa.
    const statusChanged = (before.statusCode ?? null) !== (entry.statusCode ?? null);
    const sizeChanged = (before.size || 0) !== (entry.size || 0);
    const mapChanged = Boolean(before.hasSourceMap) !== Boolean(entry.hasSourceMap);
    if (statusChanged || sizeChanged || mapChanged) {
      changed.push({
        ...entry,
        prevStatus: before.statusCode ?? null,
        prevSize: before.size || 0
      });
    } else {
      unchanged++;
    }
  }

  for (const [key, entry] of prev) {
    if (!curr.has(key)) removed.push(entry);
  }

  return {
    added,
    removed,
    changed,
    unchanged,
    summary: { added: added.length, removed: removed.length, changed: changed.length }
  };
}
