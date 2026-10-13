// 検索エンジン向けに、ページごとのHTML（タイトル・説明・本文・構造化データ）をサーバーで組み立てる。
// ブラウザでは app.js が同じ内容を描き直して、その後の操作を引き継ぐ。
// GitHub Pages 用には tools/build.js がこれを使って静的HTMLを書き出す。
import { esc, setModResolver } from '../public/markdown.js';
import { modCard, card, pageView, modHref, KINDS, homeIntro } from '../public/views.js';
import {
  SITE_NAME, SITE_TAGLINE, SITE_DESC, homeTitle, pageTitle, modTitle, modDescription,
  LISTS, listTitle, listDescription, listPath, articleTitle, articleDescription, ARTICLES_TITLE, ARTICLES_DESC,
} from '../public/seo.js';
import { u, abs, appPath, OPENCHAT } from '../public/paths.js';

const GSC = '-E9RpAOQaF2nxLMXBMlpY782BxGCvZMRVOxIME79hSA';
const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%237a5537'/%3E%3Crect width='16' height='5' fill='%234f8a2b'/%3E%3Crect x='3' y='5' width='2' height='2' fill='%234f8a2b'/%3E%3Crect x='10' y='5' width='2' height='3' fill='%234f8a2b'/%3E%3C/svg%3E";
const NOINDEX = new Set(['edit', 'new', 'revert', 'history', 'admin', 'search', 'articles', 'article', 'drafts', 'user', 'login']);

const html = (body, status = 200) => new Response(body, {
  status,
  headers: {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  },
});

async function loadPages(store, col = 'pages') {
  const keys = await store.list(`${col}/`);
  return (await Promise.all(keys.map(k => store.get(k)))).filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, 'ja'));
}

function footerLinks(pages) {
  const groups = Object.entries(LISTS).map(([kind, def]) => {
    const used = def.all.filter(v => pages.some(p => p[def.field].includes(v)));
    if (!used.length) return '';
    const title = { version: 'バージョン別', loader: 'ローダー別', tag: 'ジャンル別' }[kind];
    return `<div><h2>${title}MOD</h2><ul>${used.map(v => `<li><a href="${listPath(kind, v)}">${esc(def.label(v))}</a></li>`).join('')}</ul></div>`;
  }).join('');
  return `<nav class="footer-links" aria-label="MODを探す">${groups}</nav>`;
}

function layout({ path, title, description, body, pages, articles = [], robots = 'index,follow,max-image-preview:large', jsonld = [], ogType = 'website', image = '' }) {
  const url = abs(path);
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="${robots}">
<link rel="canonical" href="${esc(url)}">
<meta name="google-site-verification" content="${GSC}" />
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:type" content="${ogType}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:locale" content="ja_JP">
${image ? `<meta property="og:image" content="${esc(image)}">` : ''}
<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">
<link rel="icon" href="${FAVICON}">
<link rel="sitemap" type="application/xml" href="${u('/sitemap.xml')}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DotGothic16&family=Noto+Sans+JP:wght@400;500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${u('/style.css')}">
${jsonld.map(j => `<script type="application/ld+json">${JSON.stringify(j).replace(/</g, '\\u003c')}</script>`).join('\n')}
</head>
<body>
<header class="site-header">
  <div class="wrap header-inner">
    <a href="${u('/')}" class="logo"><span class="logo-block" aria-hidden="true"></span>MOD Wiki</a>
    <nav>
      <a href="${u('/')}">MOD一覧</a>
      <a href="${u('/articles')}">記事</a>
      <a href="${u('/recent')}">最近の更新</a>
      <a href="${u('/news')}">お知らせ</a>
      <a href="${u('/help')}">書き方</a>
    </nav>
    <form class="header-search" action="${u('/search')}" role="search"><input name="q" type="search" placeholder="Wiki内・ユーザーを検索" aria-label="Wiki内・ユーザーを検索"></form>
  </div>
</header>
<div id="site-banner" class="site-banner" hidden></div>
<main id="app" class="wrap">${body}</main>
<footer class="site-footer wrap">
  ${footerLinks(pages)}
  <p class="footer-contact"><a href="${u('/contact')}">📮 運営へのお問い合わせ</a> ・ <a href="${u('/news')}">📢 お知らせ</a> ・ <a href="${esc(OPENCHAT.url)}" target="_blank" rel="noopener">💬 LINEオープンチャット</a></p>
  <p class="footer-about">${esc(SITE_NAME)}（${esc(SITE_TAGLINE)}）は、Minecraft（マインクラフト）のMODの使い方・導入方法・対応バージョンを日本語でまとめた、だれでも編集できるWikiです。Mojang・Microsoftとは関係のない非公式ファンサイトです。</p>
</footer>
<script type="module" src="${u('/app.js')}"></script>
</body>
</html>`;
}

// ページの作者（アカウントならプロフィールへのリンク）
const creator = p => (p.createdUid ? `<a class="user-link" href="${u(`/user/${encodeURIComponent(p.createdBy)}`)}">👤 ${esc(p.createdBy)}</a>` : esc(p.createdBy || ''));

const breadcrumb = items => ({
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: items.map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, item: abs(appPath(path)) })),
});

function sitemap(pages, articles) {
  const full = p => abs(appPath(p)); // modHref などはフォルダ付きなので一度外してから付け直す
  const urls = [
    [abs('/'), pages.reduce((a, p) => (p.updatedAt > a ? p.updatedAt : a), '')],
    ...pages.map(p => [full(modHref(p.slug)), p.updatedAt]),
    ...(articles.length ? [[abs('/articles'), articles.reduce((a, p) => (p.updatedAt > a ? p.updatedAt : a), '')]] : []),
    ...articles.map(p => [full(KINDS.articles.view(p.slug)), p.updatedAt]),
    ...Object.entries(LISTS).flatMap(([kind, def]) => def.all
      .filter(v => pages.some(p => p[def.field].includes(v)))
      .map(v => [full(listPath(kind, v)), ''])),
    [abs('/help'), ''],
  ];
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(([loc, mod]) => `  <url><loc>${esc(loc)}</loc>${mod ? `<lastmod>${mod.slice(0, 10)}</lastmod>` : ''}</url>`).join('\n')}
</urlset>`, {
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });
}

