// アカウント（ユーザー名＋パスワード）とゲストIDの紐付け。
//   accounts/<uid>        … { uid, name, salt, hash, createdAt, guests: [ゲストIDのハッシュ] }
//   accountnames/<小文字の名前> … { uid }
// パスワードは PBKDF2（WebCrypto）でハッシュ化して保存。ログイン状態は署名付きトークン。
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const NAME_RE = /^[\p{L}\p{N}_-]{2,20}$/u;
const RESERVED = ['システム', '管理者', 'admin', 'guest', 'ゲスト', 'system'];
const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const ITER = 150_000;

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const unhex = s => new Uint8Array(s.match(/../g).map(h => parseInt(h, 16)));
const sha = s => createHash('sha256').update(String(s)).digest('hex');
const eq = (a, b) => timingSafeEqual(createHash('sha256').update(String(a)).digest(), createHash('sha256').update(String(b)).digest());
export const nameKey = name => `accountnames/${String(name).trim().toLowerCase()}`;
// ゲストID（ブラウザの localStorage にある値）はそのまま保存せず、ハッシュにして記録する
export const guestHash = id => (/^[A-Za-z0-9-]{16,64}$/.test(id || '') ? sha(`guest:${id}`) : '');

async function pbkdf2(password, saltHex) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(saltHex), iterations: ITER }, key, 256);
  return hex(bits);
}

// トークンの署名に使う秘密の値（最初に1回だけ作って保存）
async function secret(store) {
  let s = await store.get('config/secret');
  if (!s?.key) { s = { key: randomBytes(32).toString('hex') }; await store.set('config/secret', s); }
  return s.key;
}
const sign = (key, body) => createHmac('sha256', key).update(body).digest('hex');

async function issue(store, account) {
  const exp = Date.now() + SESSION_TTL_MS;
  const body = `${account.uid}.${exp}`;
  return `${body}.${sign(await secret(store), body)}`;
}

export async function sessionAccount(store, token) {
  const [uid, exp, sig] = String(token || '').split('.');
  if (!uid || !exp || !sig || Number(exp) < Date.now()) return null;
  if (!eq(sig, sign(await secret(store), `${uid}.${exp}`))) return null;
  return store.get(`accounts/${uid}`);
}

const err = (status, message) => Object.assign(new Error(message), { status });

export async function signup(store, { name, password }) {
  name = String(name || '').trim();
  if (!NAME_RE.test(name)) throw err(400, 'ユーザー名は2〜20文字で、文字・数字・_ ・- が使えます。');
  if (RESERVED.includes(name.toLowerCase())) throw err(400, 'その名前は使えません。');
  if (typeof password !== 'string' || password.length < 6 || password.length > 200) throw err(400, 'パスワードは6文字以上にしてください。');
  if (await store.get(nameKey(name))) throw err(409, 'その名前はすでに使われています。');
  const uid = randomBytes(8).toString('hex');
  const salt = randomBytes(16).toString('hex');
  const account = { uid, name, salt, hash: await pbkdf2(password, salt), createdAt: new Date().toISOString(), guests: [] };
  await store.set(nameKey(name), { uid });
  await store.set(`accounts/${uid}`, account);
  return { account, token: await issue(store, account) };
}

export async function login(store, { name, password }) {
  const ref = await store.get(nameKey(name));
  const account = ref && (await store.get(`accounts/${ref.uid}`));
  // 名前が無くても同じだけ時間をかけて、名前の有無を推測されにくくする
  const hash = await pbkdf2(String(password || ''), account?.salt || '00'.repeat(16));
  if (!account || !eq(hash, account.hash)) throw err(401, 'ユーザー名かパスワードが違います。');
  return { account, token: await issue(store, account) };
}

export const publicAccount = a => (a ? { uid: a.uid, name: a.name, createdAt: a.createdAt } : null);

// 条件に合う「アカウント無しの編集」をアカウントのものに付け替える（履歴・最近の更新も）
export async function reassign(store, match, account) {
  let edits = 0;
  const pages = new Set();
  for (const [col, hist] of [['pages', 'history'], ['articles', 'ahistory']]) {
    for (const key of await store.list(`${col}/`)) {
      const p = await store.get(key);
      if (!p?.log) continue;
      let changed = false;
      for (const e of p.log) {
        if (e.uid || !match(e)) continue;
        Object.assign(e, { uid: account.uid, user: account.name });
        changed = true;
        edits++;
        const hk = `${hist}/${p.slug}/${String(e.rev).padStart(6, '0')}`;
        const snap = await store.get(hk);
        if (snap) await store.set(hk, { ...snap, uid: account.uid, user: account.name });
      }
      if (!changed) continue;
      const first = p.log.find(e => e.rev === 1);
      if (first?.uid === account.uid) Object.assign(p, { createdUid: account.uid, createdBy: account.name });
      if (p.log[0]?.uid === account.uid) p.updatedBy = account.name;
      await store.set(key, p);
      pages.add(`${col}/${p.slug}`);
    }
  }
  const recent = (await store.get('meta/recent')) || [];
  let rc = false;
  for (const r of recent) if (!r.uid && !r.action && match(r)) { Object.assign(r, { uid: account.uid, user: account.name }); rc = true; }
  if (rc) await store.set('meta/recent', recent);
  return { edits, pages: pages.size };
}

// ゲストIDで作ったものを自分のものにする
export async function claimGuest(store, account, gh) {
  if (!gh) return { edits: 0, pages: 0 };
  if (!account.guests?.includes(gh)) {
    account.guests = [...(account.guests || []), gh].slice(-50);
    await store.set(`accounts/${account.uid}`, account);
  }
  return reassign(store, e => e.guest === gh, account);
}

// プロフィール：作ったページと編集の一覧
export async function profile(store, name) {
  const ref = await store.get(nameKey(name));
  const account = ref && (await store.get(`accounts/${ref.uid}`));
  if (!account) return null;
  const created = [];
  const edits = [];
  for (const col of ['pages', 'articles']) {
    for (const key of await store.list(`${col}/`)) {
      const p = await store.get(key);
      if (!p) continue;
      if (p.createdUid === account.uid) created.push({ col, slug: p.slug, name: p.name, at: p.createdAt });
      for (const e of p.log || []) {
        if (e.uid === account.uid) edits.push({ col, slug: p.slug, name: p.name, rev: e.rev, at: e.at, comment: e.comment, delta: e.delta });
      }
    }
  }
  created.sort((a, b) => b.at.localeCompare(a.at));
  edits.sort((a, b) => b.at.localeCompare(a.at));
  return { ...publicAccount(account), created, edits: edits.slice(0, 200), editCount: edits.length };
}
