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
import { signup, login, sessionAccount, guestHash, claimGuest, reassign, profile, publicAccount, nameKey, updateProfile } from './accounts.js';
import { likeState, setLike, likeCounts, setFollow, followingOf, followersOf, briefAccounts, likedBy } from './social.js';
import { ownedTitles, titleLabel, MAX_TITLES } from '../public/titles.js';

const SLUG = /^[a-z0-9][a-z0-9-]{0,49}$/;
const MAX_BODY = 60000;
const MAX_IMAGE = 4_400_000; // 画像の上限（約4MB）
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const EDIT_INTERVAL_MS = 10_000; // 同じ人の連続保存の間隔
const UPLOAD_LIMIT = 15; // 1分あたりのアップロード枚数
const REPORT_INTERVAL_MS = 30_000;
const COMMENT_INTERVAL_MS = 15_000;
const CONTACT_INTERVAL_MS = 60_000;
const CONTACT_TYPES = ['質問', '要望・アイデア', '不具合の報告', '削除・修正の依頼', 'その他'];
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

// 古いデータに無い項目（ダウンロード数など）は「空」とみなして比べる
const fieldVal = (o, f) => (f === 'downloads' ? Number(o[f]) || 0 : o[f] ?? '');
const sameContent = (a, b) => FIELDS.every(f => JSON.stringify(fieldVal(a, f)) === JSON.stringify(fieldVal(b, f)));

// ゲストIDのハッシュは管理者にも見せない（見えると他人の分を名乗れてしまうため）
function hideGuest(o) {
  if (!o || typeof o !== 'object') return o;
  const { guest, createdGuest, ...rest } = o;
  if (rest.log) rest.log = rest.log.map(({ guest: _, ...e }) => e);
  return rest;
}

