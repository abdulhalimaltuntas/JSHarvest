// panel/devtools.js
// DevTools baglaminda calisir; JSHarvest panelini kaydeder. Klasik script
// (module degil) — bu yuzden browser-api.js import edilmez.

(() => {
  'use strict';
  const api = globalThis.browser || globalThis.chrome;
  try {
    // KRITIK: Yollar KOK-MUTLAK olmali. Firefox bu yollari devtools sayfasina
    // (panel/devtools.html) gore cozuyor; bagil verilirse panel/panel/panel.html
    // aranir -> 404 -> bos beyaz panel ve bos ikon karesi. Bas taki "/" her iki
    // tarayicida da eklenti kokunden cozulmesini garanti eder.
    const result = api.devtools.panels.create('JSHarvest', '/icons/icon48.png', '/panel/panel.html');
    // Firefox Promise dondurur; hata olursa yut.
    if (result && typeof result.catch === 'function') {
      result.catch((err) => console.warn('[JSHarvest] panel create failed:', err));
    }
  } catch (err) {
    console.warn('[JSHarvest] devtools panel registration failed:', err);
  }
})();
