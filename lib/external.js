// 外部サイト（Modrinth / CurseForge）の検索と、CurseForge からの情報取得。
// CurseForge は API キーが必要（環境変数 CF_API_KEY）。キーが無ければ CurseForge 部分は使わない。
import { VERSIONS, LOADERS } from '../public/tags.js';

const UA = 'mc-mod-wiki-ja/1.0 (https://kaikomziu.github.io/mc-mod-wiki/)';
const CF_API = 'https://api.curseforge.com/v1';
const MC_GAME_ID = 432;
// CurseForge の種類（classId）
export const CF_CLASSES = { 6: 'mod', 12: 'resourcepack', 4471: 'modpack', 6552: 'shader', 6945: 'datapack' };
const CF_URL_CLASS = { 'mc-mods': 6, 'texture-packs': 12, modpacks: 4471, shaders: 6552, 'data-packs': 6945 };
const TYPE_TAG = { resourcepack: 'リソースパック', modpack: 'MODパック', datapack: 'データパック', shader: 'シェーダー' };
const CF_LOADERS = { 1: 'Forge', 4: 'Fabric', 5: 'Quilt', 6: 'NeoForge' };
// CurseForge のカテゴリ名（英語）→ Wiki のタグ
const CF_CATEGORY_TAGS = [
  [/technology|energy|automation/i, '技術'], [/magic/i, '魔術'], [/adventure|rpg/i, '冒険'],
  [/world ?gen|biomes|structures|dimensions/i, 'ワールド生成'], [/mobs/i, 'モブ'], [/armor|weapons|tools/i, '武器・防具'],
  [/food|farming|agriculture/i, '食べ物・農業'], [/cosmetic|decoration/i, '装飾・建築'], [/storage/i, 'ストレージ'],
  [/transportation|player transport/i, '輸送・物流'], [/utility|qol/i, 'QoL'], [/performance/i, '軽量化'],
  [/api|library/i, 'API・前提MOD'], [/map|information/i, 'マップ'],
];

async function getJson(url, headers = {}) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json', ...headers }, signal: AbortSignal.timeout(8000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`外部サイトから取得できませんでした（${r.status}）`);
  return r.json();
}
// コピー時に入りがちな前後の空白・引用符は取り除く
const cleanKey = k => String(k || '').trim().replace(/^['"]|['"]$/g, '');
const cf = (path, key) => getJson(`${CF_API}${path}`, { 'x-api-key': cleanKey(key) });

async function searchModrinth(q) {
  const facets = encodeURIComponent('[["project_type:mod","project_type:modpack","project_type:resourcepack","project_type:shader","project_type:datapack"]]');
  const res = await getJson(`https://api.modrinth.com/v2/search?query=${encodeURIComponent(q)}&limit=8&facets=${facets}`);
  return (res?.hits || []).map(h => ({
    source: 'modrinth', name: h.title, summary: h.description, icon: h.icon_url || '', downloads: h.downloads || 0,
    author: h.author || '', type: h.project_type, url: `https://modrinth.com/${h.project_type}/${h.slug}`,
  }));
}

async function searchCurseForge(q, key) {
  const res = await cf(`/mods/search?gameId=${MC_GAME_ID}&searchFilter=${encodeURIComponent(q)}&sortField=2&sortOrder=desc&pageSize=20`, key);
  return (res?.data || []).filter(m => CF_CLASSES[m.classId]).slice(0, 8).map(m => ({
    source: 'curseforge', name: m.name, summary: m.summary || '', icon: m.logo?.thumbnailUrl || '', downloads: m.downloadCount || 0,
    author: m.authors?.[0]?.name || '', type: CF_CLASSES[m.classId], url: m.links?.websiteUrl || '',
  }));
}

export async function searchExternal(q, env) {
  const query = String(q || '').trim().slice(0, 80);
  if (!query) return { modrinth: [], curseforge: [], curseforgeEnabled: !!env.CF_API_KEY };
  const [mr, cfr] = await Promise.allSettled([
    searchModrinth(query),
    env.CF_API_KEY ? searchCurseForge(query, env.CF_API_KEY) : Promise.resolve([]),
  ]);
  return {
    modrinth: mr.status === 'fulfilled' ? mr.value : [],
    curseforge: cfr.status === 'fulfilled' ? cfr.value : [],
    curseforgeEnabled: !!env.CF_API_KEY,
    curseforgeError: cfr.status === 'rejected' ? (/403/.test(cfr.reason.message) ? 'forbidden' : 'error') : '',
    errors: [mr, cfr].filter(r => r.status === 'rejected').map(r => r.reason.message),
  };
}

// CurseForge のページURLから情報を取る（キーがあるときだけ）
// 公式の検索APIが使えないキーでも動くよう、IDは cfwidget（公開API）で調べてから公式APIで取得する
async function cfModFromSlug(seg, slug, key) {
  try {
    const res = await cf(`/mods/search?gameId=${MC_GAME_ID}&classId=${CF_URL_CLASS[seg]}&slug=${encodeURIComponent(slug)}`, key);
    if (res?.data?.[0]) return res.data[0];
  } catch { /* 検索の権限がないキー → 下の方法へ */ }
  const w = await getJson(`https://api.cfwidget.com/minecraft/${seg}/${encodeURIComponent(slug)}`).catch(() => null);
  if (!w?.id) return null;
  return (await cf(`/mods/${w.id}`, key))?.data || null;
}

export async function fetchCurseForgeInfo(u, key) {
  const m = u.pathname.match(/^\/minecraft\/(mc-mods|texture-packs|modpacks|data-packs|shaders)\/([^/]+)/);
  if (!m) return null;
  const mod = await cfModFromSlug(m[1], m[2], key);
  if (!mod) return null;
  const files = mod.latestFilesIndexes || [];
  const versions = VERSIONS.filter(v => files.some(f => f.gameVersion === v));
  const loaders = LOADERS.filter(l => files.some(f => CF_LOADERS[f.modLoader] === l));
  const type = CF_CLASSES[mod.classId];
  const tags = [...new Set([
    ...(TYPE_TAG[type] ? [TYPE_TAG[type]] : []),
    ...(mod.categories || []).flatMap(c => CF_CATEGORY_TAGS.filter(([re]) => re.test(c.name)).map(([, t]) => t)),
  ])];
  return {
    source: 'curseforge', matchedBy: 'url', infoFrom: 'CurseForge',
    modrinthUrl: '', sourceUrl: mod.links?.websiteUrl || u.href,
    name: mod.name || '', summary: mod.summary || '', image: mod.logo?.thumbnailUrl || '',
    author: mod.authors?.[0]?.name || '', link: mod.links?.websiteUrl || u.href,
    versions, loaders, tags,
    downloads: Number(mod.downloadCount) || 0,
    downloadsAt: new Date().toISOString().slice(0, 10),
  };
}

// 管理者向け：CurseForge キーの状態チェック（キーそのものは返さない）
export async function curseForgeStatus(env) {
  const key = cleanKey(env.CF_API_KEY);
  if (!key) return { configured: false };
  let apiStatus = 0;
  try {
    const r = await fetch(`${CF_API}/games/${MC_GAME_ID}`, { headers: { 'x-api-key': key, accept: 'application/json', 'user-agent': UA }, signal: AbortSignal.timeout(8000) });
    apiStatus = r.status;
  } catch { apiStatus = -1; }
  return {
    configured: true,
    length: key.length,
    looksLikeCfKey: /^\$2a\$10\$[./A-Za-z0-9]{53}$/.test(key),
    hasSpaces: /\s/.test(key),
    apiStatus,
  };
}
