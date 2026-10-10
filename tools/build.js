// GitHub Pages 用の静的サイトを _site/ に書き出す（GitHub Actions が30分ごと＋手動で実行）。
//   1. Supabase の API（/export）から公開中のページを全部もらう
//   2. lib/ssr.js で各ページのHTMLを作る（検索エンジンがJSなしで中身を読めるように）
//   3. public/ の静的ファイルと一緒に _site/ へ
// ページの中身はブラウザでも API から最新を取り直すので、静的HTMLが少し古くても表示は最新になる。
//
// 使い方: node tools/build.js
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, u, appPath } from '../public/paths.js';
import { renderPage, renderShell } from '../lib/ssr.js';
import { LISTS } from '../public/seo.js';
import { KINDS, modHref } from '../public/views.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '_site');

const res = await fetch(`${config.api}/export`);
if (!res.ok) throw new Error(`API から取得できませんでした: ${res.status}`);
const { pages, articles } = await res.json();
console.log(`ページ ${pages.length} 件・記事 ${articles.length} 件`);

// renderPage が使う最小限の保存先（読み取りのみ）
const data = new Map([...pages.map(p => [`pages/${p.slug}`, p]), ...articles.map(a => [`articles/${a.slug}`, a])]);
const store = {
  get: async key => data.get(key) ?? null,
  list: async prefix => [...data.keys()].filter(k => k.startsWith(prefix)),
};

await fs.rm(OUT, { recursive: true, force: true });
await fs.cp(path.join(ROOT, 'public'), OUT, { recursive: true });
await fs.writeFile(path.join(OUT, '.nojekyll'), ''); // _ で始まるファイルもそのまま配信させる

// 書き出すページ（/mod/jei → mod/jei.html。GitHub Pages は拡張子なしでも .html を返す）
const routes = new Set(['/', '/articles', '/help', '/recent', '/news', '/contact', '/sitemap.xml']);
for (const p of pages) routes.add(appPath(modHref(p.slug)));
for (const a of articles) routes.add(appPath(KINDS.articles.view(a.slug)));
for (const [kind, def] of Object.entries(LISTS)) {
  for (const v of def.all) if (pages.some(p => p[def.field].includes(v))) routes.add(`/${kind}/${encodeURIComponent(v)}`);
}

let n = 0;
for (const route of routes) {
  const r = await renderPage(new Request(`https://build.local${u(route)}`), store);
  if (r.status !== 200) { console.warn('skip', route, r.status); continue; }
  const rel = route === '/' ? 'index.html' : route.endsWith('.xml') ? route.slice(1) : `${decodeURIComponent(route.slice(1))}.html`;
  await fs.mkdir(path.dirname(path.join(OUT, rel)), { recursive: true });
  await fs.writeFile(path.join(OUT, rel), await r.text());
  n++;
}
// まだ静的HTMLが無いページ（作ったばかりのMOD・編集画面など）は 404.html からブラウザで表示する
await fs.writeFile(path.join(OUT, '404.html'), await renderShell(store));
console.log(`${n} ページ + 404.html を書き出しました → _site/`);