// ブラウザが最初に読む空の画面（GitHub Pages の 404.html＝まだ静的HTMLが無いページ・編集画面など）
export async function renderShell(store) {
  const pages = await loadPages(store);
  return layout({ path: '/', pages, title: SITE_NAME, description: SITE_DESC, robots: 'noindex', body: '<div class="loading">読み込み中…</div>' });
}

export async function renderPage(req, store) {
  const url = new URL(req.url);
  const sitePath = appPath(url.pathname);
  const path = decodeURI(sitePath);
  const parts = path.split('/').filter(Boolean);
  const [pages, articles] = await Promise.all([loadPages(store), loadPages(store, 'articles')]);
  setModResolver(key => {
    const k = key.toLowerCase();
    return pages.find(m => m.slug === k) || pages.find(m => m.name.toLowerCase() === k);
  });
  const common = { path: sitePath, pages };

  if (path === '/sitemap.xml') return sitemap(pages, articles);

  // トップ
  if (!parts.length) {
    return html(layout({
      ...common, title: homeTitle(), description: SITE_DESC,
      body: `
        ${homeIntro({ mods: pages, articles })}
        ${articles.length ? `<section class="home-articles"><div class="section-head"><h2>📝 まとめ記事</h2><a href="${u('/articles')}">すべて見る →</a></div>
          <div class="grid">${[...articles].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 4).map(a => card(a, 'articles')).join('')}</div></section>
          ` : ''}
        <h2 class="section-title">MOD一覧</h2>
        <div class="count">${pages.length} 件</div>
        <div class="grid">${pages.map(modCard).join('')}</div>`,
      jsonld: [{
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        name: SITE_NAME,
        alternateName: ['マイクラMOD Wiki', 'Minecraft MOD 日本語Wiki', 'マインクラフト MOD 解説Wiki'],
        url: abs('/'),
        inLanguage: 'ja',
        description: SITE_DESC,
        potentialAction: { '@type': 'SearchAction', target: `${abs('/search')}?q={search_term_string}`, 'query-input': 'required name=search_term_string' },
      }],
    }));
  }

  // MODページ
  if (parts[0] === 'mod' && parts[1] && parts.length === 2) {
    const m = pages.find(p => p.slug === parts[1]);
    if (!m) {
      return html(layout({
        ...common, title: pageTitle('ページが見つかりません'), description: SITE_DESC, robots: 'noindex',
        body: `<h1 class="page-title">${esc(parts[1])}</h1><div class="empty">このページはまだありません。</div>`,
      }), 404);
    }
    const description = modDescription(m);
    return html(layout({
      ...common, title: modTitle(m), description, ogType: 'article', image: m.image ? new URL(m.image, abs('/')).href : '',
      body: `<div class="page-tools"><div class="crumb"><a href="${u('/')}">MOD一覧</a> › ${esc(m.name)}</div></div>${pageView(m)}
        <p class="page-foot">作成: ${creator(m)} ・ 最終更新: ${esc(m.updatedAt.slice(0, 10))}（${esc(m.updatedBy)}）・ 版 ${m.rev}</p>`,
      jsonld: [{
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: `${m.name}（マイクラMOD）の使い方・導入方法`,
        description,
        inLanguage: 'ja',
        datePublished: m.createdAt,
        dateModified: m.updatedAt,
        mainEntityOfPage: abs(appPath(modHref(m.slug))),
        author: { '@type': 'Organization', name: `${SITE_NAME} 編集者` },
        publisher: { '@type': 'Organization', name: SITE_NAME, url: abs('/') },
        about: { '@type': 'Thing', name: m.name, ...(m.link ? { sameAs: m.link } : {}) },
        keywords: [m.name, 'Minecraft', 'マイクラ', 'MOD', ...m.versions, ...m.loaders, ...m.tags].join(', '),
        ...(m.image ? { image: new URL(m.image, abs('/')).href } : {}),
      }, breadcrumb([['MOD一覧', u('/')], [m.name, modHref(m.slug)]])],
    }));
  }

  // まとめ記事一覧
  if (parts[0] === 'articles' && parts.length === 1) {
    const list = [...articles].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return html(layout({
      ...common, title: ARTICLES_TITLE, description: ARTICLES_DESC,
      body: `<div class="page-head"><div><h1 class="page-title">まとめ記事</h1><p class="lead">${esc(ARTICLES_DESC)}</p></div></div>
        <div class="count">${list.length} 件</div><div class="grid">${list.map(a => card(a, 'articles')).join('')}</div>`,
      jsonld: [breadcrumb([['MOD一覧', u('/')], ['まとめ記事', u('/articles')]])],
    }));
  }

  // まとめ記事
  if (parts[0] === 'article' && parts[1] && parts.length === 2) {
    const a = articles.find(p => p.slug === parts[1]);
    if (!a) {
      return html(layout({ ...common, title: pageTitle('ページが見つかりません'), description: SITE_DESC, robots: 'noindex', body: '<div class="empty">この記事はまだありません。</div>' }), 404);
    }
    const description = articleDescription(a);
    return html(layout({
      ...common, title: articleTitle(a), description, ogType: 'article', image: a.image ? new URL(a.image, abs('/')).href : '',
      body: `<div class="page-tools"><div class="crumb"><a href="${u('/articles')}">まとめ記事</a> › ${esc(a.name)}</div></div>${pageView(a, 'articles')}
        <p class="page-foot">作成: ${creator(a)} ・ 最終更新: ${esc(a.updatedAt.slice(0, 10))}（${esc(a.updatedBy)}）・ 版 ${a.rev}</p>`,
      jsonld: [{
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: a.name,
        description,
        inLanguage: 'ja',
        datePublished: a.createdAt,
        dateModified: a.updatedAt,
        mainEntityOfPage: abs(appPath(KINDS.articles.view(a.slug))),
        author: { '@type': 'Person', name: a.createdBy },
        publisher: { '@type': 'Organization', name: SITE_NAME, url: abs('/') },
        keywords: ['Minecraft', 'マイクラ', 'MOD', ...a.versions, ...a.loaders, ...a.tags].join(', '),
        ...(a.image ? { image: new URL(a.image, abs('/')).href } : {}),
      }, breadcrumb([['まとめ記事', u('/articles')], [a.name, KINDS.articles.view(a.slug)]])],
    }));
  }

  // バージョン別・ローダー別・ジャンル別
  if (LISTS[parts[0]] && parts[1] && parts.length === 2) {
    const kind = parts[0];
    const def = LISTS[kind];
    const value = def.all.find(v => v.toLowerCase() === parts[1].toLowerCase());
    const mods = value ? pages.filter(p => p[def.field].includes(value)) : [];
    if (!value) {
      return html(layout({ ...common, title: pageTitle('ページが見つかりません'), description: SITE_DESC, robots: 'noindex', body: '<div class="empty">ページが見つかりません。</div>' }), 404);
    }
    const description = listDescription(kind, value, mods);
    return html(layout({
      ...common, title: listTitle(kind, value), description,
      robots: mods.length ? 'index,follow' : 'noindex,follow',
      body: `
        <div class="page-head"><div>
          <h1 class="page-title">${esc(def.label(value))}</h1>
          <p class="lead">${esc(description)}</p>
        </div></div>
        <div class="count">${mods.length} 件</div>
        <div class="grid">${mods.map(modCard).join('') || '<div class="empty">該当するMODがありません</div>'}</div>`,
      jsonld: [breadcrumb([['MOD一覧', u('/')], [def.label(value), listPath(kind, value)]])],
    }));
  }

  // そのほか（中身はブラウザで描画）
  const known = { recent: '最近の更新', news: 'お知らせ', contact: 'お問い合わせ', help: '書き方・編集ガイド', edit: '編集', new: '新しいページを作る', revert: '差し戻し', history: '更新履歴', admin: '管理', search: '検索', articles: '新しい記事を書く', article: '記事の編集', drafts: '下書き', user: 'ユーザー', login: 'ログイン' };
  if (known[parts[0]]) {
    return html(layout({
      ...common, title: pageTitle(known[parts[0]]), description: SITE_DESC,
      robots: NOINDEX.has(parts[0]) ? 'noindex,follow' : 'index,follow',
      body: '<div class="loading">読み込み中…</div>',
    }));
  }
  return html(layout({ ...common, title: pageTitle('ページが見つかりません'), description: SITE_DESC, robots: 'noindex', body: '<div class="empty">ページが見つかりません。</div>' }), 404);
}
