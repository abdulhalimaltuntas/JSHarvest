// lib/sourcemap.js
// Source map (.map) ayrıştırma. Saf fonksiyonlar; ağ islemi cagiran tarafta.
//
// Bir .map dosyasi JSON'dur ve sunlari icerir:
//   - version, file, sourceRoot
//   - sources[]        : orijinal kaynak dosya yollari (recon icin altin)
//   - sourcesContent[] : (opsiyonel) orijinal kaynak icerigi
//   - mappings         : (bizi ilgilendirmiyor)
//
// Amac: sources[] listesini okunur, mutlak-benzeri yollara cevirip dosya
// agacini ortaya cikarmak. `webpack://`, `webpack-internal://` gibi sema
// on-eklerini temizleriz.

/** webpack:// vb. on-ekleri ve gurultuyu temizler. */
function cleanSourcePath(raw, sourceRoot) {
  let path = String(raw || '').trim();
  if (!path) return '';

  // sourceRoot varsa bas tarafa eklenir (mutlak/URL degilse).
  if (sourceRoot && !/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(path)) {
    const root = sourceRoot.endsWith('/') ? sourceRoot : sourceRoot + '/';
    path = root + path;
  }

  // Sema on-eklerini soy: webpack://, webpack-internal://, rollup, vite, ng vb.
  path = path
    .replace(/^webpack-internal:\/\/\//, '')
    .replace(/^webpack:\/\/\/?/, '')
    .replace(/^(?:rollup|vite|ng|source|file):\/\/\/?/i, '');

  // Bazi bundler'lar "(namespace)/..." veya "./" ile baslar.
  path = path.replace(/^\.\//, '');

  return path;
}

/**
 * Source map metnini ayristirir.
 * @param {string} jsonText  .map dosyasinin ham icerigi
 * @param {string} mapUrl    .map dosyasinin URL'i (baglam icin)
 * @returns {{ ok: boolean, file: string, sourceRoot: string, count: number,
 *            hasContent: boolean, sources: Array<{path:string,hasContent:boolean,size:number}> }}
 */
export function parseSourceMap(jsonText, mapUrl = '') {
  let map;
  try {
    map = JSON.parse(jsonText);
  } catch {
    return { ok: false, file: '', sourceRoot: '', count: 0, hasContent: false, sources: [] };
  }
  if (!map || typeof map !== 'object' || !Array.isArray(map.sources)) {
    return { ok: false, file: '', sourceRoot: '', count: 0, hasContent: false, sources: [] };
  }

  const sourceRoot = typeof map.sourceRoot === 'string' ? map.sourceRoot : '';
  const contents = Array.isArray(map.sourcesContent) ? map.sourcesContent : [];
  const seen = new Set();
  const sources = [];

  for (let i = 0; i < map.sources.length; i++) {
    const cleaned = cleanSourcePath(map.sources[i], sourceRoot);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    const content = contents[i];
    sources.push({
      path: cleaned,
      hasContent: typeof content === 'string' && content.length > 0,
      size: typeof content === 'string' ? content.length : 0
    });
  }

  return {
    ok: true,
    file: typeof map.file === 'string' ? map.file : '',
    sourceRoot,
    count: sources.length,
    hasContent: sources.some((s) => s.hasContent),
    sources
  };
}

/**
 * `sourcesContent` iceren bir map'ten orijinal dosya iceriklerini dondurur.
 * Yalnizca gercek icerigi olanlar dahil edilir. Dis aktarim icin kullanilir.
 */
export function extractSourceContents(jsonText) {
  let map;
  try {
    map = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!map || !Array.isArray(map.sources) || !Array.isArray(map.sourcesContent)) return [];
  const sourceRoot = typeof map.sourceRoot === 'string' ? map.sourceRoot : '';
  const out = [];
  for (let i = 0; i < map.sources.length; i++) {
    const content = map.sourcesContent[i];
    if (typeof content !== 'string' || content.length === 0) continue;
    out.push({ path: cleanSourcePath(map.sources[i], sourceRoot), content });
  }
  return out;
}
