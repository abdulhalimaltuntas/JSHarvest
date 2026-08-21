# DECISIONS

Belirsiz noktalarda secilen varsayimlar. Her satir tek bir karar.

1. `webNavigation` izni eklendi — spec'teki izin listesinde yoktu; `tabs.onUpdated` SPA `pushState` degisimlerinde de tetiklendigi icin liste yanlislikla sifirlanirdi.
2. `downloads` izni alinmadi — indirme Blob + `<a download>` ile yapiliyor, ek izin gerekmiyor.
3. Dedupe anahtari `origin + pathname` (kucuk harfe cevrilmis); ham URL `url`, query'li hali `normalizedUrl` alaninda korunuyor.
4. Public-suffix icin kutuphane eklenmedi; ~60 cok parcali son ek + yaygin barindirma alan adi (github.io, vercel.app, cloudfront.net…) elle listelendi.
5. `lib/store.js` icinde kayitlar performans icin yerinde guncelleniyor; immutability kurali depolama katmaninin disinda (popup/classify/export) korunuyor — her istekte 5000 anahtarli nesne kopyalamak kabul edilemez maliyet.
6. Content script klasik script olarak yaziliyor (module degil); bu yuzden ihtiyac duydugu 3 regex `lib/classify.js` yerine dosya icinde tekrar tanimli.
7. Spec'teki dosya listesine `lib/deepscan.js` ve `lib/messaging.js` eklendi — deep scan mantigi service worker'i sismekten kurtardi, `broadcast` ise dairesel import'u onledi.
8. Deep Scan sinirlari: en fazla 60 dosya, 4 es zamanli istek, istek basina 10s timeout, dosya basina 4MB okuma / 300 aday, toplam 2000 kesif, 25 sourcemap HEAD kontrolu.
9. Popup, background'dan push almak yerine 1200ms araliklarla `updatedAt` karsilastirmali yoklama yapiyor — service worker uyku/uyanma dongusune dayanikli ve daha basit.
10. Liste sanallastirmasi sabit 52px satir yuksekligi + 6 satir overscan ile yapildi (popup.css `--row-h` ile senkron tutulmali).
11. `blob:` ve `data:` kaynaklari first-party sayiliyor ve varsayilan olarak gizli; `blob/data` chip'i ile acilir.
12. Deep Scan istekleri `credentials: 'omit'` ve `cache: 'force-cache'` ile yapiliyor — cerez gonderilmiyor, mumkun oldugunda tarayici onbellegi kullaniliyor.
13. Webpack `publicPath` literal olarak bulunamazsa (`p="auto"`) chunk yolu bundle dizinine gore cozuluyor; yol ile dizin segmentleri ortusuyorsa ortusme kirpiliyor (`/assets/` + `assets/x.js` -> `/assets/x.js`).
14. `.u` sablonunda yalnizca *tek* bir obje literali `{...}[e]` bicimindeyse id haritasi kabul ediliyor; birlesik ifadeler ozyinelemeli olarak parcalaniyor. Id haritasi bulunamazsa hic URL uretilmiyor (yanlis pozitif yerine sessizlik).
15. `chrome.storage.session` kota hatasinda kayitlar yariya indirilip tek sefer daha deneniyor; yine olmazsa bellekteki veriyle devam ediliyor.
16. `xmlhttprequest`/`other` istekleri icin content-type haritasi bellekte (ephemeral) tutuluyor; worker uykusundan sonra kaybolursa uzanti tabanli tespite dusuluyor.
17. Inline script referanslari ve sourcemap adaylari `confidence: "inferred"` ile isaretleniyor; sourcemap yalnizca HEAD 2xx donerse `confirmed` oluyor.
18. Tab basina 5000 kayit siniri; asildiginda `firstSeen` degerine gore en eski kayitlar dusuyor.
19. Koleksiyon yalnizca `webNavigation.onCommitted` (frameId 0) ile sifirlaniyor; `onHistoryStateUpdated` sadece sayfa URL'ini gunceller.
20. `icons/` altindaki PNG'ler script ile uretilmis yer tutuculardir (koyu kare + sari isaret); marka calismasi gerekirse degistirilebilir.
21. Popup genisligi 480px, yuksekligi 580px sabit — Chrome popup'inin maksimum kullanilabilir alanina yakin, yatay kaydirma yok.
22. Firefox destegi eklendi (spec "gerekmiyor" diyordu, kullanici sonradan istedi): tek kod tabani, iki manifest — Chrome `background.service_worker`, Firefox `background.scripts` + `type: "module"`; Chrome `scripts` anahtarini MV3'te reddettigi icin tek manifest mumkun degil.
23. `lib/browser-api.js` shim'i eklendi: `globalThis.browser ?? globalThis.chrome`. Firefox'ta `chrome.*` callback tabanlidir; `await chrome.storage.session.get(...)` sessizce `undefined` donerdi. Tum moduller `chrome.` yerine `api.` kullaniyor; klasik content script import edemedigi icin ayni kurali yerel olarak uyguluyor.
24. Popup'taki `sendMessage` callback bicimi promise bicimine cevrildi — Firefox'ta `browser.*` callback kabul etmiyor, promise bicimi her iki tarayicida calisiyor.
25. `build.mjs` yalnizca kopyalama yapar (derleme/bagimlilik yok); Firefox `manifest.json` adinda dosya istedigi icin gerekli. Proje koku Chrome'da hala dogrudan "Load unpacked" ile yuklenebilir.
26. Firefox `strict_min_version: "115.0"` — `storage.session` ve module tabanli background script bu surumle geliyor. `browser_specific_settings.gecko.id` = `jsharvest@local.dev` (yerel kullanim icin; AMO yayini yapilacaksa degistirilmeli).
27. Firefox MV3'te `host_permissions` opsiyoneldir ve kullanici tarafindan verilmelidir; otomatik istem yerine README'ye zorunlu kurulum adimi olarak yazildi.
28. `Copy All` aktif filtrenin sonucunu kopyalar, `Export` de ayni filtrelenmis listeyi yazar (spec'te Copy All icin belirtilen davranis tum formatlara tasindi).

--- Genisletme fazi (source map, madencilik, worker, diff, panel, options) ---

29. Navigasyon "epoch" modeli: sert reset yerine her kayit epoch ile etiketlenir. onBeforeNavigate epoch'u artirir (liste korunur), onCommitted commit edip yalnizca onceki epoch'u temizler. Boylece commit'e yarisan erken script'ler yasar. onBeforeNavigate kacarsa onCommitted yine de temizler (yeni URL varsayimi).
30. Source map yutma yalnizca Deep Scan icinde ve first-party .map'ler icin. sourcesContent varligi isaretlenir ama tam icerik varsayilan olarak SAKLANMAZ (kota + gizlilik); yalnizca yol listesi tutulur. `webpack://`, `webpack-internal://` vb. sema on-ekleri temizlenir.
31. Sir/endpoint madenciligi (lib/mine.js) yuksek-sinyalli desenler (AKIA, AIza, xox, sk_live, gh*_, JWT, PEM...) + dusuk guvenli jenerik `key=...` deseni. Sir DEGERLERI maskelenir (bas4+son2), tam sir loglanmaz/saklanmaz; yalnizca endpoint degerleri ham tutulur. Deep Scan'in bir parcasi oldugundan zaten opt-in.
32. Worker tespiti icin MAIN-world page-hook (content/page-hook.js) web_accessible_resources olarak sunulup <script> ile enjekte edilir; Worker/SharedWorker/serviceWorker.register sarilir ama davranis DEGISTIRILMEZ (orijinal her zaman cagrilir), URL'ler postMessage ile iletilir. MAIN world content script (world:"MAIN") yerine enjeksiyon secildi cunku Firefox 115 world:"MAIN" desteklemiyor.
33. SRI/mixed-content: DOM toplayicida script[src] icin integrity varligi ve http-on-https bayraklari toplanir; `noIntegrity` yalnizca https ucuncu-taraf script icin türetilir (birinci-taraf ve worker haric). "Risk" chip'i bu ikisini filtreler.
34. Deep Scan HEAD dogrulama: kesfedilen chunk'lar 200 donerse 'inferred'->'confirmed' yukseltilir; 404 statu isaretlenir ama silinmez. Recursion varsayilan derinlik 1, yalnizca first-party chunk'lar. Limitler artirildi (80 dosya, 400 HEAD, 40 map).
35. Ayarlar ve diff snapshot'lari storage.LOCAL'de (kalici), canli yakalama storage.SESSION'da (oturumluk). Popup/options/panel eklenti baglaminda calistigi icin settings/history/diff dogrudan lib'den kullanilir — bunlar icin ayri mesajlasma eklenmedi.
36. Diff semantigi: kullanici "Snapshot" alir, gezinir/yeniler, sonra Diff gorunumu son snapshot'i "onceki" kabul edip simdiki listeyle karsilastirir. "Degisti" sinyali: statu, boyut veya sourcemap durumu farki.
37. DevTools paneli ana liste (scripts) icin genis/siralanabilir tablo; findings/sources/diff popup'ta tutuldu (panel odagi hizli tablo taramasi). Panel de 28px sabit satir ile sanallastirilir.
38. Toolbar rozeti sekme basina script sayisini gosterir (api.action.setBadgeText), 500ms throttle ile; ayarlardan kapatilabilir. Rozet ayar degisimi storage.onChanged ile tum sekmelerde tazelenir.
39. Ek export'lar: wordlist (benzersiz yol segmentleri, uzantili+uzantisiz), curl (statu problama script'i, kimlik bilgisi tasimaz), HAR (minimal alt kume), sources-tree, findings md/csv/json. Gorunume gore export menusu dinamik uretilir.
40. Ortak tasarim token'lari styles/tokens.css'e cikarildi (options + panel kullanir); popup kendi kopyasini korudu (regresyon riskini onlemek icin).
41. package.json bagimliliksiz test/build script'leri sunar; web-ext yalnizca opsiyonel lint/paketleme icin devDependency. CI dependency kurmadan test+build+syntax kosar, web-ext lint'i `|| true` ile tolere eder.

