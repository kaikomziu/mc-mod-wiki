// CurseForge / Modrinth のURLから MOD 情報を取ってくる（Modrinth の公開APIを使用）。
// CurseForge の公式APIはキーが必要なため、同じ名前のプロジェクトを Modrinth で探す。
import { VERSIONS, LOADERS } from '../public/tags.js';
import { fetchCurseForgeInfo } from './external.js';

const UA = 'mc-mod-wiki-ja/1.0 (https://kaikomziu.github.io/mc-mod-wiki/)';
const API = 'https://api.modrinth.com/v2';

const TYPE_LABELS = { resourcepack: 'リソースパック', modpack: 'MODパック', datapack: 'データパック', shader: 'シェーダー' };

const CATEGORY_TAGS = {
  technology: '技術', magic: '魔術', adventure: '冒険', worldgen: 'ワールド生成', mobs: 'モブ',
  equipment: '武器・防具', food: '食べ物・農業', decoration: '装飾・建築', storage: 'ストレージ',
  transportation: '輸送・物流', utility: 'ユーティリティ', optimization: '軽量化', library: 'API・前提MOD',
  'game-mechanics': 'QoL', management: 'QoL',
};

async function getJson(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(8000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Modrinth から取得できませんでした（${r.status}）`);
  return r.json();
}

export async function fetchModInfo(rawUrl, env = {}) {
  let u;
  try { u = new URL(String(rawUrl).trim()); } catch { throw new Error('URLの形式が正しくありません。'); }
  const host = u.hostname.replace(/^www\./, '');
  let slug = '';
  let source = '';
  let type = 'mod'; // mod / resourcepack / modpack / datapack / shader
  if (host === 'modrinth.com') {
    const m = u.pathname.match(/^\/(mod|plugin|datapack|shader|resourcepack|modpack)\/([^/]+)/);
    slug = m?.[2] || '';
    type = m?.[1] === 'plugin' ? 'mod' : m?.[1] || 'mod';
    source = 'modrinth';
  } else if (host.endsWith('curseforge.com')) {
    const m = u.pathname.match(/^\/minecraft\/(mc-mods|texture-packs|modpacks|data-packs|shaders)\/([^/]+)/);
    slug = m?.[2] || '';
    type = { 'mc-mods': 'mod', 'texture-packs': 'resourcepack', modpacks: 'modpack', 'data-packs': 'datapack', shaders: 'shader' }[m?.[1]] || 'mod';
    source = 'curseforge';
  }
  if (!slug) throw new Error('CurseForge か Modrinth の MOD・リソースパック・MODパックのページのURLを入れてください。');

  // CurseForge のURLで API キーがあれば、CurseForge から直接取る
  if (source === 'curseforge' && env.CF_API_KEY) {
    const info = await fetchCurseForgeInfo(u, env.CF_API_KEY).catch(() => null);
    if (info) return info;
  }

  let project = await getJson(`${API}/project/${encodeURIComponent(slug)}`);
  let matchedBy = 'url';
  if (!project) {
    const facets = encodeURIComponent(`[["project_type:${type}"]]`);
    const hit = (await getJson(`${API}/search?query=${encodeURIComponent(slug.replace(/-/g, ' '))}&limit=1&facets=${facets}`))?.hits?.[0];
    if (hit) { project = await getJson(`${API}/project/${hit.project_id}`); matchedBy = 'search'; }
  }
  if (!project) throw new Error('Modrinth で見つかりませんでした。CurseForge にしか無いものは、お手数ですが手入力してください。');

  const members = (await getJson(`${API}/project/${project.id}/members`).catch(() => null)) || [];
  const owner = members.find(m => /owner/i.test(m.role)) || members[0];

  const loaders = LOADERS.filter(l => project.loaders?.includes(l.toLowerCase()));
  const versions = VERSIONS.filter(v => project.game_versions?.includes(v));
  const tags = [...new Set([...(project.categories || []), ...(project.additional_categories || [])]
    .map(c => CATEGORY_TAGS[c]).filter(Boolean))];
  const typeTag = TYPE_LABELS[project.project_type];
  if (typeTag) tags.unshift(typeTag);
  if (project.client_side === 'required' && project.server_side === 'unsupported') tags.push('クライアントのみ');
  if (project.client_side === 'unsupported' && project.server_side === 'required') tags.push('サーバー側のみ');

  return {
    source, matchedBy, infoFrom: 'Modrinth',
    modrinthUrl: `https://modrinth.com/${project.project_type || 'mod'}/${project.slug}`,
    sourceUrl: `https://modrinth.com/${project.project_type || 'mod'}/${project.slug}`,
    name: project.title || '',
    summary: project.description || '',
    image: project.icon_url || '',
    author: owner?.user?.username || '',
    link: source === 'curseforge' ? u.href : `https://modrinth.com/${project.project_type || 'mod'}/${project.slug}`,
    versions, loaders, tags,
    downloads: Number(project.downloads) || 0,
    downloadsAt: new Date().toISOString().slice(0, 10),
  };
}
