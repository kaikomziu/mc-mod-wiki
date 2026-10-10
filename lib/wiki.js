// Wiki API 本体。保存先（store）は Supabase / ローカルファイルのどちらでも動くよう抽象化している。
// store: { get, set, delete, list(prefix), getBlob(key) -> {data, contentType}|null, setBlob(key, data, contentType), imageUrl?(id) }
// 本番は Supabase（supabase/functions/mod-wiki-api）、手元は serve.js のファイル保存で動く。
// 管理者パスワードは ADMIN_NE / ADMIN_CL / ADMIN_CH（環境変数 or Supabase の wiki_kv の config/env）に置く。コードやブラウザには書かない。
import { createHash, createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { VERSIONS, LOADERS, TAGS } from '../public/tags.js';
import { plainText } from '../public/markdown.js';
import { SEED } from './seed.js';
import { fetchModInfo } from './modinfo.js';
import { searchExternal, curseForgeStatus } from './external.js';

const SLUG = /^[a-z0-9][a-z0-9-]{0,49}$/;
const MAX_BODY = 60000;
const MAX_IMAGE = 4_400_000; // 画像の上限（約4MB）
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const EDIT_INTERVAL_MS = 10_000; // 同じ人の連続保存の間隔
const UPLOAD_LIMIT = 15; // 1分あたりのアップロード枚数
const REPORT_INTERVAL_MS = 30_000;
const TOKEN_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000; // 管理者ログインの有効期間（実質ずっと。パスワードを変えると全員ログアウト）
const LOGIN_MAX_FAILS = 10; // この回数失敗すると…
const LOGIN_LOCK_MS = 10 * 60 * 1000; // …この時間ログインできなくなる
const FIELDS = ['name', 'summary', 'versions', 'loaders', 'tags', 'author', 'link', 'image', 'body', 'downloads', 'downloadsAt'];

// MODページとまとめ記事。保存場所のキーだけ違う
export const COLS = {
  pages: { hist: 'history', del: 'deleted', label: 'MOD' },
  articles: { hist: 'ahistory', del: 'adeleted', label: '記事' },
};

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
});
const fail = (status, error, extra) => json({ error, ...extra }, status);
const pad = n => String(n).padStart(6, '0');
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const pick = (arr, allowed) => (Array.isArray(arr) ? allowed.filter(a => arr.includes(a)) : []);
const url = v => { const s = str(v, 400); return /^https?:\/\/\S+$/i.test(s) || /^\/img\/[a-z0-9]+\.(png|jpg|webp|gif)$/.test(s) ? s : ''; };
const sha = s => createHash('sha256').update(s).digest();
const now = () => new Date().toISOString();

/* ---------- 管理者認証 ---------- */
function adminConfig(env) {
  const { ADMIN_NE: ne, ADMIN_CL: cl, ADMIN_CH: ch } = env;
  if (!ne || !cl || !ch) return null;
  return { ne, cl, ch, key: sha(`modwiki-admin|${ne}|${cl}|${ch}`) };
}
const safeEq = (a, b) => timingSafeEqual(sha(String(a)), sha(String(b)));
// 前後の空白・大文字小文字は無視。環境変数はカンマ区切りで複数の正解を書ける（例: abc,abd）
const norm = s => String(s ?? '').trim().toLowerCase();
const match = (input, expected) => expected.split(',').map(norm).filter(Boolean)
  .map(e => safeEq(norm(input), e)).some(Boolean);
const sign = (key, exp) => createHmac('sha256', key).update(`admin:${exp}`).digest('hex');

function verifyToken(token, cfg) {
  if (!cfg || !token) return false;
  const [exp, sig] = String(token).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEq(sig, sign(cfg.key, exp));
}

