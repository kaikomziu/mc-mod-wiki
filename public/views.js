// ページ本体・カードのHTML（サーバー側の事前描画とブラウザの両方で使う）
import { esc, safeUrl, inline, renderMarkdown } from './markdown.js';
import { listPath } from './seo.js';
import { u, OPENCHAT } from './paths.js';

export const fmt = iso => new Date(iso).toLocaleString('ja-JP', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
const e = s => encodeURIComponent(s);

// MODページ（pages）とまとめ記事（articles）のURL（設定が後から変わっても追従するよう getter / 関数にしている）
export const KINDS = {
  pages: {
    label: 'MOD', listLabel: 'MOD一覧', get listPath() { return u('/'); }, get newPath() { return u('/new'); },
    view: s => u(`/mod/${e(s)}`), edit: s => u(`/edit/${e(s)}`), hist: s => u(`/history/${e(s)}`), revert: (s, r) => u(`/revert/${e(s)}/${r}`),
  },
  articles: {
    label: '記事', listLabel: 'まとめ記事', get listPath() { return u('/articles'); }, get newPath() { return u('/articles/new'); },
    view: s => u(`/article/${e(s)}`), edit: s => u(`/article/${e(s)}/edit`), hist: s => u(`/article/${e(s)}/history`), revert: (s, r) => u(`/article/${e(s)}/revert/${r}`),
  },
};
export const modHref = slug => KINDS.pages.view(slug);

const KIND = { versions: 'version', loaders: 'loader', tags: 'tag' };
export const filterLink = (field, v, cls = '') => `<a class="tag ${cls}" href="${listPath(KIND[field], v)}">${esc(v)}</a>`;
const tagSpans = (arr, cls = '') => arr.map(v => `<span class="tag ${cls}">${esc(v)}</span>`).join('');
export const formatDownloads = n => (n >= 1e8 ? `${(n / 1e8).toFixed(1)}億` : n >= 1e4 ? `${Math.round(n / 1e4).toLocaleString()}万` : n.toLocaleString());

export function card(m, col = 'pages') {
  const isArticle = col === 'articles';
  return `
    <a class="card${isArticle ? ' article-card' : ''}" href="${KINDS[col].view(m.slug)}">
      ${m.image ? `<img class="card-icon" src="${esc(safeUrl(m.image))}" alt="" loading="lazy">` : ''}
      <h3>${m.locked ? '<span title="ロック中">🔒</span> ' : ''}${isArticle ? '📝 ' : ''}${esc(m.name)}</h3>
      <p>${inline(m.summary)}</p>
      <div class="tags">${tagSpans(m.versions, 'ver')}${tagSpans(m.loaders, 'loader')}${tagSpans(m.tags)}</div>
      <div class="card-meta">${fmt(m.updatedAt)} ・ ${esc(m.updatedBy)}${m.downloads ? ` ・ ⬇ ${formatDownloads(m.downloads)}` : ''}${m.likes ? ` <span class="card-likes">♥ ${m.likes}</span>` : ''}</div>
    </a>`;
}
export const modCard = m => card(m, 'pages');

export function pageView(m, col = 'pages') {
  const headings = [];
  const body = renderMarkdown(m.body, headings);
  const h2s = headings.filter(h => h.level === 2);
  const toc = h2s.length >= 3
    ? `<nav class="toc"><strong>目次</strong><ol>${h2s.map(h => `<li><a href="#${h.id}" data-jump="${h.id}">${inline(h.text)}</a></li>`).join('')}</ol></nav>` : '';
  const row = (label, val) => (val ? `<dt>${label}</dt><dd>${val}</dd>` : '');
  const links = (field, cls) => m[field].length && `<div class="tags">${m[field].map(v => filterLink(field, v, cls)).join('')}</div>`;
  const rows = [
    row('対応バージョン', links('versions', 'ver')),
    row('MODローダー', links('loaders', 'loader')),
    row('タグ', links('tags', '')),
    row('作者', esc(m.author || '')),
    row('ダウンロード数', m.downloads ? `${m.downloads.toLocaleString()} <small class="muted">（${esc(m.downloadsAt)} 時点・Modrinth）</small>` : ''),
    row('配布ページ', m.link && `<a href="${esc(safeUrl(m.link))}" target="_blank" rel="noopener">${esc(m.link.replace(/^https?:\/\/(www\.)?/, ''))}</a>`),
  ].join('');
  const showBox = col === 'pages' || rows || m.image;
  return `
    <div class="article${showBox ? '' : ' no-box'}">
      <article class="article-main">
        <h1 class="page-title">${esc(m.name)}</h1>
        ${m.summary ? `<p class="lead">${inline(m.summary)}</p>` : ''}
        ${toc}
        <div class="md">${body}</div>
      </article>
      ${showBox ? `<aside class="infobox">
        <div class="infobox-title">${esc(m.name)}</div>
        ${m.image ? `<img src="${esc(safeUrl(m.image))}" alt="${esc(m.name)}">` : ''}
        <dl>${rows}</dl>
      </aside>` : ''}
    </div>`;
}

// トップページ上部のサイト紹介（サーバー・ブラウザ共通）
const QUICK_TAGS = ['初心者向け', '軽量化', '技術', '魔術', '冒険', 'QoL', 'MODパック', 'リソースパック', 'シェーダー'];

export function homeIntro({ mods, articles, canEdit = true }) {
  const used = new Set(mods.flatMap(m => m.tags));
  const quick = QUICK_TAGS.filter(t => used.has(t));
  return `
    <section class="hero">
      <div class="hero-main">
        <h1 class="hero-title">Minecraft MOD Wiki</h1>
        <p class="hero-sub">マイクラMODを日本語で解説する、だれでも編集できるWiki</p>
        <p class="hero-text">
          Create・JEI・Sodium などの人気MODから、リソースパック・MODパックまで。
          <strong>使い方・導入方法・前提MOD・レシピ・対応バージョン</strong>を、日本語でわかりやすくまとめています。
          ログインは不要で、だれでもページを作ったり直したりできます。
        </p>
        <div class="hero-stats">
          <span><b>${mods.length}</b> MOD</span>
          <span><b>${articles.length}</b> 記事</span>
        </div>
        <div class="btns hero-btns">
          ${canEdit ? `<a class="btn primary" href="${u('/new')}">＋ MODページを作る</a>` : ''}
          <a class="btn" href="${u('/articles')}">📝 まとめ記事を読む</a>
          <a class="btn" href="${u('/help')}">✏️ 書き方を見る</a>
        </div>
        <a class="openchat-banner" href="${esc(OPENCHAT.url)}" target="_blank" rel="noopener">
          <span class="oc-badge">LINE</span>
          <span class="oc-text"><b>オープンチャット「${esc(OPENCHAT.name)}」</b><small>Wikiづくりの相談・MODの質問・雑談はこちら！だれでも参加OK</small></span>
          <span class="oc-go">参加する →</span>
        </a>
      </div>
      <ul class="hero-points">
        <li><span class="hp-icon">🔍</span><div><b>探す</b>バージョン・ローダー・ジャンルで絞り込み。本文まで検索できます。</div></li>
        <li><span class="hp-icon">📖</span><div><b>読む</b>導入方法やよくあるエラー、レシピをMODごとに解説。</div></li>
        <li><span class="hp-icon">✏️</span><div><b>書く</b>だれでも編集OK。履歴が残るので、間違えても元に戻せます。</div></li>
      </ul>
      ${quick.length ? `<div class="hero-tags"><span class="muted small">人気のジャンル:</span>${quick.map(t => filterLink('tags', t)).join('')}</div>` : ''}
    </section>`;
}