--- AI analiz katmani (bring-your-own-key) ---

42. AI cagrisi eklenti SAYFASINDAN (popup) yapilir, service worker'dan degil: uzun analizde SW olmez ve <all_urls> host izni CORS'u bypass eder. Ayri host izni/manifest degisikligi gerekmedi.
43. API anahtari ayarlardan AYRI, storage.local'de `jsharvest_ai_key` altinda tutulur; getSettings'e sizmaz, content script'e asla gitmez. Yalnizca lib/ai.js okur/yazar.
44. Saglayici soyutlamasi: Anthropic, OpenAI, Gemini ve OpenAI-uyumlu "custom" (OpenRouter/Groq/yerel). Her biri request/parse/streamDelta sunar; ortak SSE tuketici tum saglayicilarda `data:` satirlarini ayni sekilde isler.
45. Model alani DUZENLENEBILIR (datalist onerileriyle) — saglayici id'leri zamanla degistigi icin sabit id gomulmedi. Anthropic varsayilanlari sistem-bilinen 5-serisi/Haiku 4.5 id'leri.
46. Gizlilik: sir DEGERLERI madencilikte zaten maskelenir ve ham hali HIC saklanmaz -> AI'a ham sir gitmesi teknik olarak imkansiz. `aiRedact` (varsayilan acik) ek olarak dosya yollarini ve ham endpoint degerlerini de baglamdan cikarir. AI'a yalnizca kompakt envanter (URL/vendor/bundle/finding/kaynak-yolu ozeti) gonderilir, token butcesiyle sinirli.
47. Anthropic'e tarayici-kaynakli erisim icin `anthropic-dangerous-direct-browser-access: true` header'i eklendi (eklenti sayfasi Origin gonderdiginden gerekli).
48. Streaming eklenti sayfasinda fetch ReadableStream ile yapilir; AbortController ile "Stop". Cikti textContent ile yazilir (innerHTML yok). Anahtar/model dogrulamasi icin Options'ta kucuk bir "Test connection" istegi.
49. AI, tamamen opt-in ve varsayilan KAPALI; anahtar yoksa/kapaliysa AI sekmesi Options'a yonlendiren bir ipucu gosterir. Eklenti AI olmadan tam calisir.