/* ---------- ページ ---------- */
function clean(input, col) {
  const data = {
    name: str(input.name, 80),
    summary: str(input.summary, 200),
    versions: pick(input.versions, VERSIONS),
    loaders: pick(input.loaders, LOADERS),
    tags: pick(input.tags, TAGS),
    author: str(input.author, 80),
    link: url(input.link),
    image: url(input.image),
    body: typeof input.body === 'string' ? input.body.replace(/\r\n?/g, '\n').slice(0, MAX_BODY) : '',
    downloads: Math.max(0, Math.floor(Number(input.downloads) || 0)),
    downloadsAt: /^\d{4}-\d{2}-\d{2}$/.test(input.downloadsAt || '') ? input.downloadsAt : '',
  };
  if (col === 'articles') Object.assign(data, { author: '', link: '', downloads: 0, downloadsAt: '' });
  if (!data.downloads) data.downloadsAt = '';
  return data;
}

const sameContent = (a, b) => FIELDS.every(f => JSON.stringify(a[f] ?? '') === JSON.stringify(b[f] ?? ''));

// 管理者以外には編集者の識別子（ipHash）を見せない
function scrub(obj, isAdmin) {
  if (isAdmin || !obj) return obj;
  if (Array.isArray(obj)) return obj.map(o => scrub(o, false));
  const { ipHash, ...rest } = obj;
  if (rest.log) rest.log = rest.log.map(({ ipHash: _, ...e }) => e);
  return rest;
}

function listItem(p) {
  const { body, log, ...rest } = p;
  return rest;
}

async function loadAll(store, col) {
  const keys = await store.list(`${col}/`);
  return (await Promise.all(keys.map(k => store.get(k)))).filter(Boolean);
}

async function addRecent(store, item) {
  const recent = (await store.get('meta/recent')) || [];
  recent.unshift(item);
  await store.set('meta/recent', recent.slice(0, 100));
}

async function savePage(store, col, slug, data, { user, comment, baseRev, ipHash = '', admin = false }) {
  const C = COLS[col];
  const cur = await store.get(`${col}/${slug}`);
  const curRev = cur?.rev || 0;
  if (baseRev !== curRev) return fail(409, '他の人が先にこのページを更新しました。', { current: cur });
  if (cur && sameContent(cur, data)) return fail(400, '変更点がありません。');
  if (!cur && (await store.get(`${C.del}/${slug}`))) return fail(409, 'このページIDは削除済みのページで使われています。別のIDにしてください。');

  const at = now();
  const rev = curRev + 1;
  const entry = { rev, user, comment, at, size: data.body.length, delta: data.body.length - (cur?.body.length || 0), admin, ipHash };
  await store.set(`${C.hist}/${slug}/${pad(rev)}`, { slug, ...data, ...entry });
  const page = {
    slug, ...data, rev, locked: cur?.locked || false,
    createdAt: cur?.createdAt || at, createdBy: cur?.createdBy || user,
    updatedAt: at, updatedBy: user,
    log: [entry, ...(cur?.log || [])].slice(0, 1000),
  };
  await store.set(`${col}/${slug}`, page);
  await addRecent(store, { col, slug, name: data.name, isNew: !cur, ...entry });
  return json(page, cur ? 200 : 201);
}

async function ensureSeed(store) {
  if (await store.get('meta/seeded')) return;
  for (const s of SEED) {
    if (!(await store.get(`pages/${s.slug}`))) {
      await savePage(store, 'pages', s.slug, clean(s, 'pages'), { user: 'システム', comment: '初版', baseRev: 0 });
    }
  }
  await store.set('meta/seeded', { at: now() });
}

async function readJson(req) {
  const raw = await req.text();
  if (raw.length > MAX_BODY * 2) throw Object.assign(new Error('内容が大きすぎます。'), { status: 413 });
  try { return JSON.parse(raw || '{}'); } catch { throw Object.assign(new Error('不正なリクエストです。'), { status: 400 }); }
}

