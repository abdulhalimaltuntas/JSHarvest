// lib/markdown.js
// Kucuk, guvenli Markdown -> DOM cevirici.
//
// GUVENLIK: innerHTML KULLANILMAZ. Her dugum createElement + textContent ile
// kurulur; model ciktisi hicbir kosulda HTML olarak yorumlanmaz.
//
// Desteklenen alt kume (AI ciktisi icin yeterli):
//   # ## ###   basliklar
//   - / * / 1. listeler (tek seviye)
//   **kalin**, `satir-ici kod`
//   ```kod blogu```
//   > alinti
//   ---  yatay cizgi
//   bos satirla ayrilmis paragraflar

const INLINE_RE = /(\*\*[^*]+\*\*|`[^`]+`)/g;

/** Satir ici kalin/kod parcalarini dugumlere cevirir. */
function inline(target, text) {
  const parts = String(text).split(INLINE_RE);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      const strong = document.createElement('strong');
      strong.textContent = part.slice(2, -2);
      target.appendChild(strong);
    } else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      const code = document.createElement('code');
      code.textContent = part.slice(1, -1);
      target.appendChild(code);
    } else {
      target.appendChild(document.createTextNode(part));
    }
  }
}

/**
 * Markdown metnini bir DocumentFragment olarak dondurur.
 * @param {string} text
 * @returns {DocumentFragment}
 */
export function renderMarkdown(text) {
  const frag = document.createDocumentFragment();
  const lines = String(text || '').split('\n');

  let list = null;        // acik <ul>/<ol>
  let paragraph = null;   // acik <p>
  let code = null;        // acik <pre>
  let codeLines = [];

  const closeParagraph = () => { paragraph = null; };
  const closeList = () => { list = null; };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');

    // Kod blogu sinirlari
    if (/^\s*```/.test(line)) {
      if (code) {
        code.textContent = codeLines.join('\n');
        frag.appendChild(code);
        code = null;
        codeLines = [];
      } else {
        closeParagraph();
        closeList();
        code = document.createElement('pre');
        code.className = 'md-pre';
      }
      continue;
    }
    if (code) { codeLines.push(raw); continue; }

    // Bos satir: acik bloklari kapat
    if (!line.trim()) { closeParagraph(); closeList(); continue; }

    // Yatay cizgi
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      closeParagraph(); closeList();
      frag.appendChild(document.createElement('hr'));
      continue;
    }

    // Baslik
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      closeParagraph(); closeList();
      const level = Math.min(4, heading[1].length);
      const node = document.createElement('h' + Math.max(2, level));
      node.className = 'md-h md-h' + level;
      inline(node, heading[2]);
      frag.appendChild(node);
      continue;
    }

    // Alinti
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      closeParagraph(); closeList();
      const node = document.createElement('blockquote');
      node.className = 'md-quote';
      inline(node, quote[1]);
      frag.appendChild(node);
      continue;
    }

    // Liste ogesi
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      closeParagraph();
      const wanted = bullet ? 'UL' : 'OL';
      if (!list || list.tagName !== wanted) {
        list = document.createElement(bullet ? 'ul' : 'ol');
        list.className = 'md-list';
        frag.appendChild(list);
      }
      const li = document.createElement('li');
      inline(li, bullet ? bullet[1] : ordered[2]);
      list.appendChild(li);
      continue;
    }

    // Paragraf (devam eden satirlar birlestirilir)
    closeList();
    if (!paragraph) {
      paragraph = document.createElement('p');
      paragraph.className = 'md-p';
      frag.appendChild(paragraph);
      inline(paragraph, line);
    } else {
      paragraph.appendChild(document.createTextNode(' '));
      inline(paragraph, line);
    }
  }

  // Kapanmamis kod blogu
  if (code) {
    code.textContent = codeLines.join('\n');
    frag.appendChild(code);
  }

  return frag;
}
