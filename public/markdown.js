// 簡易Markdownレンダラ
import { u } from './paths.js';
let findMod = () => null;
export const setModResolver = fn => { findMod = fn; };

export const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function safeUrl(u) {
  // javascript: などを弾く（http/https/mailto、相対パス、#のみ許可）
  return /^(https?:|mailto:|#|\/|\.{0,2}\/|[\w-]+[\w./-]*$)/i.test(u) && !/^\s*javascript:/i.test(u) ? u : '#';
}

export function inline(src) {
  let s = esc(src);
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  // ![説明|300](URL) で幅を指定（数字=px、小・中・大 も使える）
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, u) => {
    const m = alt.match(/^(.*?)\s*\|\s*(\d{2,4}|小|中|大)\s*$/);
    const size = m ? ({ 小: 240, 中: 480, 大: 0 }[m[2]] ?? Number(m[2])) : null;
    const text = m ? m[1] : alt;
    const style = size ? ` style="width:${size}px"` : size === 0 ? ' style="width:100%"' : '';
    return `<img src="${safeUrl(u)}" alt="${text}"${style} loading="lazy">`;
  });
  s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, id, label) => {
    const mod = findMod(id.trim());
    return mod
      ? `<a href="${u(`/mod/${encodeURIComponent(mod.slug)}`)}">${label || esc(mod.name)}</a>`
      : `<a class="missing" href="${u(`/mod/${encodeURIComponent(id.trim())}`)}" title="まだページがありません">${label || id}</a>`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
    const url = safeUrl(u);
    const ext = /^https?:/i.test(url) ? ' target="_blank" rel="noopener"' : '';
    return `<a href="${url}"${ext}>${t}</a>`;
  });
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__(.+?)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, '$1<em>$2</em>');
  s = s.replace(/~~(.+?)~~/g, '<del>$1</del>');
  s = s.replace(/==(.+?)==/g, '<mark>$1</mark>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
  return s;
}

