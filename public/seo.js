// タイトル・説明文・一覧ページの定義（サーバーとブラウザの両方で使う）
import { VERSIONS, LOADERS, TAGS, TYPE_TAGS } from './tags.js';
import { plainText } from './markdown.js';
import { u } from './paths.js';

export const SITE_NAME = 'Minecraft MOD Wiki';
export const SITE_TAGLINE = 'マイクラMOD解説・日本語Wiki';
export const SITE_DESC = 'Minecraft（マインクラフト／マイクラ）のMODを日本語で解説するWiki。人気MODの使い方・導入方法・レシピ・対応バージョン・前提MODを、Forge / NeoForge / Fabric 別にまとめています。だれでも編集できます。';

export const homeTitle = () => `${SITE_NAME}｜${SITE_TAGLINE}`;
export const pageTitle = s => `${s}｜${SITE_NAME}`;
export const modTitle = m => pageTitle(`${m.name}（マイクラMOD）の使い方・導入方法`);
export const articleTitle = a => pageTitle(a.name);
export const articleDescription = a => clip(a.summary || plainText(a.body), 160);
export const ARTICLES_TITLE = pageTitle('まとめ記事・おすすめMOD特集');
export const ARTICLES_DESC = 'マイクラのおすすめMODまとめ、バージョン別・ジャンル別のMOD特集、MODの入れ方ガイドなどの記事一覧です。';

export function modDescription(m) {
  const parts = [
    m.summary ? m.summary.replace(/[。.]$/, '') + '。' : `${m.name}はMinecraftのMODです。`,
    `${m.name}の使い方・導入方法を日本語で解説。`,
    m.versions.length ? `対応バージョン: ${m.versions.join(' / ')}。` : '',
    m.loaders.length ? `${m.loaders.join(' / ')}対応。` : '',
  ];
  return clip(parts.join(''), 160);
}

// /version/1.20.1 ・ /loader/Forge ・ /tag/技術 の一覧ページ
export const LISTS = {
  version: { field: 'versions', all: VERSIONS, label: v => `Minecraft ${v} 対応MOD一覧` },
  loader: { field: 'loaders', all: LOADERS, label: v => `${v} 対応MOD一覧` },
  tag: { field: 'tags', all: TAGS, label: v => (TYPE_TAGS.includes(v) ? `${v}一覧` : `${v}系MOD一覧`.replace('系系', '系')) },
};
export const listTitle = (kind, v) => pageTitle(`${LISTS[kind].label(v)}（マイクラ）`);
export const listDescription = (kind, v, mods) => clip(
  `${LISTS[kind].label(v)}。${mods.slice(0, 6).map(m => m.name).join('、')}${mods.length > 6 ? ' など' : ''}${mods.length}個のMODを、使い方・導入方法つきで日本語解説しています。`, 160);
export const listPath = (kind, v) => u(`/${kind}/${encodeURIComponent(v)}`);

export function clip(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