/* ---------- 検索 ---------- */
async function search(store, q) {
  const words = norm(q).split(/\s+/).filter(Boolean).slice(0, 5);
  if (!words.length) return [];
  const [pages, articles] = await Promise.all([loadAll(store, 'pages'), loadAll(store, 'articles')]);
  const results = [];
  for (const [col, list] of [['pages', pages], ['articles', articles]]) {
    for (const p of list) {
      const text = plainText(p.body);
      const fields = { name: norm(p.name), summary: norm(p.summary), tags: norm([...p.tags, ...p.versions, ...p.loaders, p.author].join(' ')), body: norm(text) };
      let score = 0;
      for (const w of words) {
        const s = (fields.name.includes(w) ? 10 : 0) + (fields.tags.includes(w) ? 4 : 0)
          + (fields.summary.includes(w) ? 3 : 0) + (fields.body.includes(w) ? 1 : 0);
        if (!s) { score = 0; break; } // すべての単語を含むものだけ
        score += s + (fields.name === w ? 20 : 0);
      }
      if (!score) continue;
      const lower = text.toLowerCase();
      const at = Math.max(0, lower.indexOf(words[0]));
      const start = Math.max(0, at - 40);
      const snippet = (start ? '…' : '') + text.slice(start, start + 140) + (text.length > start + 140 ? '…' : '');
      results.push({ col, slug: p.slug, name: p.name, summary: p.summary, snippet, score, tags: p.tags, versions: p.versions });
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, 50);
}

/* ---------- ルーティング ---------- */
export async function handle(req, store, { ip = '', env = {} } = {}) {
  const u = new URL(req.url);
  const M = req.method;

  // 画像の配信（/img/xxxx.webp）
  if (u.pathname.startsWith('/img/')) {
    const id = u.pathname.slice(5);
    if (!/^[a-z0-9]+\.(png|jpg|webp|gif)$/.test(id)) return new Response('Not found', { status: 404 });
    const blob = await store.getBlob(`img/${id}`);
    if (!blob) return new Response('Not found', { status: 404 });
    return new Response(blob.data, {
      headers: { 'content-type': blob.contentType, 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' },
    });
  }

  const parts = u.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const cfg = adminConfig(env);
  const isAdmin = verifyToken(req.headers.get('x-admin-token'), cfg);
  const ipHash = createHmac('sha256', 'modwiki-ip-v1').update(ip || 'unknown').digest('hex').slice(0, 16);
  const adminOnly = () => (isAdmin ? null : fail(403, '管理者のみの操作です。'));

  // 編集できるかどうか（サイト停止・ブロック）
  const editBlocked = async settings => {
    if (isAdmin) return null;
    if (settings.editLocked) return fail(403, '現在、サイト全体の編集が停止されています。');
    const bans = (await store.get('meta/bans')) || {};
    if (bans[ipHash]) return fail(403, 'あなたは編集できません（管理者によりブロックされています）。');
    return null;
  };
  const throttle = async (name, ms) => {
    if (isAdmin) return null;
    const last = await store.get(`ratelimit/${name}/${ipHash}`);
    if (last && Date.now() - last.t < ms) return fail(429, '連続して操作しています。少し待ってからもう一度お試しください。');
    return null;
  };
  const markThrottle = name => (isAdmin ? null : store.set(`ratelimit/${name}/${ipHash}`, { t: Date.now() }));

  try {
    await ensureSeed(store);
    const settings = (await store.get('meta/settings')) || { editLocked: false };

    /* ----- 公開設定 ----- */
    if (M === 'GET' && parts[0] === 'settings') {
      const openReports = isAdmin ? ((await store.get('meta/reports')) || []).length : 0;
      return json({ editLocked: !!settings.editLocked, isAdmin, openReports });
    }

    /* ----- 検索 ----- */
    if (M === 'GET' && parts[0] === 'search') return json(await search(store, u.searchParams.get('q') || ''));

    /* ----- 外部サイト（Modrinth / CurseForge）の検索 ----- */
    if (M === 'GET' && parts[0] === 'external') return json(await searchExternal(u.searchParams.get('q'), env));

    /* ----- 配布ページから情報を取得 ----- */
    if (M === 'GET' && parts[0] === 'modinfo') {
      const blocked = await editBlocked(settings);
      if (blocked) return blocked;
      try { return json(await fetchModInfo(u.searchParams.get('url') || '', env)); } catch (e) { return fail(400, e.message); }
    }

    /* ----- 画像アップロード ----- */
    if (M === 'POST' && parts[0] === 'images') {
      const blocked = await editBlocked(settings);
      if (blocked) return blocked;
      const upKey = `ratelimit/upload2/${ipHash}`;
      const win = (!isAdmin && (await store.get(upKey))) || { t: Date.now(), n: 0 };
      if (Date.now() - win.t > 60_000) Object.assign(win, { t: Date.now(), n: 0 });
      if (!isAdmin && win.n >= UPLOAD_LIMIT) return fail(429, '短い時間にたくさんアップロードしています。1分ほど待ってください。');
      const type = (req.headers.get('content-type') || '').split(';')[0].trim();
      const ext = IMAGE_TYPES[type];
      if (!ext) return fail(415, 'PNG / JPEG / WebP / GIF の画像を選んでください。');
      const data = await req.arrayBuffer();
      if (!data.byteLength) return fail(400, '画像が空です。');
      if (data.byteLength > MAX_IMAGE) return fail(413, '画像が大きすぎます（4MBまで）。');
      const wantId = isAdmin ? str(u.searchParams.get('id'), 40) : ''; // 移行用：管理者は元のIDのまま上げ直せる
      const id = /^[a-z0-9]+\.(png|jpg|webp|gif)$/.test(wantId) && wantId.endsWith(`.${ext}`) ? wantId : `${randomBytes(9).toString('hex')}.${ext}`;
      await store.setBlob(`img/${id}`, data, type);
      const list = (await store.get('meta/images')) || [];
      const imgUrl = store.imageUrl ? store.imageUrl(id) : `/img/${id}`;
      list.unshift({ id, url: imgUrl, at: now(), size: data.byteLength, user: str(u.searchParams.get('user'), 24), ipHash });
      await store.set('meta/images', list.slice(0, 300));
      if (!isAdmin) { win.n++; await store.set(upKey, win); }
      return json({ url: imgUrl }, 201);
    }

    /* ----- 通報 ----- */
    if (M === 'POST' && parts[0] === 'report') {
      const t = await throttle('report', REPORT_INTERVAL_MS);
      if (t) return t;
      const input = await readJson(req);
      if (input.website) return fail(400, '不正なリクエストです。');
      const col = COLS[input.col] ? input.col : 'pages';
      const slug = str(input.slug, 50);
      if (!SLUG.test(slug)) return fail(400, '対象が不正です。');
      const reason = str(input.reason, 30);
      if (!reason) return fail(400, '理由を選んでください。');
      const page = await store.get(`${col}/${slug}`);
      const reports = (await store.get('meta/reports')) || [];
      reports.unshift({
        id: randomBytes(6).toString('hex'), at: now(), col, slug, name: page?.name || slug, rev: page?.rev || 0,
        reason, comment: str(input.comment, 500), user: str(input.user, 24), ipHash,
      });
      await store.set('meta/reports', reports.slice(0, 300));
      await markThrottle('report');
      return json({ ok: true }, 201);
    }

    /* ----- 管理者 ----- */
    if (parts[0] === 'admin') {
      if (M === 'POST' && parts[1] === 'login') {
        if (!cfg) return fail(503, '管理者が設定されていません。');
        const failKey = `loginfail-v2/${ipHash}`;
        const f = (await store.get(failKey)) || { count: 0, since: Date.now() };
        if (Date.now() - f.since > LOGIN_LOCK_MS) Object.assign(f, { count: 0, since: Date.now() });
        if (f.count >= LOGIN_MAX_FAILS) {
          const min = Math.ceil((f.since + LOGIN_LOCK_MS - Date.now()) / 60000);
          return fail(429, `ログインの失敗が続いたため、あと${min}分ほど待ってください。`);
        }
        const input = await readJson(req);
        const ok = [match(input.ne, cfg.ne), match(input.cl, cfg.cl), match(input.ch, cfg.ch)].every(Boolean);
        if (!ok) {
          f.count++;
          await store.set(failKey, f);
          return fail(401, `入力が違います。（あと${LOGIN_MAX_FAILS - f.count}回まで）`);
        }
        await store.delete(failKey);
        const exp = Date.now() + TOKEN_TTL_MS;
        return json({ token: `${exp}.${sign(cfg.key, exp)}`, exp });
      }
      const denied = adminOnly();
      if (denied) return denied;

      if (M === 'GET' && parts[1] === 'state') {
        const deleted = [];
        const locked = [];
        for (const [col, C] of Object.entries(COLS)) {
          const [dk, all] = await Promise.all([store.list(`${C.del}/`), loadAll(store, col)]);
          for (const p of (await Promise.all(dk.map(k => store.get(k)))).filter(Boolean)) {
            deleted.push({ col, slug: p.slug, name: p.name, deletedAt: p.deletedAt });
          }
          for (const p of all.filter(x => x.locked)) locked.push({ col, slug: p.slug, name: p.name });
        }
        return json({
          settings, deleted, locked,
          bans: (await store.get('meta/bans')) || {},
          reports: (await store.get('meta/reports')) || [],
          images: ((await store.get('meta/images')) || []).slice(0, 60),
        });
      }
      if (M === 'GET' && parts[1] === 'cf-status') return json(await curseForgeStatus(env));
      // 移行用：{ entries: { key: value } } をそのまま保存（設定キーは対象外）
      if (M === 'POST' && parts[1] === 'import') {
        const raw = await req.text();
        if (raw.length > 4_000_000) return fail(413, '大きすぎます。分けて送ってください。');
        const { entries } = JSON.parse(raw);
        const keys = Object.keys(entries || {});
        if (keys.some(k => !/^(pages|articles|history|ahistory|deleted|adeleted|meta)\//.test(k))) return fail(400, '取り込めないキーがあります。');
        for (const k of keys) await store.set(k, entries[k]);
        return json({ imported: keys.length });
      }
      if (M === 'POST' && parts[1] === 'settings') {
        const input = await readJson(req);
        const next = { ...settings, editLocked: !!input.editLocked };
        await store.set('meta/settings', next);
        return json(next);
      }
      if (M === 'POST' && (parts[1] === 'ban' || parts[1] === 'unban')) {
        const input = await readJson(req);
        const target = str(input.ipHash, 32);
        if (!/^[0-9a-f]{16}$/.test(target)) return fail(400, '対象が不正です。');
        const bans = (await store.get('meta/bans')) || {};
        if (parts[1] === 'ban') bans[target] = { user: str(input.user, 24), reason: str(input.reason, 120), at: now() };
        else delete bans[target];
        await store.set('meta/bans', bans);
        return json(bans);
      }
      if (M === 'POST' && parts[1] === 'resolve-report') {
        const input = await readJson(req);
        const reports = ((await store.get('meta/reports')) || []).filter(r => r.id !== input.id);
        await store.set('meta/reports', reports);
        return json({ ok: true });
      }
      if (M === 'POST' && parts[1] === 'delete-image') {
        const input = await readJson(req);
        const id = str(input.id, 40);
        if (!/^[a-z0-9]+\.(png|jpg|webp|gif)$/.test(id)) return fail(400, '対象が不正です。');
        await store.delete(`img/${id}`);
        await store.set('meta/images', ((await store.get('meta/images')) || []).filter(i => i.id !== id));
        return json({ ok: true });
      }
      return fail(404, 'Not found');
    }

    /* ----- 静的ページ作成用：公開中のページ全部（本文つき・履歴や識別子は除く） ----- */
    if (M === 'GET' && parts[0] === 'export') {
      const strip = ({ log, ipHash: _, ...p }) => p;
      const [pages, articles] = await Promise.all([loadAll(store, 'pages'), loadAll(store, 'articles')]);
      return json({ pages: pages.map(strip), articles: articles.map(strip), at: now() });
    }

    /* ----- 一覧・最近の更新 ----- */
    if (M === 'GET' && parts[0] === 'recent') {
      return json(scrub((await store.get('meta/recent')) || [], isAdmin));
    }
    const col = parts[0];
    if (!COLS[col]) return fail(404, 'Not found');
    const C = COLS[col];
    if (M === 'GET' && parts.length === 1) return json((await loadAll(store, col)).map(listItem));
    if (!SLUG.test(parts[1] || '')) return fail(404, 'Not found');
    const slug = parts[1];
    const pageKey = `${col}/${slug}`;

    /* ----- 個別ページ ----- */
    if (M === 'GET' && parts.length === 2) {
      const page = await store.get(pageKey);
      if (page) return json(scrub(page, isAdmin));
      const del = await store.get(`${C.del}/${slug}`);
      return fail(404, del ? 'このページは管理者によって削除されました。' : 'ページがありません。', { deleted: !!del });
    }
    if (M === 'GET' && parts[2] === 'history' && parts.length === 4) {
      const snap = await store.get(`${C.hist}/${slug}/${pad(parseInt(parts[3], 10) || 0)}`);
      return snap ? json(scrub(snap, isAdmin)) : fail(404, 'その版はありません。');
    }

    if (M === 'PUT' && parts.length === 2) {
      const input = await readJson(req);
      if (input.website) return fail(400, '不正なリクエストです。'); // ボット避け（隠しフィールド）
      const blocked = await editBlocked(settings);
      if (blocked) return blocked;
      if (!isAdmin && (await store.get(pageKey))?.locked) return fail(403, 'このページはロックされているため、管理者しか編集できません。');
      const user = str(input.user, 24);
      if (!user) return fail(400, 'ユーザー名を入力してください。');
      const data = clean(input, col);
      if (!data.name) return fail(400, col === 'articles' ? '記事のタイトルを入力してください。' : 'MOD名を入力してください。');
      const t = await throttle('edit', EDIT_INTERVAL_MS);
      if (t) return t;
      const res = await savePage(store, col, slug, data, {
        user, comment: str(input.comment, 120), baseRev: Number(input.baseRev) || 0, ipHash, admin: isAdmin,
      });
      if (res.ok) await markThrottle('edit');
      return res;
    }

    /* ----- 管理者のページ操作 ----- */
    const denied = adminOnly();
    if (denied) return denied;

    if (M === 'POST' && parts[2] === 'lock') {
      const page = await store.get(pageKey);
      if (!page) return fail(404, 'ページがありません。');
      const input = await readJson(req);
      page.locked = !!input.locked;
      await store.set(pageKey, page);
      await addRecent(store, { col, slug, name: page.name, action: page.locked ? 'lock' : 'unlock', user: '管理者', at: now(), admin: true });
      return json(page);
    }
    if (M === 'DELETE' && parts.length === 2) {
      const page = await store.get(pageKey);
      if (!page) return fail(404, 'ページがありません。');
      await store.set(`${C.del}/${slug}`, { ...page, deletedAt: now() });
      await store.delete(pageKey);
      await addRecent(store, { col, slug, name: page.name, action: 'delete', user: '管理者', at: now(), admin: true });
      return json({ ok: true });
    }
    if (M === 'POST' && parts[2] === 'restore') {
      const del = await store.get(`${C.del}/${slug}`);
      if (!del) return fail(404, '削除済みページがありません。');
      if (await store.get(pageKey)) return fail(409, '同じIDのページが既にあります。');
      const { deletedAt, ...page } = del;
      await store.set(pageKey, page);
      await store.delete(`${C.del}/${slug}`);
      await addRecent(store, { col, slug, name: page.name, action: 'restore', user: '管理者', at: now(), admin: true });
      return json(page);
    }
    return fail(404, 'Not found');
  } catch (e) {
    if (e.status) return fail(e.status, e.message);
    console.error(e);
    return fail(500, 'サーバーエラーが発生しました。');
  }
}
