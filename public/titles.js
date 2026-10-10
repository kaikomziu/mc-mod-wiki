// 肩書き（名前の横に【〇〇】と出る）。条件を満たすと自動で手に入り、持っている中から2つまで選んで表示できる。
// 管理者が付ける特別な肩書きは「g:テキスト」という id で扱う。（サーバーとブラウザの両方で使う）
//   s = { created, articles, edits, likesReceived, liked, followers, createdAt, granted }
export const MAX_TITLES = 2;

export const TITLES = [
  { id: 'newbie', name: '新人', desc: 'アカウントを作った', need: () => true },
  { id: 'pioneer', name: '古参', desc: '2026年11月までにアカウントを作った', need: s => s.createdAt < '2026-11-30T15:00:00.000Z' },
  { id: 'first-step', name: 'はじめての一歩', desc: 'MODページか記事を1つ作った', need: s => s.created >= 1 },
  { id: 'crafter', name: 'MOD職人', desc: 'MODページか記事を5つ作った', need: s => s.created >= 5 },
  { id: 'doctor', name: 'MOD博士', desc: 'MODページか記事を15作った', need: s => s.created >= 15 },
  { id: 'writer', name: 'ライター', desc: '記事を1つ書いた', need: s => s.articles >= 1 },
  { id: 'editor', name: '編集者', desc: '10回編集した', need: s => s.edits >= 10 },
  { id: 'master-editor', name: '名編集者', desc: '50回編集した', need: s => s.edits >= 50 },
  { id: 'liked', name: 'いいね獲得', desc: 'いいねを1つもらった', need: s => s.likesReceived >= 1 },
  { id: 'popular', name: '人気者', desc: 'いいねを10もらった', need: s => s.likesReceived >= 10 },
  { id: 'supporter', name: '応援団', desc: '5つのページにいいねした', need: s => s.liked >= 5 },
  { id: 'notable', name: '注目の人', desc: 'フォロワーが5人になった', need: s => s.followers >= 5 },
];

export const titleLabel = id => (String(id).startsWith('g:') ? String(id).slice(2) : TITLES.find(t => t.id === id)?.name || '');

// 持っている肩書きの id 一覧
export function ownedTitles(s) {
  return [...TITLES.filter(t => t.need(s)).map(t => t.id), ...(s.granted || []).map(g => `g:${g}`)];
}