// 管理者以外には編集者の識別子（ipHash）を見せない
function scrub(obj, isAdmin) {
  if (!obj) return obj;
  if (isAdmin) return Array.isArray(obj) ? obj.map(hideGuest) : hideGuest(obj);
  if (Array.isArray(obj)) return obj.map(o => scrub(o, false));
  const { ipHash, guest, createdGuest, ...rest } = obj;
  if (rest.log) rest.log = rest.log.map(({ ipHash: _, guest: __, ...e }) => e);
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

async function savePage(store, col, slug, data, { user, comment, baseRev, ipHash = '', admin = false, uid = '', guest = '', commentsAccountOnly }) {
  const C = COLS[col];
  const cur = await store.get(`${col}/${slug}`);
  const curRev = cur?.rev || 0;
  if (baseRev !== curRev) return fail(409, '他の人が先にこのページを更新しました。', { current: cur });
  if (cur && sameContent(cur, data)) return fail(400, '変更点がありません。');
  if (!cur && (await store.get(`${C.del}/${slug}`))) return fail(409, 'このページIDは削除済みのページで使われています。別のIDにしてください。');

  const at = now();
  const rev = curRev + 1;
  const entry = { rev, user, comment, at, size: data.body.length, delta: data.body.length - (cur?.body.length || 0), admin, ipHash, ...(uid ? { uid } : {}), ...(guest && !uid ? { guest } : {}) };
  await store.set(`${C.hist}/${slug}/${pad(rev)}`, { slug, ...data, ...entry });
  const page = {
    slug, ...data, rev, locked: cur?.locked || false,
    commentsAccountOnly: commentsAccountOnly ?? !!cur?.commentsAccountOnly,
    createdAt: cur?.createdAt || at, createdBy: cur?.createdBy || user,
    ...(cur ? { createdUid: cur.createdUid, createdGuest: cur.createdGuest } : uid ? { createdUid: uid } : guest ? { createdGuest: guest } : {}),
    updatedAt: at, updatedBy: user,
    log: [entry, ...(cur?.log || [])].slice(0, 1000),
  };
  await store.set(`${col}/${slug}`, page);
  await addRecent(store, { col, slug, name: data.name, isNew: !cur, ...entry });
  return json(hideGuest(page), cur ? 200 : 201);
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

/* ---------- プロフィールの数字・肩書き ---------- */
async function userStats(store, account) {
  const prof = await profile(store, account.name);
  const [followers, following, liked] = await Promise.all([followersOf(store, account.uid), followingOf(store, account.uid), likedBy(store, account.uid)]);
  let likesReceived = 0;
  for (const c of prof.created) likesReceived += (await likeState(store, c.col, c.slug)).likes;
  const stats = {
    created: prof.created.length, articles: prof.created.filter(c => c.col === 'articles').length,
    edits: prof.editCount, likesReceived, liked: liked.length, followers: followers.length,
    createdAt: account.createdAt, granted: account.granted || [],
  };
  return { prof, stats, followers, following, liked, owned: ownedTitles(stats) };
}
// 表示用：選んでいる肩書きの文字
const titleLabels = a => (a?.titles || []).map(titleLabel).filter(Boolean);

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
  const gh = guestHash(req.headers.get('x-guest-id'));
  let account = null; // ログイン中のアカウント（try の中で読む）

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
    account = await sessionAccount(store, req.headers.get('x-session'));

    /* ----- 公開設定 ----- */
    if (M === 'GET' && parts[0] === 'settings') {
      const openReports = isAdmin ? ((await store.get('meta/reports')) || []).length : 0;
      const openContacts = isAdmin ? ((await store.get('meta/contacts')) || []).filter(c => !c.done).length : 0;
      return json({ editLocked: !!settings.editLocked, isAdmin, openReports, openContacts, account: account ? { ...publicAccount(account), titleLabels: titleLabels(account), email: account.email || '', following: await followingOf(store, account.uid) } : null });
    }

    /* ----- お知らせ（書き換えは管理者のみ） ----- */
    if (M === 'GET' && parts[0] === 'news') return json((await store.get('meta/news')) || []);

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
    // 運営へのお問い合わせ（管理画面でだけ見られる）
    if (M === 'POST' && parts[0] === 'contact') {
      const input = await readJson(req);
      if (input.website) return fail(400, '不正なリクエストです。');
      const bans = (await store.get('meta/bans')) || {};
      if (bans[ipHash] && !isAdmin) return fail(403, '送信できません（管理者によりブロックされています）。');
      const message = typeof input.message === 'string' ? input.message.replace(/\r\n?/g, '\n').trim().slice(0, 3000) : '';
      if (message.length < 5) return fail(400, 'お問い合わせ内容を5文字以上で入力してください。');
      const type = CONTACT_TYPES.includes(input.type) ? input.type : 'その他';
      const reply = str(input.reply, 120);
      const t = await throttle('contact', CONTACT_INTERVAL_MS);
      if (t) return t;
      const contacts = (await store.get('meta/contacts')) || [];
      contacts.unshift({
        id: randomBytes(6).toString('hex'), at: now(), type, message, reply,
        user: account ? account.name : str(input.user, 24), ...(account ? { uid: account.uid } : {}), page: str(input.page, 200), ipHash,
      });
      await store.set('meta/contacts', contacts.slice(0, 500));
      await markThrottle('contact');
      return json({ ok: true }, 201);
    }

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

    /* ----- アカウント ----- */
    if (M === 'POST' && parts[0] === 'account' && (parts[1] === 'signup' || parts[1] === 'login')) {
      const failKey = `acctfail/${ipHash}`;
      const f = (await store.get(failKey)) || { count: 0, since: Date.now() };
      if (Date.now() - f.since > LOGIN_LOCK_MS) Object.assign(f, { count: 0, since: Date.now() });
      if (f.count >= LOGIN_MAX_FAILS) return fail(429, '失敗が続いたため、しばらく待ってからもう一度お試しください。');
      const input = await readJson(req);
      if (input.website) return fail(400, '不正なリクエストです。');
      try {
        const { account: acc, token } = parts[1] === 'signup' ? await signup(store, input) : await login(store, input);
        const claimed = await claimGuest(store, acc, gh); // このブラウザでゲストとして作ったものを自分のものに
        return json({ token, account: publicAccount(acc), claimed });
      } catch (e) {
        if (e.status === 401 || parts[1] === 'signup') { f.count++; await store.set(failKey, f); }
        throw e;
      }
    }
    if (M === 'POST' && parts[0] === 'account' && parts[1] === 'claim') {
      if (!account) return fail(401, 'ログインしてください。');
      return json({ claimed: await claimGuest(store, account, gh) });
    }
    if (M === 'POST' && parts[0] === 'account' && parts[1] === 'profile') {
      if (!account) return fail(401, 'ログインしてください。');
      const input = await readJson(req);
      return json(await updateProfile(store, account, input));
    }
    if (M === 'GET' && parts[0] === 'users' && !parts[1]) {
      const keys = await store.list('accounts/');
      const all = (await Promise.all(keys.map(k => store.get(k)))).filter(Boolean);
      return json(all.map(a => ({ uid: a.uid, name: a.name, avatar: a.avatar || '', titles: titleLabels(a) })));
    }
    // 表示する肩書きを選ぶ（持っている中から2つまで）
    if (M === 'POST' && parts[0] === 'account' && parts[1] === 'titles') {
      if (!account) return fail(401, 'ログインしてください。');
      const input = await readJson(req);
      const want = [...new Set(Array.isArray(input.titles) ? input.titles.map(String) : [])];
      if (want.length > MAX_TITLES) return fail(400, `肩書きは${MAX_TITLES}つまで選べます。`);
      const { owned } = await userStats(store, account);
      if (want.some(t => !owned.includes(t))) return fail(400, 'まだ持っていない肩書きがあります。');
      account.titles = want;
      await store.set(`accounts/${account.uid}`, account);
      return json({ titles: want, titleLabels: titleLabels(account) });
    }
    if (parts[0] === 'users' && parts[1]) {
      const ref = await store.get(nameKey(parts[1]));
      const target = ref && (await store.get(`accounts/${ref.uid}`));
      if (!target) return fail(404, 'そのユーザーはいません。');
      // フォローする／やめる
      if (M === 'POST' && parts[2] === 'follow') {
        if (!account) return fail(401, 'フォローするにはログインしてください。');
        const input = await readJson(req);
        return json(await setFollow(store, account, target, !!input.follow));
      }
      // フォロー・フォロワーの一覧
      if (M === 'GET' && (parts[2] === 'followers' || parts[2] === 'following')) {
        const uids = parts[2] === 'followers' ? await followersOf(store, target.uid) : await followingOf(store, target.uid);
        return json(await briefAccounts(store, uids.slice(-500).reverse()));
      }
      if (M === 'GET' && parts.length === 2) {
        const { prof, stats, followers, following, liked, owned } = await userStats(store, target);
        const likesReceived = stats.likesReceived;
        const likedPages = [];
        for (const i of liked.slice(0, 50)) {
          const pg = await store.get(`${i.col}/${i.slug}`);
          if (pg) likedPages.push({ col: i.col, slug: i.slug, name: pg.name, at: i.at });
        }
        return json({
          ...prof, likesReceived, liked: likedPages,
          followers: followers.length, following: following.length,
          isFollowing: !!account && followers.includes(account.uid),
          titleLabels: titleLabels(target), owned, stats,
        });
      }
      return fail(404, 'Not found');
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
          contacts: (await store.get('meta/contacts')) || [],
          images: ((await store.get('meta/images')) || []).slice(0, 60),
        });
      }
      // ユーザー一覧（メールアドレスなど管理者だけが見られる項目も含む）
      if (M === 'GET' && parts[1] === 'users') {
        const accounts = (await Promise.all((await store.list('accounts/')).map(k => store.get(k)))).filter(Boolean);
        const count = {};
        for (const col of Object.keys(COLS)) {
          for (const p of await loadAll(store, col)) {
            if (p.createdUid) (count[p.createdUid] ||= { created: 0, edits: 0 }).created++;
            for (const e of p.log || []) if (e.uid) (count[e.uid] ||= { created: 0, edits: 0 }).edits++;
          }
        }
        return json(accounts.map(a => ({
          uid: a.uid, name: a.name, avatar: a.avatar || '', email: a.email || '', createdAt: a.createdAt,
          titles: titleLabels(a), granted: a.granted || [], bio: (a.bio || '').slice(0, 80),
          created: count[a.uid]?.created || 0, edits: count[a.uid]?.edits || 0,
        })).sort((x, y) => (y.createdAt || '').localeCompare(x.createdAt || '')));
      }
      // バックアップ：データベースの中身をまるごとJSONで返す（秘密の設定・回数制限の記録は除く）
      if (M === 'GET' && parts[1] === 'backup') {
        const skip = /^(config|ratelimit|acctfail|loginfail[^/]*)\//;
        const keys = (await store.list('')).filter(k => !skip.test(k));
        const values = await Promise.all(keys.map(k => store.get(k)));
        const entries = {};
        const counts = {};
        keys.forEach((k, i) => {
          if (values[i] == null) return;
          entries[k] = values[i];
          const g = k.split('/')[0];
          counts[g] = (counts[g] || 0) + 1;
        });
        return json({ format: 'mc-mod-wiki-backup', version: 1, createdAt: now(), counts, entries });
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
      if (M === 'POST' && parts[1] === 'news') {
        const input = await readJson(req);
        let news = (await store.get('meta/news')) || [];
        const id = str(input.id, 20);
        if (input.remove) news = news.filter(n => n.id !== id);
        else {
          const title = str(input.title, 100);
          if (!title) return fail(400, 'タイトルを入れてください。');
          const body = typeof input.body === 'string' ? input.body.replace(/\r\n?/g, '\n').trim().slice(0, 5000) : '';
          const old = id && news.find(n => n.id === id);
          if (old) Object.assign(old, { title, body, pinned: !!input.pinned, updatedAt: now() });
          else news.unshift({ id: randomBytes(5).toString('hex'), title, body, pinned: !!input.pinned, at: now() });
        }
        await store.set('meta/news', news.slice(0, 200));
        return json(news);
      }
      if (M === 'POST' && parts[1] === 'grant-title') {
        const input = await readJson(req);
        const ref = await store.get(nameKey(str(input.account, 24)));
        const acc = ref && (await store.get(`accounts/${ref.uid}`));
        const title = str(input.title, 12).replace(/[【】]/g, '');
        if (!acc || !title) return fail(400, 'アカウント名と肩書きを入れてください。');
        const granted = new Set(acc.granted || []);
        if (input.remove) {
          granted.delete(title);
          acc.titles = (acc.titles || []).filter(t => t !== `g:${title}`);
        } else granted.add(title);
        acc.granted = [...granted];
        await store.set(`accounts/${acc.uid}`, acc);
        return json({ account: acc.name, granted: acc.granted });
      }
      if (M === 'POST' && parts[1] === 'attribute') {
        const input = await readJson(req);
        const from = str(input.fromName, 24);
        const ref = await store.get(nameKey(str(input.account, 24)));
        const acc = ref && (await store.get(`accounts/${ref.uid}`));
        if (!from || !acc) return fail(400, 'ユーザー名とアカウント名を正しく入れてください。');
        return json(await reassign(store, e => e.user === from, acc));
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
      if (M === 'POST' && parts[1] === 'contact') {
        const input = await readJson(req);
        let contacts = (await store.get('meta/contacts')) || [];
        if (input.remove) contacts = contacts.filter(c => c.id !== input.id);
        else contacts = contacts.map(c => (c.id === input.id ? { ...c, done: !!input.done } : c));
        await store.set('meta/contacts', contacts);
        return json({ ok: true });
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
      const strip = ({ log, ipHash: _, createdGuest: __, ...p }) => p;
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
    if (M === 'GET' && parts.length === 1) {
      const [all, counts] = await Promise.all([loadAll(store, col), likeCounts(store, col)]);
      return json(all.map(p => ({ ...hideGuest(listItem(p)), likes: counts[p.slug] || 0 })));
    }
    if (!SLUG.test(parts[1] || '')) return fail(404, 'Not found');
    const slug = parts[1];
    const pageKey = `${col}/${slug}`;

    /* ----- 個別ページ ----- */
    if (M === 'GET' && parts.length === 2) {
      const page = await store.get(pageKey);
      if (page) return json({ ...scrub(page, isAdmin), ...(await likeState(store, col, slug, account)) });
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
      const user = account ? account.name : str(input.user, 24);
      if (!user) return fail(400, 'ユーザー名を入力してください。');
      if (!account && (await store.get(nameKey(user)))) return fail(400, `「${user}」はアカウントで使われている名前です。その人ならログインしてください。`);
      const data = clean(input, col);
      if (!data.name) return fail(400, col === 'articles' ? '記事のタイトルを入力してください。' : 'MOD名を入力してください。');
      // 「コメントはアカウントのある人だけ」は、新しいページならだれでも、あとからは作った人と管理者だけが変えられる
      const cur = await store.get(pageKey);
      const canSetComments = !cur || isAdmin || (!!account && cur.createdUid === account.uid);
      const wantCo = canSetComments && typeof input.commentsAccountOnly === 'boolean' ? input.commentsAccountOnly : undefined;
      if (cur && wantCo !== undefined && wantCo !== !!cur.commentsAccountOnly && sameContent(cur, data) && (Number(input.baseRev) || 0) === cur.rev) {
        cur.commentsAccountOnly = wantCo; // 設定だけの変更は版を増やさない
        await store.set(pageKey, cur);
        return json(hideGuest(cur));
      }
      const t = await throttle('edit', EDIT_INTERVAL_MS);
      if (t) return t;
      const res = await savePage(store, col, slug, data, {
        user, comment: str(input.comment, 120), baseRev: Number(input.baseRev) || 0, ipHash, admin: isAdmin,
        uid: account?.uid || '', guest: gh, commentsAccountOnly: wantCo,
      });
      if (res.ok) await markThrottle('edit');
      return res;
    }

    /* ----- 管理者のページ操作 ----- */
    // コメント（ログインしていなくても名前を入れれば書ける。消せるのは本人と管理者）
    if (parts[2] === 'comments') {
      const ck = `comments/${col}/${slug}`;
      const items = (await store.get(ck))?.items || [];
      const mine = c => (account && c.uid === account.uid) || (!c.uid && gh && c.guest === gh);
      const view = list => list.map(({ guest, ipHash: ih, ...c }) => ({ ...c, mine: !!mine({ guest, ...c }), ...(isAdmin ? { ipHash: ih } : {}) }));
      if (M === 'GET' && parts.length === 3) return json(view(items));
      if (M === 'POST' && parts.length === 3) {
        const input = await readJson(req);
        if (input.website) return fail(400, '不正なリクエストです。');
        const blocked = await editBlocked(settings);
        if (blocked) return blocked;
        const page = await store.get(pageKey);
        if (!page) return fail(404, 'ページがありません。');
        if (page.commentsAccountOnly && !account && !isAdmin) return fail(401, 'このページは、アカウントを持っている人だけコメントできます。ログインしてください。');
        const text = typeof input.text === 'string' ? input.text.replace(/\r\n?/g, '\n').trim().slice(0, 1000) : '';
        if (!text) return fail(400, 'コメントを入力してください。');
        const user = account ? account.name : str(input.user, 24);
        if (!user) return fail(400, '名前を入力してください。');
        if (!account && (await store.get(nameKey(user)))) return fail(400, `「${user}」はアカウントで使われている名前です。その人ならログインしてください。`);
        const t = await throttle('comment', COMMENT_INTERVAL_MS);
        if (t) return t;
        const c = { id: randomBytes(6).toString('hex'), at: now(), user, text, ipHash, ...(account ? { uid: account.uid } : gh ? { guest: gh } : {}) };
        const next = [...items, c].slice(-500);
        await store.set(ck, { items: next });
        await markThrottle('comment');
        return json(view(next), 201);
      }
      if (M === 'POST' && parts[3] === 'delete') {
        const input = await readJson(req);
        const c = items.find(x => x.id === input.id);
        if (!c) return fail(404, 'そのコメントはありません。');
        if (!isAdmin && !mine(c)) return fail(403, '自分のコメントだけ消せます。');
        const next = items.filter(x => x.id !== c.id);
        await store.set(ck, { items: next });
        return json(view(next));
      }
      return fail(404, 'Not found');
    }

    if (M === 'POST' && parts[2] === 'like') {
      if (!account) return fail(401, 'いいねするにはログインしてください。');
      if (!(await store.get(pageKey))) return fail(404, 'ページがありません。');
      const input = await readJson(req);
      return json(await setLike(store, account, col, slug, !!input.like));
    }

    const denied = adminOnly();
    if (denied) return denied;

    if (M === 'POST' && parts[2] === 'lock') {
      const page = await store.get(pageKey);
      if (!page) return fail(404, 'ページがありません。');
      const input = await readJson(req);
      page.locked = !!input.locked;
      await store.set(pageKey, page);
      await addRecent(store, { col, slug, name: page.name, action: page.locked ? 'lock' : 'unlock', user: '管理者', at: now(), admin: true });
      return json(hideGuest(page));
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
      return json(hideGuest(page));
    }
    return fail(404, 'Not found');
  } catch (e) {
    if (e.status) return fail(e.status, e.message);
    console.error(e);
    return fail(500, 'サーバーエラーが発生しました。');
  }
}
