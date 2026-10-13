// サイトの置き場所と API の場所。
//   本番: GitHub Pages（https://kaikomziu.github.io/mc-mod-wiki/）＋ Supabase Edge Function
//   手元: node serve.js（http://localhost:8080/）
const PROD = {
  site: 'https://kaikomziu.github.io', // サイトのオリジン（canonical や sitemap に使う）
  base: '/mc-mod-wiki', // リポジトリ名のフォルダ
  api: 'https://kifnzvktwbomxthzvvgy.supabase.co/functions/v1/mod-wiki-api',
};

// Deno（Supabase）では location に触るだけで例外になるので try で囲む
let here = null;
try { here = globalThis.location?.hostname ? globalThis.location : null; } catch { /* サーバー側 */ }
const isLocal = !!here && /^(localhost|127\.0\.0\.1)$/.test(here.hostname);
export const config = isLocal ? { site: here.origin, base: '', api: '/api' } : { ...PROD };
export const setConfig = c => Object.assign(config, c);

// サイト内のパス（/mod/xxx など）に置き場所のフォルダを付ける
export const u = path => config.base + path;
// フルURL（canonical・sitemap 用）
export const abs = path => config.site + u(path);
// 表示中のURLからフォルダ部分を外したパス
export const appPath = pathname => (config.base && pathname.startsWith(config.base) ? pathname.slice(config.base.length) || '/' : pathname);

// 公式LINEオープンチャット
export const OPENCHAT = { name: 'マイクラJava MODサイト作ろう！！', url: 'https://line.me/ti/g2/-FZn7f2t2c97E_I3STl4FxaIDHouNX1Lhdf-Uw' };