--- AI katmani sadelestirme + kalite (v2) ---

50. Kullanici artik YALNIZCA API anahtari girer. Saglayici anahtarin bicimden tespit edilir (sk-ant- -> Anthropic, AIza -> Gemini, gsk_ -> Groq, sk-or-v1- -> OpenRouter, sk- -> OpenAI). Provider/model/base-url alanlari ayarlardan tamamen kaldirildi.
51. Model otomatik: her saglayici icin aday model listesi var; 404/"model not found" turu hatada sirayla bir sonrakine gecilir ve calisan model storage.local'de onbelleklenir. Model id'leri zamanla degistigi icin kullaniciya bakim yuku birakilmadi. Anahtar degisince onbellek temizlenir.
52. Baglam zenginlestirildi: toplamlar, risk sinyalleri (SRI/mixed/worker/hata/dogrulanmamis), boyuta gore ucuncu-taraf host envanteri, en buyuk first-party bundle'lar, URL kanitli teknoloji izleri, worker listesi, 4xx/hata yanitlari, madencilik bulgulari ve source map istatistikleri. Hepsi ust sinirli (token butcesi).
53. Sistem promptu "gozlem vs cikarim" ayrimini, madenci guveninin yeniden yargilanmasini, uydurma URL/surum yasagini ve severity etiketlerini zorunlu kilar. Her analiz turu icin cikti iskeleti (## basliklar) tanimlandi.
54. Cikti markdown olarak render edilir (lib/markdown.js). innerHTML KULLANILMAZ; her dugum createElement/textContent ile kurulur -> model ciktisi hicbir kosulda HTML olarak yorumlanmaz (XSS testle dogrulanir).
55. Takip sorulari: konusma gecmisi tutulur ve takip isteginde baglam TEKRAR GONDERILMEZ (token tasarrufu). Gecmis son 8 mesajla sinirli. Yeni analiz secmek konusmayi sifirlar.
56. Hata mesajlari kullanici diline cevrilir (401 -> gecersiz anahtar, 429 -> kota/limit, 5xx -> saglayici hatasi); ham saglayici govdesi yalnizca baska bir sey yoksa gosterilir.
57. temperature 0.3 sabitlendi: guvenlik analizi tutarlilik ister, yaraticilik degil.

58. Firefox `strict_min_version` 115 -> 140.0 (+ `gecko_android` 142.0) yukseltildi. Neden: `browser_specific_settings.gecko.data_collection_permissions` anahtari Firefox 140 / Android 142 ile geldi; 115 ile birlikte AMO uyumluluk uyarisi veriyordu. Alternatif (anahtari kaldirip 115'te kalmak) reddedildi: veri toplama beyani AI ozelligi nedeniyle dogru olan sey ve Mozilla bunu zorunlu kilma yolunda. Bugun desteklenen en eski Firefox dali zaten 140 ESR oldugundan pratikte kullanici kaybi yok.

59. Model alani istege bagli olarak geri getirildi (kullanici talebi: model adi onemli). Tasarim: alan BOS ise otomatik secim aynen calisir; doluysa o model ilk sirada denenir. Aday sirasi: sabitlenen model -> son calisan (onbellek) -> saglayici varsayilanlari. Sabitlenen model artik yoksa sessizce kalmak yerine digerlerine dusulur, cunku gercekte kullanilan model arayuzde her zaman gosterilir (saglayici + model + pinned/auto etiketi). Model bir sir DEGILDIR; API anahtarindan farkli olarak ayarlarda tutulur.
