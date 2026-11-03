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

export const issueToken = issue;

export async function sessionAccount(store, token) {
  const [uid, exp, sig] = String(token || '').split('.');
  if (!uid || !exp || !sig || Number(exp) < Date.now()) return null;
  if (!eq(sig, sign(await secret(store), `${uid}.${exp}`))) return null;
  return store.get(`accounts/${uid}`);
}

const err = (status, message) => Object.assign(new Error(message), { status });

export async function signup(store, { name, password, email }) {
  name = String(name || '').trim();
  if (!NAME_RE.test(name)) throw err(400, 'ユーザー名は2〜20文字で、文字・数字・_ ・- が使えます。');
  if (RESERVED.includes(name.toLowerCase())) throw err(400, 'その名前は使えません。');
  if (typeof password !== 'string' || password.length < 6 || password.length > 200) throw err(400, 'パスワードは6文字以上にしてください。');
  if (await store.get(nameKey(name))) throw err(409, 'その名前はすでに使われています。');
  const mail = await checkEmail(store, email);
  const uid = randomBytes(8).toString('hex');
  const salt = randomBytes(16).toString('hex');
  const account = { uid, name, salt, hash: await pbkdf2(password, salt), createdAt: new Date().toISOString(), guests: [], ...(mail ? { email: mail } : {}) };
  await store.set(nameKey(name), { uid });
  if (mail) await store.set(emailKey(mail), { uid });
  await store.set(`accounts/${uid}`, account);
  return { account, token: await issue(store, account) };
}

// メールアドレス（本物でなくてよい・確認なし）。空なら登録しない
export const emailKey = email => `accountemails/${String(email).trim().toLowerCase()}`;
async function checkEmail(store, email, selfUid = '') {
  const mail = String(email || '').trim().toLowerCase();
  if (!mail) return '';
  if (mail.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) throw err(400, 'メールアドレスの形が正しくありません（例: name@example.com）。');
  const used = await store.get(emailKey(mail));
  if (used && used.uid !== selfUid) throw err(409, 'そのメールアドレスはすでに使われています。');
  return mail;
}

// ユーザー名でもメールアドレスでもログインできる
export async function login(store, { name, password }) {
  const id = String(name || '').trim();
  const ref = await store.get(id.includes('@') ? emailKey(id) : nameKey(id));
  const account = ref && (await store.get(`accounts/${ref.uid}`));
  // 名前が無くても同じだけ時間をかけて、名前の有無を推測されにくくする
  const hash = await pbkdf2(String(password || ''), account?.salt || '00'.repeat(16));
  if (!account || !eq(hash, account.hash)) throw err(401, 'ユーザー名（メールアドレス）かパスワードが違います。');
  return { account, token: await issue(store, account) };
}

// 公開してよい項目だけ（メールアドレスは含めない）
// ka = かるわかGAMESアカウントと連携済みか(連携していない人には、画面で「引き継ぐ」ボタンを出す)
export const publicAccount = a => (a ? { uid: a.uid, name: a.name, createdAt: a.createdAt, avatar: a.avatar || '', titles: a.titles || [], ka: !!a.ka } : null);

// ---- かるわかGAMESアカウント(ログインは全ゲーム共通) ----
// クライアントが送ってくる「かるわかGAMESのセッショントークン」を、Supabaseの ka_whoami で確かめて本人(ユーザー名)を得る。
// かるわかGAMESのユーザー名 → このWikiのアカウント の対応を  kalinks/<かるわかGAMESのユーザー名> → { uid }  に持つ。
const KA_URL = 'https://kifnzvktwbomxthzvvgy.supabase.co';
// 公開しても問題ない anon key(かるわかGAMESの他のゲームと共通)
const KA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtpZm56dmt0d2JvbXh0aHp2dmd5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4MzgxMzgsImV4cCI6MjA5MzQxNDEzOH0.M7nXP-u--6J_6rRpgz1cJj21_7KX6MtfTmZy77Xf_IE';
export const kaKey = username => `kalinks/${String(username).toLowerCase()}`;

export async function kaWhoami(token) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 200) return null;
  try {
    const res = await fetch(`${KA_URL}/rest/v1/rpc/ka_whoami`, {
      method: 'POST',
      headers: { apikey: KA_KEY, Authorization: `Bearer ${KA_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_token: token }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const r = await res.json();
    return r && r.ok && r.profile ? r.profile : null;
  } catch { return null; }
}

// かるわかGAMESの表示名をもとに、使われていないWikiのユーザー名を決める
async function uniqueName(store, profile) {
  let base = String(profile.display_name || '').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 20);
  if (base.length < 2) base = String(profile.username).slice(0, 20);
  if (RESERVED.includes(base.toLowerCase())) base = `${base}_`.slice(0, 20);
  for (let n = 0; n < 500; n++) {
    const suffix = n ? `_${n + 1}` : '';
    const name = base.slice(0, 20 - suffix.length) + suffix;
    if (NAME_RE.test(name) && !(await store.get(nameKey(name)))) return name;
  }
  throw err(409, 'ユーザー名を決められませんでした。');
}

export async function kaLinkAccount(store, account, kaUsername) {
  account.ka = String(kaUsername).toLowerCase();
  await store.set(`accounts/${account.uid}`, account);
  await store.set(kaKey(kaUsername), { uid: account.uid });
  return account;
}

// かるわかGAMESアカウントで初めて来た人の、新しいWikiアカウント(パスワードは使えないランダム値)
export async function kaCreate(store, profile) {
  const name = await uniqueName(store, profile);
  const uid = randomBytes(8).toString('hex');
  const salt = randomBytes(16).toString('hex');
  const account = { uid, name, salt, hash: await pbkdf2(randomBytes(24).toString('hex'), salt), createdAt: new Date().toISOString(), guests: [] };
  await store.set(nameKey(name), { uid });
  return kaLinkAccount(store, account, profile.username);
}

export const kaError = (status, message) => err(status, message);


// プロフィールの更新（送られてきた項目だけ）。自己紹介は Markdown・1000文字まで、アイコンは画像のURL
export async function updateProfile(store, account, { bio, avatar, email } = {}) {
  if (typeof bio === 'string') account.bio = bio.replace(/\r\n?/g, '\n').trim().slice(0, 1000);
  if (typeof avatar === 'string') {
    const a = avatar.trim().slice(0, 400);
    if (a && !/^https:\/\/\S+$/i.test(a) && !/^\/img\/[a-z0-9]+\.(png|jpg|webp|gif)$/.test(a)) throw err(400, 'アイコンの画像が正しくありません。');
    account.avatar = a;
  }
  if (typeof email === 'string') {
    const mail = await checkEmail(store, email, account.uid);
    if (account.email && account.email !== mail) await store.delete(emailKey(account.email));
    if (mail) { await store.set(emailKey(mail), { uid: account.uid }); account.email = mail; } else delete account.email;
  }
  await store.set(`accounts/${account.uid}`, account);
  return { bio: account.bio || '', avatar: account.avatar || '', email: account.email || '' };
}

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
  return { ...publicAccount(account), bio: account.bio || '', created, edits: edits.slice(0, 200), editCount: edits.length };
}