const RE = {
  fence: /^```/, heading: /^(#{1,4})\s+(.+)$/, hr: /^\s*([-*_])(\s*\1){2,}\s*$/,
  quote: /^>\s?/, list: /^(\s*)([-*+]|\d+\.)\s+(.*)$/, tableSep: /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/,
};

function splitRow(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
}

function renderList(items) {
  let html = '';
  const stack = [];
  for (const it of items) {
    while (stack.length && it.indent < stack[stack.length - 1].indent) html += `</li></${stack.pop().tag}>`;
    const top = stack[stack.length - 1];
    if (!top || it.indent > top.indent) {
      stack.push({ indent: it.indent, tag: it.tag });
      html += `<${it.tag}><li>${inline(it.text)}`;
    } else {
      html += `</li><li>${inline(it.text)}`;
    }
  }
  while (stack.length) html += `</li></${stack.pop().tag}>`;
  return html;
}

/* レシピ表示
```recipe            ```smelt
鉄 | 鉄 | 鉄          鉄鉱石
   | 棒 |        →    => 鉄インゴット
   | 棒 |
=> 鉄のツルハシ x1
```                  ```
*/
const RECIPES = { recipe: 'craft', craft: 'craft', '作業台': 'craft', smelt: 'smelt', furnace: 'smelt', 'かまど': 'smelt' };

function renderRecipe(type, lines) {
  const arrowAt = lines.findIndex(l => /^\s*(=>|→|->)/.test(l));
  const inputs = (arrowAt === -1 ? lines : lines.slice(0, arrowAt)).filter(l => l.trim() || l.includes('|'));
  const outRaw = arrowAt === -1 ? '' : lines[arrowAt].replace(/^\s*(=>|→|->)\s*/, '').trim();
  const om = outRaw.match(/^(.*?)\s*[x×](\d+)$/);
  const [outName, outCount] = om ? [om[1], om[2]] : [outRaw, ''];
  const slot = (t, cls = '') => {
    const s = (t || '').trim();
    return `<span class="slot ${cls}${s ? '' : ' blank'}"${s ? ` title="${esc(s.replace(/\[\[|\]\]|!\[.*?\]\(.*?\)/g, ''))}"` : ''}>${s ? inline(s) : ''}</span>`;
  };
  const out = `<span class="r-arrow" aria-label="から作れるもの">➜</span>
    <span class="slot out${outName ? '' : ' blank'}"${outName ? ` title="${esc(outName)}"` : ''}>${outName ? inline(outName) : ''}${outCount ? `<b class="count">${outCount}</b>` : ''}</span>`;
  if (type === 'smelt') {
    return `<div class="recipe smelt" role="figure" aria-label="かまどのレシピ"><span class="r-label">かまど</span>
      <div class="r-body"><div class="r-furnace">${slot(inputs[0])}<span class="r-fire" aria-hidden="true">🔥</span></div>${out}</div></div>`;
  }
  const rows = inputs.slice(0, 3).map(l => l.split('|').slice(0, 3));
  while (rows.length < 3) rows.push([]);
  const grid = rows.map(r => [0, 1, 2].map(c => slot(r[c])).join('')).join('');
  return `<div class="recipe craft" role="figure" aria-label="作業台のレシピ"><span class="r-label">作業台</span>
    <div class="r-body"><div class="r-grid">${grid}</div>${out}</div></div>`;
}

const CALLOUTS = { TIP: ['tip', '💡 ヒント'], WARN: ['warn', '⚠️ 注意'], WARNING: ['warn', '⚠️ 注意'], NOTE: ['note', '📝 メモ'] };

export function renderMarkdown(md, headings = []) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  let html = '';
  let i = 0;
  const startsBlock = (l, next) => RE.fence.test(l) || RE.heading.test(l) || RE.hr.test(l) || RE.quote.test(l) ||
    RE.list.test(l) || (l.trim().startsWith('|') && next !== undefined && RE.tableSep.test(next));

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    if (RE.fence.test(line)) {
      const lang = line.replace(/^```\s*/, '').trim().toLowerCase();
      const buf = [];
      i++;
      while (i < lines.length && !RE.fence.test(lines[i])) buf.push(lines[i++]);
      i++;
      html += RECIPES[lang] ? renderRecipe(RECIPES[lang], buf) : `<pre><code>${esc(buf.join('\n'))}</code></pre>`;
      continue;
    }
    let m;
    if ((m = line.match(RE.heading))) {
      const level = Math.max(2, m[1].length); // # と ## → h2（ページタイトルがh1のため）
      const id = `h-${headings.length}`;
      headings.push({ level, id, text: m[2] });
      html += `<h${level} id="${id}">${inline(m[2])}</h${level}>`;
      i++; continue;
    }
    if (RE.hr.test(line)) { html += '<hr>'; i++; continue; }
    if (RE.quote.test(line)) {
      const buf = [];
      while (i < lines.length && RE.quote.test(lines[i])) buf.push(lines[i++].replace(RE.quote, ''));
      const c = buf[0].trim().match(/^\[!(\w+)\]$/);
      if (c && CALLOUTS[c[1].toUpperCase()]) {
        const [cls, title] = CALLOUTS[c[1].toUpperCase()];
        html += `<blockquote class="callout ${cls}"><div class="callout-title">${title}</div>${renderMarkdown(buf.slice(1).join('\n'))}</blockquote>`;
      } else {
        html += `<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`;
      }
      continue;
    }
    if (line.trim().startsWith('|') && RE.tableSep.test(lines[i + 1] || '')) {
      const head = splitRow(line);
      i += 2;
      let rows = '';
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows += '<tr>' + splitRow(lines[i++]).map(c => `<td>${inline(c)}</td>`).join('') + '</tr>';
      }
      html += `<div class="table-wrap"><table><thead><tr>${head.map(h => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
      continue;
    }
    if (RE.list.test(line)) {
      const items = [];
      while (i < lines.length && (m = lines[i].match(RE.list))) {
        items.push({ indent: m[1].replace(/\t/g, '  ').length, tag: /\d/.test(m[2]) ? 'ol' : 'ul', text: m[3] });
        i++;
      }
      html += renderList(items);
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !(buf.length && startsBlock(lines[i], lines[i + 1]))) buf.push(lines[i++]);
    html += `<p>${buf.map(inline).join('<br>')}</p>`;
  }
  return html;
}

// 検索の抜粋や説明文用に、記号を取り除いたプレーンテキストにする
export function plainText(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, id, label) => label || id)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>\s*\[!\w+\]|>|[-*+]|\d+\.)\s*/gm, '')
    .replace(/-{3,}|[*_~=`|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
