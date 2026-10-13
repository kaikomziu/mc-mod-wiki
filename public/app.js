import { VERSIONS, LOADERS, TAGS } from './tags.js';
import { config, u, appPath, OPENCHAT } from './paths.js';
import { TITLES, MAX_TITLES, titleLabel } from './titles.js';
import { esc, inline, renderMarkdown, setModResolver, videoInfo } from './markdown.js';
import { fmt, KINDS, card, pageView, formatDownloads, homeIntro } from './views.js';
import {
  homeTitle, pageTitle, modTitle, listTitle, modDescription, listDescription, articleTitle, articleDescription,
  SITE_DESC, LISTS, ARTICLES_TITLE, ARTICLES_DESC,
} from './seo.js';

const app = document.getElementById('app');
const state = {
  mods: [], articles: [], q: '', version: '', loader: '', tags: [],
  dirty: false, admin: false, editLocked: false, openReports: 0, openContacts: 0, account: null, users: new Map(), news: [],
};
const USER_KEY = 'modwiki-user';
const TOKEN_KEY = 'modwiki-admin';
const SESSION_KEY = 'modwiki-session'; // アカウントのログイン
const GUEST_KEY = 'modwiki-guest'; // ゲストとして作ったものを後で自分のものにするための、このブラウザのID
const store = {
  get: k => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* 保存できなくても続行 */ } },
};

// 下書き（このブラウザの中だけに保存）。{ id: { col, slug, isNew, data, baseRev, savedAt } }
const DRAFTS_KEY = 'modwiki-drafts';
const drafts = {
  all() { try { return JSON.parse(localStorage.getItem(DRAFTS_KEY) || '{}'); } catch { return {}; } },
  get(id) { return this.all()[id] || null; },
  put(id, d) {
    const a = this.all();
    a[id] = d;
    try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(a)); } catch { return false; }
    updateDraftLink();
    return true;
  },
  remove(id) {
    const a = this.all();
    delete a[id];
    try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(a)); } catch { /* 消せなくても続行 */ }
    updateDraftLink();
  },
};
const draftHref = (id, d) => `${d.isNew ? KINDS[d.col].newPath : KINDS[d.col].edit(d.slug)}?draft=${encodeURIComponent(id)}`;

function updateDraftLink() {
  const n = Object.keys(drafts.all()).length;
  document.getElementById('drafts-link')?.remove();
  if (n) document.querySelector('.site-header nav')?.insertAdjacentHTML('beforeend', `<a id="drafts-link" href="${u('/drafts')}">📄 下書き<span class="nav-badge muted-badge">${n}</span></a>`);
}

setModResolver(key => {
  const k = key.toLowerCase();
  return state.mods.find(m => m.slug === k) || state.mods.find(m => m.name.toLowerCase() === k);
});

/* ===== 共通 ===== */
function guestId() {
  let id = store.get(GUEST_KEY);
  if (!id) { id = crypto.randomUUID(); store.set(GUEST_KEY, id); }
  return id;
}
const authHeaders = () => ({
  ...(store.get(TOKEN_KEY) ? { 'x-admin-token': store.get(TOKEN_KEY) } : {}),
  ...(store.get(SESSION_KEY) ? { 'x-session': store.get(SESSION_KEY) } : {}),
  'x-guest-id': guestId(),
});
const userHref = name => u(`/user/${encodeURIComponent(name)}`);
// 履歴などの名前表示（アカウントならプロフィールへのリンク）
const titleBadges = labels => (labels || []).map(t => `<span class="title-badge">【${esc(t)}】</span>`).join('');
// アカウントの名前は、アイコン＋名前＋肩書き（state.users にある最新の情報を使う）
const userLabel = e => {
  if (!e.uid) return esc(e.user || '');
  const info = state.users.get(e.uid);
  const name = info?.name || e.user;
  return `<a class="user-link" href="${userHref(name)}">${avatarHtml(info || { name }, 'mini-avatar')} ${esc(name)}</a>${titleBadges(info?.titles)}`;
};
async function api(path, opts = {}) {
  const r = await fetch(config.api + path, { cache: 'no-store', ...opts, headers: { 'content-type': 'application/json', ...authHeaders(), ...opts.headers } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || `エラー (${r.status})`), { status: r.status, data });
  return data;
}
const loadUsers = async () => { state.users = new Map((await api('/users').catch(() => [])).map(a => [a.uid, a])); };
const loadNews = async () => { state.news = await api('/news').catch(() => []); };
const loadData = async () => { [state.mods, state.articles] = await Promise.all([api('/pages'), api('/articles'), loadUsers(), loadNews()]); };
// お知らせは固定したものを先に、あとは新しい順
const sortedNews = () => [...state.news].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.at.localeCompare(a.at));
const newsDate = n => fmt(n.at).split(' ')[0];
const listOf = col => (col === 'articles' ? state.articles : state.mods);
const delta = d => `<span class="delta ${d > 0 ? 'plus' : d < 0 ? 'minus' : ''}">${d > 0 ? '+' : ''}${d}</span>`;
const getUser = () => store.get(USER_KEY);
const setUser = v => store.set(USER_KEY, v);
const canEdit = page => state.admin || (!state.editLocked && !page?.locked);
const crown = e => (e.admin ? ' <span class="badge admin" title="管理者による操作">👑 管理者</span>' : '');
const banBtn = e => (state.admin && e.ipHash
  ? ` <button type="button" class="linkish ban" data-ban="${e.ipHash}" data-user="${esc(e.user || '')}">🚫 ブロック</button>` : '');
const loading = () => { if (!firstRender) app.innerHTML = '<div class="loading">読み込み中…</div>'; };
const errorBox = e => `<div class="empty">${esc(e.message)}</div>`;
const crumbRoot = col => `<a href="${KINDS[col].listPath}">${KINDS[col].listLabel}</a>`;

function bindBanButtons() {
  app.querySelectorAll('[data-ban]').forEach(b => b.addEventListener('click', async () => {
    const reason = prompt(`「${b.dataset.user}」の編集をブロックします。理由（任意）:`, '');
    if (reason === null) return;
    try {
      await api('/admin/ban', { method: 'POST', body: JSON.stringify({ ipHash: b.dataset.ban, user: b.dataset.user, reason }) });
      toast(`${b.dataset.user} をブロックしました`);
    } catch (e) { alert(e.message); }
  }));
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

function setMeta(title, desc = SITE_DESC) {
  document.title = title;
  document.querySelector('meta[name="description"]')?.setAttribute('content', desc);
  document.querySelector('link[rel="canonical"]')?.setAttribute('href', location.origin + location.pathname);
}

// 小さなダイアログ。html はフォームの中身、onSubmit が true 以外を返すと開いたまま
function openModal(title, html, onSubmit, { submitLabel = 'OK', wide = false } = {}) {
  document.querySelector('.modal-bg')?.remove();
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `
    <form class="modal${wide ? ' wide' : ''}" autocomplete="off">
      <h2>${title}</h2>
      ${html}
      <div class="form-error" role="alert"></div>
      <div class="btns"><button type="button" class="btn" data-close>キャンセル</button><button class="btn primary">${submitLabel}</button></div>
    </form>`;
  document.body.append(bg);
  const form = bg.querySelector('form');
  const close = () => bg.remove();
  bg.addEventListener('click', e => { if (e.target === bg || e.target.matches('[data-close]')) close(); });
  bg.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = form.querySelector('.btn.primary');
    btn.disabled = true;
    try {
      if ((await onSubmit(form)) !== false) close();
    } catch (err) {
      form.querySelector('.form-error').textContent = err.message;
    } finally { btn.disabled = false; }
  });
  form.querySelector('input:not([type=hidden]):not([type=checkbox]), select, textarea')?.focus();
  return form;
}

async function refreshSettings() {
  try {
    const s = await api('/settings');
    Object.assign(state, { editLocked: s.editLocked, admin: s.isAdmin, openReports: s.openReports || 0, openContacts: s.openContacts || 0, account: s.account || null });
    if (!s.isAdmin) store.set(TOKEN_KEY, '');
    if (!s.account) store.set(SESSION_KEY, '');
  } catch { /* 取得できなくても閲覧は続行 */ }
  document.body.classList.toggle('is-admin', state.admin);
  updateDraftLink();
  document.getElementById('account-link')?.remove();
  document.querySelector('.site-header nav').insertAdjacentHTML('beforeend', state.account
    ? `<a id="account-link" href="${userHref(state.account.name)}">${avatarHtml(state.account, 'nav-avatar')} ${esc(state.account.name)}<span class="nav-titles">${titleBadges(state.account.titleLabels)}</span></a>`
    : `<a id="account-link" href="${u('/login')}">ログイン</a>`);
  document.getElementById('admin-link')?.remove();
  if (state.admin) {
    document.querySelector('.site-header nav').insertAdjacentHTML('beforeend',
      `<a id="admin-link" href="${u('/admin')}">👑 管理${state.openReports + state.openContacts ? `<span class="nav-badge" title="未対応の通報・お問い合わせ">${state.openReports + state.openContacts}</span>` : ''}</a>`);
  }
  const banner = document.getElementById('site-banner');
  banner.hidden = !state.editLocked;
  banner.textContent = state.admin ? '⚠️ サイト全体の編集を停止中です（管理者は編集できます）' : '⚠️ 現在、編集は一時停止されています';
}

/* ===== 管理者ログイン（キーボードで admin と打つと開く） ===== */
let typed = '';
document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
  if (e.target.closest('input, textarea, select, [contenteditable]')) return;
  typed = (typed + e.key.toLowerCase()).slice(-5);
  if (typed !== 'admin') return;
  e.preventDefault(); // 最後の「n」が入力欄に入らないように
  typed = '';
  if (state.admin) navigate('/admin');
  else openLogin();
});

function openLogin() {
  openModal('管理者ログイン',
    ['ne', 'cl', 'ch'].map(n => `<label class="field inline"><span>${n[0].toUpperCase() + n[1]}</span><input name="${n}" type="password" required autocapitalize="off" autocorrect="off" spellcheck="false"></label>`).join(''),
    async form => {
      const { token } = await api('/admin/login', {
        method: 'POST', body: JSON.stringify({ ne: form.ne.value, cl: form.cl.value, ch: form.ch.value }),
      });
      store.set(TOKEN_KEY, token);
      await refreshSettings();
      toast('👑 管理者としてログインしました');
      if (!state.dirty) route();
    }, { submitLabel: 'ログイン' });
}

/* ===== アカウント ===== */
function openAuth(mode = 'login') {
  const signup = mode === 'signup';
  const form = openModal(signup ? 'アカウントを作る' : 'ログイン', `
    <div class="auth-tabs"><button type="button" class="${signup ? '' : 'on'}" data-mode="login">ログイン</button><button type="button" class="${signup ? 'on' : ''}" data-mode="signup">アカウントを作る</button></div>
    <label class="field"><span>${signup ? 'ユーザー名' : 'ユーザー名 または メールアドレス'}</span><input name="name" maxlength="${signup ? 20 : 120}" required autocomplete="username" value="${esc(signup ? getUser() : '')}"></label>
    ${signup ? '<label class="field"><span>メールアドレス <small>任意・本物でなくてもOK（ログインに使えます）</small></span><input name="email" type="email" maxlength="120" autocomplete="email" placeholder="例: steve@example.com"></label>' : ''}
    <label class="field"><span>パスワード${signup ? ' <small>6文字以上</small>' : ''}</span><input name="password" type="password" minlength="6" required autocomplete="${signup ? 'new-password' : 'current-password'}"></label>
    ${signup ? '<label class="field"><span>パスワード（確認）</span><input name="password2" type="password" minlength="6" required autocomplete="new-password"></label>' : ''}
    <input name="website" class="hp" tabindex="-1" aria-hidden="true">
    <p class="muted small">${signup ? 'メールアドレスは不要です。' : ''}このブラウザでゲストとして作ったページや編集は、${signup ? '作成' : 'ログイン'}するとあなたのアカウントのものになります。</p>`,
  async f => {
    if (signup && f.password.value !== f.password2.value) throw new Error('パスワードが一致しません。');
    const res = await api(`/account/${signup ? 'signup' : 'login'}`, {
      method: 'POST', body: JSON.stringify({ name: f.name.value, password: f.password.value, email: f.email?.value || '', website: f.website.value }),
    });
    store.set(SESSION_KEY, res.token);
    setUser(res.account.name);
    await Promise.all([refreshSettings(), loadData()]);
    const c = res.claimed;
    toast(`👤 ${res.account.name} で${signup ? 'アカウントを作りました' : 'ログインしました'}${c?.edits ? `（ゲストの編集${c.edits}件を引き継ぎ）` : ''}`);
    if (!state.dirty) route();
  }, { submitLabel: signup ? '作成する' : 'ログイン' });
  form.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => openAuth(b.dataset.mode)));
}

async function logout() {
  store.set(SESSION_KEY, '');
  await refreshSettings();
  toast('ログアウトしました');
  navigate('/');
}

async function renderUser(name) {
  loading();
  let p;
  try { p = await api(`/users/${encodeURIComponent(name)}`); } catch (e) { app.innerHTML = errorBox(e); return; }
  const me = state.account?.uid === p.uid;
  setMeta(pageTitle(`${p.name} さんのプロフィール`));
  // 作ったページはカードで表示（一覧の情報があればそれを使う）
  const cardsFor = col => {
    const items = p.created.filter(c => c.col === col);
    if (!items.length) return `<p class="muted">まだありません。</p>`;
    return `<div class="grid">${items.map(c => {
      const full = listOf(col).find(x => x.slug === c.slug);
      return full ? card(full, col) : `<a class="card" href="${KINDS[col].view(c.slug)}"><h3>${esc(c.name)}</h3></a>`;
    }).join('')}</div>`;
  };
  const nMods = p.created.filter(c => c.col === 'pages').length;
  const nArticles = p.created.length - nMods;
  app.innerHTML = `
    <section class="profile-head">
      <div class="profile-avatar-wrap">
        ${avatarHtml(p, 'profile-avatar')}
        ${me ? `<div class="avatar-actions"><button type="button" class="linkish small" data-avatar-change>📷 アイコンを変更</button>${p.avatar ? '<button type="button" class="linkish small muted" data-avatar-remove>外す</button>' : ''}</div>` : ''}
      </div>
      <div class="profile-main">
        <h1 class="page-title">${esc(p.name)}${titleBadges(p.titleLabels)}</h1>
        <p class="muted small">${fmt(p.createdAt)} から参加 ・ 編集 ${p.editCount} 回 ・ MODページ ${nMods} ・ 記事 ${nArticles}</p>
        <div class="profile-stats">
          <button type="button" class="stat-link" data-list="following"><b>${p.following}</b> フォロー</button>
          <button type="button" class="stat-link" data-list="followers"><b class="followers-count">${p.followers}</b> フォロワー</button>
          <span class="stat"><b>${p.likesReceived}</b> もらったいいね</span>
        </div>
        <div class="profile-bio">
          <div class="bio-view md">${p.bio ? renderMarkdown(p.bio) : `<p class="muted">${me ? 'まだ自己紹介がありません。「自己紹介を編集」から書けます。' : 'まだ自己紹介はありません。'}</p>`}</div>
          ${me ? `<form class="bio-form" hidden>
            <textarea name="bio" maxlength="1000" rows="5" placeholder="好きなMOD、よく遊ぶバージョン、得意なジャンルなど（**太字**などの書き方も使えます）">${esc(p.bio || '')}</textarea>
            <div class="btns"><span class="muted small bio-count"></span><button type="button" class="btn" data-bio-cancel>やめる</button><button class="btn primary">保存する</button></div>
          </form>` : ''}
        </div>
      </div>
      ${me ? `<div class="btns profile-actions"><button class="btn" data-bio-edit>✏️ 自己紹介を編集</button><button class="btn" data-claim>ゲストの編集を引き継ぐ</button><button class="btn" data-logout>ログアウト</button></div>`
        : `<div class="btns profile-actions"><button class="btn follow-btn${p.isFollowing ? '' : ' primary'}" data-follow>${p.isFollowing ? '✓ フォロー中' : '＋ フォローする'}</button></div>`}
    </section>
    ${me ? `
    <section class="panel profile-section titles-panel">
      <h2>🏷 肩書き <small>持っている中から${MAX_TITLES}つまで選ぶと、名前の横に表示されます</small></h2>
      <div class="title-picker">
        ${p.owned.map(id => `<button type="button" class="chip title-chip${(p.titles || []).includes(id) ? ' on' : ''}" data-title="${esc(id)}" title="${esc(TITLES.find(t => t.id === id)?.desc || '管理者から贈られた肩書き')}">【${esc(titleLabel(id))}】</button>`).join('')}
      </div>
      ${TITLES.some(t => !p.owned.includes(t.id)) ? `<details class="locked-titles"><summary class="muted small">まだ持っていない肩書き（${TITLES.filter(t => !p.owned.includes(t.id)).length}）</summary>
        <ul>${TITLES.filter(t => !p.owned.includes(t.id)).map(t => `<li><span class="title-badge locked">【${esc(t.name)}】</span> <span class="muted small">${esc(t.desc)}</span></li>`).join('')}</ul></details>` : ''}
      <div class="btns"><span class="muted small title-count"></span><button type="button" class="btn primary" data-save-titles>肩書きを保存</button></div>
    </section>
    <section class="panel profile-section">
      <h2>⚙ アカウント設定 <small>ここはあなたにしか見えません</small></h2>
      <form class="email-form">
        <label class="field"><span>メールアドレス <small>本物でなくてもOK・ログインに使えます</small></span>
          <div class="input-with-btn"><input name="email" type="email" maxlength="120" value="${esc(state.account?.email || '')}" placeholder="未設定"><button class="btn">保存</button></div>
        </label>
      </form>
    </section>` : ''}
    <section class="profile-section">
      <h2 class="section-title">🧱 作ったMODページ <small class="muted">${nMods}件</small></h2>
      ${cardsFor('pages')}
    </section>
    <section class="profile-section">
      <h2 class="section-title">📝 書いた記事 <small class="muted">${nArticles}件</small></h2>
      ${cardsFor('articles')}
    </section>
    <section class="profile-section">
      <h2 class="section-title">♥ いいねしたページ <small class="muted">${p.liked.length}件</small></h2>
      ${p.liked.length ? `<div class="grid">${p.liked.map(l => {
        const full = listOf(l.col).find(x => x.slug === l.slug);
        return full ? card(full, l.col) : `<a class="card" href="${KINDS[l.col].view(l.slug)}"><h3>${esc(l.name)}</h3></a>`;
      }).join('')}</div>` : '<p class="muted">まだありません。</p>'}
    </section>
    <section class="panel profile-section">
      <h2>最近の編集 <small>${p.editCount}件</small></h2>
      ${p.edits.length ? `<ul>${p.edits.slice(0, 50).map(e => `<li><a href="${KINDS[e.col].view(e.slug)}">${esc(e.name)}</a> <a class="muted small" href="${KINDS[e.col].hist(e.slug)}/${e.rev}">版${e.rev}</a> ${delta(e.delta)} <span class="muted small">${fmt(e.at)}${e.comment ? ` ・ ${esc(e.comment)}` : ''}</span></li>`).join('')}</ul>` : '<p class="muted">まだありません。</p>'}
    </section>`;
  // 肩書きを選ぶ（2つまで）
  const picker = app.querySelector('.title-picker');
  if (picker) {
    const chips = [...picker.querySelectorAll('.title-chip')];
    const count = () => { app.querySelector('.title-count').textContent = `${chips.filter(c => c.classList.contains('on')).length} / ${MAX_TITLES} 選択中`; };
    count();
    chips.forEach(c => c.addEventListener('click', () => {
      if (!c.classList.contains('on') && chips.filter(x => x.classList.contains('on')).length >= MAX_TITLES) { toast(`肩書きは${MAX_TITLES}つまでです`); return; }
      c.classList.toggle('on');
      count();
    }));
    app.querySelector('[data-save-titles]').addEventListener('click', async () => {
      try {
        await api('/account/titles', { method: 'POST', body: JSON.stringify({ titles: chips.filter(c => c.classList.contains('on')).map(c => c.dataset.title) }) });
        await Promise.all([refreshSettings(), loadUsers()]);
        toast('肩書きを保存しました');
        route();
      } catch (err) { alert(err.message); }
    });
  }
  // メールアドレスの変更
  app.querySelector('.email-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const r = await api('/account/profile', { method: 'POST', body: JSON.stringify({ email: e.target.email.value }) });
      state.account.email = r.email;
      toast(r.email ? 'メールアドレスを保存しました' : 'メールアドレスを外しました');
    } catch (err) { alert(err.message); }
  });

  // フォローする／やめる
  app.querySelector('[data-follow]')?.addEventListener('click', async e => {
    if (!state.account) { openAuth('login'); toast('フォローするにはログインしてください'); return; }
    const btn = e.currentTarget;
    const on = !btn.textContent.includes('フォロー中');
    btn.disabled = true;
    try {
      const r = await api(`/users/${encodeURIComponent(p.name)}/follow`, { method: 'POST', body: JSON.stringify({ follow: on }) });
      btn.textContent = r.following ? '✓ フォロー中' : '＋ フォローする';
      btn.classList.toggle('primary', !r.following);
      app.querySelector('.followers-count').textContent = r.followers;
      const f = new Set(state.account.following || []);
      r.following ? f.add(p.uid) : f.delete(p.uid);
      state.account.following = [...f];
    } catch (err) { alert(err.message); }
    btn.disabled = false;
  });
  // フォロー・フォロワーの一覧
  app.querySelectorAll('[data-list]').forEach(b => b.addEventListener('click', async () => {
    const kind = b.dataset.list;
    let list;
    try { list = await api(`/users/${encodeURIComponent(p.name)}/${kind}`); } catch (err) { alert(err.message); return; }
    const form = openModal(`${esc(p.name)} さんの${kind === 'followers' ? 'フォロワー' : 'フォロー'}`,
      list.length ? `<ul class="people-list">${list.map(a => `<li><a href="${userHref(a.name)}">${avatarHtml(a, 'list-avatar')} ${esc(a.name)}</a></li>`).join('')}</ul>`
        : '<p class="muted">まだいません。</p>', () => true, { submitLabel: '閉じる' });
    form.querySelector('[data-close]').hidden = true;
    form.querySelectorAll('.people-list a').forEach(a => a.addEventListener('click', () => form.closest('.modal-bg').remove()));
  }));

  // アイコンの変更・取り外し
  const saveAvatar = async avatar => {
    const res = await api('/account/profile', { method: 'POST', body: JSON.stringify({ avatar }) });
    state.account = { ...state.account, avatar: res.avatar };
    await refreshSettings();
    toast(avatar ? 'アイコンを変更しました' : 'アイコンを外しました');
    route();
  };
  app.querySelector('[data-avatar-change]')?.addEventListener('click', async e => {
    const file = await pickFile();
    if (!file) return;
    const btn = e.target;
    btn.disabled = true; btn.textContent = 'アップロード中…';
    try {
      const url = await uploadAvatar(file);
      if (url) await saveAvatar(url);
      else { btn.disabled = false; btn.textContent = '📷 アイコンを変更'; }
    } catch (err) { alert(err.message); btn.disabled = false; btn.textContent = '📷 アイコンを変更'; }
  });
  app.querySelector('[data-avatar-remove]')?.addEventListener('click', async () => {
    if (!confirm('アイコンを外しますか？')) return;
    try { await saveAvatar(''); } catch (err) { alert(err.message); }
  });

  // 自己紹介の編集
  const bioForm = app.querySelector('.bio-form');
  if (bioForm) {
    const view = app.querySelector('.bio-view');
    const count = () => { bioForm.querySelector('.bio-count').textContent = `${bioForm.bio.value.length} / 1000`; };
    const toggle = editing => { bioForm.hidden = !editing; view.hidden = editing; if (editing) { count(); bioForm.bio.focus(); } };
    app.querySelector('[data-bio-edit]').addEventListener('click', () => toggle(true));
    bioForm.querySelector('[data-bio-cancel]').addEventListener('click', () => toggle(false));
    bioForm.bio.addEventListener('input', count);
    bioForm.addEventListener('submit', async e => {
      e.preventDefault();
      try {
        const { bio } = await api('/account/profile', { method: 'POST', body: JSON.stringify({ bio: bioForm.bio.value }) });
        view.innerHTML = bio ? renderMarkdown(bio) : '<p class="muted">まだ自己紹介がありません。「自己紹介を編集」から書けます。</p>';
        toggle(false);
        toast('自己紹介を保存しました');
      } catch (err) { alert(err.message); }
    });
  }
  app.querySelector('[data-logout]')?.addEventListener('click', logout);
  app.querySelector('[data-claim]')?.addEventListener('click', async () => {
    try {
      const { claimed } = await api('/account/claim', { method: 'POST' });
      toast(claimed.edits ? `ゲストの編集${claimed.edits}件を引き継ぎました` : '引き継ぐ編集はありませんでした');
      if (claimed.edits) { await loadData(); route(); }
    } catch (e) { alert(e.message); }
  });
}

/* ===== 通報 ===== */
const REPORT_REASONS = ['荒らし・いたずら', '間違った情報', '不適切な内容（画像・言葉）', 'スパム・宣伝', 'その他'];

function openReport(col, slug, name) {
  openModal(`🚩「${esc(name)}」を通報`, `
    <p class="muted small">管理者に知らせます。内容を確認して対応します。</p>
    <label class="field"><span>理由 <b class="req">必須</b></span>
      <select name="reason" required><option value="">選んでください</option>${REPORT_REASONS.map(r => `<option>${r}</option>`).join('')}</select></label>
    <label class="field"><span>詳しく（任意）</span><textarea name="comment" rows="3" maxlength="500" placeholder="どの部分がおかしいか など"></textarea></label>
    <label class="field"><span>名前（任意）</span><input name="user" maxlength="24" value="${esc(getUser())}"></label>
    <input name="website" class="hp" tabindex="-1" aria-hidden="true">`,
  async form => {
    await api('/report', {
      method: 'POST',
      body: JSON.stringify({ col, slug, reason: form.reason.value, comment: form.comment.value, user: form.user.value, website: form.website.value }),
    });
    toast('🚩 通報しました。ありがとうございます');
  }, { submitLabel: '通報する' });
}

/* ===== 画像アップロード ===== */
async function compressImage(file) {
  if (!/^image\//.test(file.type)) throw new Error('画像ファイルを選んでください。');
  if (file.type === 'image/gif') {
    if (file.size > 4.4e6) throw new Error(`GIFは4MBまでです（このファイルは${(file.size / 1e6).toFixed(1)}MB）。秒数を短くするか、サイズを小さくしてください。`);
    return file;
  }
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  for (const [type, q] of [['image/webp', 0.85], ['image/webp', 0.7], ['image/jpeg', 0.8]]) {
    const blob = await new Promise(r => canvas.toBlob(r, type, q));
    if (blob && blob.type === type && blob.size <= 3e6) return blob;
  }
  throw new Error('画像が大きすぎます。');
}

// アイコン（画像が無ければ名前の頭文字）
function avatarHtml(acc, cls) {
  return acc?.avatar
    ? `<img class="${cls}" src="${esc(acc.avatar)}" alt="">`
    : `<span class="${cls} avatar-letter" aria-hidden="true">${esc([...(acc?.name || '?')][0])}</span>`;
}

// 画像の切り抜き画面。正方形の枠の中で画像をドラッグ・拡大縮小して範囲を決める。
// 戻り値: { blob }（切り抜いた画像）/ { original: true }（切り抜かずに使う）/ null（キャンセル）
function openCropper(file, { size = 256, title = 'アイコンにする範囲を選ぶ', allowOriginal = false } = {}) {
  return new Promise(async resolve => {
    if (!/^image\//.test(file.type)) { alert('画像ファイルを選んでください。'); resolve(null); return; }
    let img;
    try { img = await createImageBitmap(file); } catch { alert('画像を読み込めませんでした。'); resolve(null); return; }
    const VIEW = 300; // 枠の大きさ（画面上）
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `
      <div class="modal cropper" role="dialog" aria-label="${esc(title)}">
        <h2>${esc(title)}</h2>
        <p class="muted small">ドラッグで位置、スライダー・ホイール・2本指で大きさを変えられます。</p>
        <div class="crop-stage"><canvas width="${VIEW * 2}" height="${VIEW * 2}"></canvas></div>
        <label class="crop-zoom">🔍<input type="range" min="1" max="5" step="0.01" value="1" aria-label="拡大"></label>
        <div class="btns">
          <button type="button" class="btn" data-cancel>キャンセル</button>
          ${allowOriginal ? '<button type="button" class="btn" data-original>切り抜かずに使う</button>' : ''}
          <button type="button" class="btn primary" data-ok>この範囲で決定</button>
        </div>
      </div>`;
    document.body.append(bg);
    const canvas = bg.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const zoom = bg.querySelector('input[type=range]');
    const base = Math.max(VIEW / img.width, VIEW / img.height); // 枠いっぱいに収まる最小の倍率
    let scale = base;
    let x = (VIEW - img.width * scale) / 2; // 画像の左上（枠の座標）
    let y = (VIEW - img.height * scale) / 2;
    const clamp = () => {
      x = Math.min(0, Math.max(VIEW - img.width * scale, x));
      y = Math.min(0, Math.max(VIEW - img.height * scale, y));
    };
    const draw = () => {
      ctx.setTransform(2, 0, 0, 2, 0, 0); // 高解像度表示
      ctx.clearRect(0, 0, VIEW, VIEW);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, x, y, img.width * scale, img.height * scale);
    };
    // 指定した点を中心に拡大縮小
    const zoomTo = (next, cx = VIEW / 2, cy = VIEW / 2) => {
      next = Math.min(base * 5, Math.max(base, next));
      x = cx - (cx - x) * (next / scale);
      y = cy - (cy - y) * (next / scale);
      scale = next;
      zoom.value = scale / base;
      clamp(); draw();
    };
    draw();

    // ドラッグ・ピンチ
    const pointers = new Map();
    let pinch = null;
    const pos = e => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * VIEW / r.width, y: (e.clientY - r.top) * VIEW / r.height }; };
    canvas.addEventListener('pointerdown', e => { canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, pos(e)); });
    canvas.addEventListener('pointermove', e => {
      if (!pointers.has(e.pointerId)) return;
      const prev = pointers.get(e.pointerId);
      const cur = pos(e);
      pointers.set(e.pointerId, cur);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch) zoomTo(scale * d / pinch, (a.x + b.x) / 2, (a.y + b.y) / 2);
        pinch = d;
      } else {
        x += cur.x - prev.x; y += cur.y - prev.y;
        clamp(); draw();
      }
    });
    const up = e => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', e => { e.preventDefault(); const p = pos(e); zoomTo(scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1), p.x, p.y); }, { passive: false });
    zoom.addEventListener('input', () => zoomTo(base * Number(zoom.value)));

    const done = v => { bg.remove(); resolve(v); };
    bg.querySelector('[data-cancel]').addEventListener('click', () => done(null));
    bg.addEventListener('keydown', e => { if (e.key === 'Escape') done(null); });
    bg.querySelector('[data-original]')?.addEventListener('click', () => done({ original: true }));
    bg.querySelector('[data-ok]').addEventListener('click', async () => {
      const out = Object.assign(document.createElement('canvas'), { width: size, height: size });
      const o = out.getContext('2d');
      o.imageSmoothingQuality = 'high';
      const k = size / VIEW;
      o.drawImage(img, x * k, y * k, img.width * scale * k, img.height * scale * k);
      let blob = await new Promise(r => out.toBlob(r, 'image/webp', 0.9));
      if (!blob || blob.type !== 'image/webp') blob = await new Promise(r => out.toBlob(r, 'image/png'));
      done({ blob });
    });
    bg.querySelector('[data-ok]').focus();
  });
}

async function uploadBlob(blob, user) {
  const r = await fetch(`${config.api}/images?user=${encodeURIComponent(user || '')}`, {
    method: 'POST', body: blob, headers: { 'content-type': blob.type, ...authHeaders() },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'アップロードに失敗しました。');
  return data.url;
}

// アイコン：範囲を選んで 256px でアップロード（キャンセルなら null）
async function uploadAvatar(file) {
  const res = await openCropper(file, { size: 256, title: 'アイコンにする範囲を選ぶ' });
  return res?.blob ? uploadBlob(res.blob, state.account?.name) : null;
}

async function uploadImage(file) {
  const blob = await compressImage(file);
  const r = await fetch(`${config.api}/images?user=${encodeURIComponent(getUser())}`, {
    method: 'POST', body: blob, headers: { 'content-type': blob.type, ...authHeaders() },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'アップロードに失敗しました。');
  return data.url;
}

function pickFile({ multiple = false } = {}) {
  return new Promise(resolve => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', multiple });
    input.addEventListener('change', () => resolve(multiple ? [...input.files] : input.files[0] || null));
    input.click();
  });
}

/* ===== 一覧 ===== */
// preset: /version/1.20.1 などの一覧ページ用 { kind, value }
function renderHome(preset = null) {
  Object.assign(state, { version: '', loader: '', tags: [] });
  let heading = 'Minecraft MOD Wiki';
  let lead = 'マイクラ（Minecraft）のMODを日本語で解説する、だれでも編集できるWikiです。';
  if (preset) {
    const def = LISTS[preset.kind];
    if (preset.kind === 'tag') state.tags = [preset.value];
    else state[preset.kind] = preset.value;
    heading = def.label(preset.value);
    lead = listDescription(preset.kind, preset.value, state.mods.filter(m => m[def.field].includes(preset.value)));
    setMeta(listTitle(preset.kind, preset.value), lead);
  } else {
    setMeta(homeTitle());
  }
  const used = new Set(state.mods.flatMap(m => [...m.versions, ...m.loaders, ...m.tags]));
  const opts = list => list.filter(v => used.has(v)); // 使われているタグだけ絞り込みに出す
  const single = (key, values) =>
    [`<button class="chip${!state[key] ? ' on' : ''}" data-k="${key}" data-v="">すべて</button>`]
      .concat(values.map(v => `<button class="chip${state[key] === v ? ' on' : ''}" data-k="${key}" data-v="${esc(v)}">${esc(v)}</button>`)).join('');
  const multi = TAGS.filter(t => used.has(t)).map(v => `<button class="chip${state.tags.includes(v) ? ' on' : ''}" data-tag="${esc(v)}">${esc(v)}</button>`).join('');
  const latestArticles = [...state.articles].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 4);

  app.innerHTML = `
    ${preset ? `<div class="page-head">
      <div><h1 class="page-title">${esc(heading)}</h1><p class="lead">${esc(lead)}</p></div>
      ${canEdit() ? `<a class="btn primary" href="${u('/new')}">＋ MODページを作る</a>` : ''}
    </div>` : homeIntro({ mods: state.mods, articles: state.articles, canEdit: canEdit() })}
    ${!preset && state.news.length ? `
      <section class="home-news">
        <div class="section-head"><h2>📢 お知らせ</h2><a href="${u('/news')}">すべて見る →</a></div>
        <ul class="news-list">${sortedNews().slice(0, 3).map(n => `
          <li><span class="news-date">${newsDate(n)}</span>${n.pinned ? '<span class="badge warn">📌 固定</span>' : ''}<a href="${u('/news')}#n-${n.id}">${esc(n.title)}</a></li>`).join('')}</ul>
      </section>` : ''}
    ${!preset && latestArticles.length ? `
      <section class="home-articles">
        <div class="section-head"><h2>📝 まとめ記事</h2><a href="${u('/articles')}">すべて見る →</a></div>
        <div class="grid">${latestArticles.map(a => card(a, 'articles')).join('')}</div>
      </section>` : ''}
    ${!preset && state.account?.following?.length ? '<section class="follow-feed" hidden><div class="section-head"><h2>👥 フォロー中の人の新着</h2></div><ul class="recent"></ul></section>' : ''}
    ${preset ? '' : '<h2 class="section-title">MOD一覧</h2>'}
    <div class="search-row">
      <input class="search" type="search" placeholder="MOD名・説明で絞り込み…" value="${esc(state.q)}">
      <a class="btn" data-fulltext href="${u('/search')}">🔍 本文も検索</a>
    </div>
    <div class="filters">
      <div class="filter-row"><span class="filter-label">バージョン</span>${single('version', opts(VERSIONS))}</div>
      <div class="filter-row"><span class="filter-label">ローダー</span>${single('loader', opts(LOADERS))}</div>
      <div class="filter-row"><span class="filter-label">タグ<small>（複数可）</small></span>${multi}</div>
    </div>
    <div class="count"></div>
    <div class="grid mods-grid"></div>`;

  const input = app.querySelector('.search');
  const full = app.querySelector('[data-fulltext]');
  const syncFull = () => full.setAttribute('href', `${u('/search')}${state.q ? `?q=${encodeURIComponent(state.q)}` : ''}`);
  input.addEventListener('input', () => { state.q = input.value; syncFull(); updateList(); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && state.q.trim()) navigate(`/search?q=${encodeURIComponent(state.q.trim())}`); });
  syncFull();
  app.querySelectorAll('.chip[data-k]').forEach(b => b.addEventListener('click', () => {
    state[b.dataset.k] = b.dataset.v;
    app.querySelectorAll(`.chip[data-k="${b.dataset.k}"]`).forEach(x => x.classList.toggle('on', x === b));
    updateList();
  }));
  app.querySelectorAll('.chip[data-tag]').forEach(b => b.addEventListener('click', () => {
    const t = b.dataset.tag;
    state.tags = state.tags.includes(t) ? state.tags.filter(x => x !== t) : [...state.tags, t];
    b.classList.toggle('on');
    updateList();
  }));
  updateList();
  loadFollowFeed();
}

async function loadFollowFeed() {
  const box = app.querySelector('.follow-feed');
  if (!box) return;
  let recent;
  try { recent = await api('/recent'); } catch { return; }
  const following = new Set(state.account.following);
  const items = recent.filter(r => !r.action && r.uid && following.has(r.uid)).slice(0, 8);
  if (!items.length || !app.contains(box)) return;
  box.querySelector('ul').innerHTML = items.map(r => `
    <li><span class="nowrap muted">${fmt(r.at)}</span>
      <a href="${KINDS[r.col || 'pages'].view(r.slug)}"><strong>${esc(r.name)}</strong></a>${r.col === 'articles' ? ' <span class="badge">記事</span>' : ''}
      ${r.isNew ? '<span class="badge new">新規</span>' : ''} ・ ${userLabel(r)}${r.comment ? ` <span class="muted">「${esc(r.comment)}」</span>` : ''}</li>`).join('');
  box.hidden = false;
}

function updateList() {
  const q = state.q.trim().toLowerCase();
  const list = state.mods.filter(m =>
    (!q || (m.name + m.summary + m.author + m.tags.join()).toLowerCase().includes(q)) &&
    (!state.version || m.versions.includes(state.version)) &&
    (!state.loader || m.loaders.includes(state.loader)) &&
    state.tags.every(t => m.tags.includes(t)));
  list.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  app.querySelector('.count').textContent = `${list.length} 件`;
  app.querySelector('.mods-grid').innerHTML = list.length ? list.map(m => card(m, 'pages')).join('')
    : `<div class="empty">該当するMODがありません${q ? `<br><br><a class="btn" href="${u('/search')}?q=${encodeURIComponent(q)}">本文も含めて「${esc(q)}」を検索</a>` : ''}</div>`;
}

function renderArticles() {
  setMeta(ARTICLES_TITLE, ARTICLES_DESC);
  const list = [...state.articles].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  app.innerHTML = `
    <div class="page-head">
      <div><h1 class="page-title">まとめ記事</h1><p class="lead">${esc(ARTICLES_DESC)} だれでも自由に記事を書けます。</p></div>
      ${canEdit() ? `<a class="btn primary" href="${u('/articles/new')}">＋ 記事を書く</a>` : ''}
    </div>
    <div class="count">${list.length} 件</div>
    <div class="grid">${list.map(a => card(a, 'articles')).join('') || '<div class="empty">まだ記事がありません。最初の記事を書いてみませんか？</div>'}</div>`;
}

/* ===== お知らせ ===== */
async function renderNews() {
  setMeta(pageTitle('お知らせ'), 'Minecraft MOD Wiki からのお知らせ');
  await loadNews();
  const list = sortedNews();
  app.innerHTML = `
    <h1 class="page-title">📢 お知らせ</h1>
    ${list.length ? list.map(n => `
      <article class="panel news-item" id="n-${n.id}">
        <div class="news-meta"><span class="news-date">${newsDate(n)}</span>${n.pinned ? '<span class="badge warn">📌 固定</span>' : ''}${n.updatedAt ? `<span class="muted small">（${fmt(n.updatedAt)} 更新）</span>` : ''}</div>
        <h2>${esc(n.title)}</h2>
        ${n.body ? `<div class="md">${renderMarkdown(n.body)}</div>` : ''}
      </article>`).join('') : '<div class="empty">お知らせはまだありません。</div>'}`;
  const target = location.hash && document.getElementById(location.hash.slice(1));
  if (target) target.scrollIntoView();
}

/* ===== コメント ===== */
// 本文は文字のまま表示（URLだけリンクにする）
const commentHtml = t => esc(t).replace(/https?:\/\/[^\s<>"]+/g, url => `<a href="${url}" target="_blank" rel="noopener nofollow ugc">${url}</a>`).replace(/\n/g, '<br>');
function bindComments(col, slug) {
  const box = app.querySelector('#comments');
  const listEl = box.querySelector('.comment-list');
  const base = `/${col}/${encodeURIComponent(slug)}/comments`;
  const draw = items => {
    box.querySelector('.comment-count').textContent = items.length ? `${items.length}件` : '';
    listEl.innerHTML = items.length ? items.map(c => `
      <li class="comment" id="c-${c.id}">
        <div class="comment-head">${userLabel(c)} <span class="muted small">${fmt(c.at)}</span>
          ${c.mine || state.admin ? `<button type="button" class="linkish small danger-text" data-del-comment="${c.id}">削除</button>` : ''}</div>
        <div class="comment-body">${commentHtml(c.text)}</div>
      </li>`).join('') : '<li class="muted small">まだコメントはありません。最初のコメントを書いてみよう！</li>';
    listEl.querySelectorAll('[data-del-comment]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('このコメントを削除しますか？')) return;
      try { draw(await api(`${base}/delete`, { method: 'POST', body: JSON.stringify({ id: b.dataset.delComment }) })); toast('コメントを削除しました'); } catch (err) { alert(err.message); }
    }));
  };
  api(base).then(items => { if (app.contains(box)) draw(items); }).catch(() => { listEl.innerHTML = '<li class="muted small">コメントを読み込めませんでした。</li>'; });
  box.querySelector('[data-comment-login]')?.addEventListener('click', () => openAuth('login'));
  const form = box.querySelector('.comment-form');
  if (!form) return;
  const len = box.querySelector('.comment-len');
  form.text.addEventListener('input', () => { len.textContent = `${form.text.value.length} / 1000`; });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    try {
      const user = form.user?.value.trim() || '';
      if (user) setUser(user);
      const items = await api(base, { method: 'POST', body: JSON.stringify({ text: form.text.value, user, website: form.website.value }) });
      form.text.value = '';
      len.textContent = '0 / 1000';
      draw(items);
      toast('💬 コメントしました');
    } catch (err) { alert(err.message); }
    btn.disabled = false;
  });
}

/* ===== お問い合わせ ===== */
const CONTACT_TYPES = ['質問', '要望・アイデア', '不具合の報告', '削除・修正の依頼', 'その他'];
function renderContact() {
  setMeta(pageTitle('お問い合わせ'), 'Minecraft MOD Wiki の運営へのお問い合わせ');
  const from = new URLSearchParams(location.search).get('page') || '';
  app.innerHTML = `
    <h1 class="page-title">📮 運営へのお問い合わせ</h1>
    <p class="lead">質問・要望・不具合の報告などはこちらからどうぞ。内容は運営（管理者）だけが見られます。</p>
    <p class="muted small">特定のページの荒らし・間違いは、そのページ下の「🚩 このページを通報」からも送れます。<br>
      気軽な質問や相談は、LINEオープンチャット<a href="${esc(OPENCHAT.url)}" target="_blank" rel="noopener">「${esc(OPENCHAT.name)}」</a>でもどうぞ。</p>
    <form class="panel contact-form">
      <label class="field"><span>種類</span>
        <select name="type">${CONTACT_TYPES.map(t => `<option>${t}</option>`).join('')}</select></label>
      ${state.account ? `<div class="field"><span>送る人</span><div class="as-account">👤 <strong>${esc(state.account.name)}</strong> として送ります</div></div>`
        : `<label class="field"><span>名前 <small>任意</small></span><input name="user" maxlength="24" value="${esc(getUser() || '')}"></label>`}
      <label class="field"><span>返信先 <small>任意・返事がほしいときだけ（メールアドレス・Xのアカウントなど）。運営以外には公開されません</small></span><input name="reply" maxlength="120" placeholder="例: steve@example.com / @steve_mc"></label>
      <label class="field"><span>関係するページ <small>任意</small></span><input name="page" maxlength="200" value="${esc(from)}" placeholder="例: https://kaikomziu.github.io/mc-mod-wiki/mod/jei"></label>
      <label class="field"><span>お問い合わせ内容 <b class="req">必須</b></span><textarea name="message" rows="7" maxlength="3000" required></textarea></label>
      <input name="website" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
      <div class="btns"><button class="btn primary">送信する</button></div>
    </form>`;
  const form = app.querySelector('.contact-form');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      await api('/contact', { method: 'POST', body: JSON.stringify({
        type: form.type.value, user: form.user?.value || '', reply: form.reply.value, page: form.page.value,
        message: form.message.value, website: form.website.value,
      }) });
      app.innerHTML = `<h1 class="page-title">📮 運営へのお問い合わせ</h1>
        <div class="empty">送信しました。ありがとうございます！<br>${form.reply.value.trim() ? '返事が必要な内容には、入力していただいた返信先にお返事します。' : '返信先が無いため、お返事はできません。'}<br><br><a class="btn" href="${u('/')}">トップへ戻る</a></div>`;
    } catch (err) { alert(err.message); btn.disabled = false; }
  });
}

/* ===== 検索 ===== */
async function renderSearch() {
  const q = new URLSearchParams(location.search).get('q') || '';
  setMeta(pageTitle(q ? `「${q}」の検索結果` : '検索'));
  app.innerHTML = `
    <h1 class="page-title">検索</h1>
    <form class="search-page-form" role="search"><input class="search" name="q" type="search" value="${esc(q)}" placeholder="MOD名・アイテム名・エラー内容・ユーザー名など" autofocus><button class="btn primary">検索</button></form>
    <div class="user-results"></div>
    <div class="search-results">${q ? '<div class="loading">検索中…</div>' : '<p class="muted">MODページとまとめ記事の本文、ユーザー名から探します。スペースで区切ると、すべてを含むページを探します。<br>Wikiにまだ無いMODは、Modrinth・CurseForge からも探して表示します（英語名で探すとよく見つかります）。</p>'}</div>
    <div class="external-results"></div>`;
  if (q) renderExternal(q);
  app.querySelector('form').addEventListener('submit', e => {
    e.preventDefault();
    const v = e.target.q.value.trim();
    navigate(v ? `/search?q=${encodeURIComponent(v)}` : '/search');
  });
  if (!q) return;
  renderUserResults(q);
  let results;
  try { results = await api(`/search?q=${encodeURIComponent(q)}`); } catch (e) { app.querySelector('.search-results').innerHTML = errorBox(e); return; }
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const mark = s => {
    let h = esc(s);
    for (const w of words) h = h.replace(new RegExp(esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), m => `<mark>${m}</mark>`);
    return h;
  };
  app.querySelector('.search-results').innerHTML = results.length ? `
    <p class="count">「${esc(q)}」の検索結果: ${results.length} 件</p>
    <ol class="results">${results.map(r => `
      <li>
        <a href="${KINDS[r.col].view(r.slug)}"><strong>${mark(r.name)}</strong></a>
        <span class="badge">${KINDS[r.col].label}</span>
        ${r.summary ? `<div class="muted small">${mark(r.summary)}</div>` : ''}
        <p>${mark(r.snippet)}</p>
      </li>`).join('')}</ol>`
    : `<div class="empty">「${esc(q)}」に一致するページはありませんでした。${canEdit() ? `<br><br><a class="btn" href="${u('/new')}">MODページを作る</a> <a class="btn" href="${u('/articles/new')}">記事を書く</a>` : ''}</div>`;
}

// 名前にキーワードを含むユーザー（プロフィールへのリンク）
async function renderUserResults(q) {
  const box = app.querySelector('.user-results');
  if (!state.users.size) await loadUsers();
  if (!app.contains(box)) return;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = [...state.users.values()]
    .filter(a => words.every(w => a.name.toLowerCase().includes(w)))
    .sort((a, b) => (a.name.toLowerCase() === q.toLowerCase() ? -1 : 0) - (b.name.toLowerCase() === q.toLowerCase() ? -1 : 0) || a.name.localeCompare(b.name))
    .slice(0, 20);
  box.innerHTML = hits.length ? `
    <section class="user-hits">
      <h2 class="section-title">👤 ユーザー（${hits.length}）</h2>
      <ul class="user-hit-list">${hits.map(a => `
        <li><a class="user-hit" href="${userHref(a.name)}">${avatarHtml(a, 'nav-avatar')} <strong>${esc(a.name)}</strong>${titleBadges(a.titles)}</a></li>`).join('')}</ul>
    </section>` : '';
}

// Wikiにまだ無いMODを Modrinth / CurseForge から探して、ページ作成につなげる
const TYPE_LABEL = { mod: 'MOD', modpack: 'MODパック', resourcepack: 'リソースパック', shader: 'シェーダー', datapack: 'データパック' };
async function renderExternal(q) {
  const box = app.querySelector('.external-results');
  box.innerHTML = '<div class="loading small">Modrinth・CurseForge を検索中…</div>';
  let res;
  try { res = await api(`/external?q=${encodeURIComponent(q)}`); } catch { box.innerHTML = ''; return; }
  if (!app.contains(box)) return; // 別のページに移動していたら何もしない
  const known = new Set(state.mods.flatMap(m => [m.name.toLowerCase(), (m.link || '').replace(/\/+$/, '')]));
  const item = r => {
    const inWiki = known.has(r.name.toLowerCase()) || known.has(r.url.replace(/\/+$/, ''));
    const wikiPage = inWiki && state.mods.find(m => m.name.toLowerCase() === r.name.toLowerCase() || (m.link || '').replace(/\/+$/, '') === r.url.replace(/\/+$/, ''));
    return `
      <li>
        ${r.icon ? `<img class="ext-icon" src="${esc(r.icon)}" alt="" loading="lazy">` : '<span class="ext-icon"></span>'}
        <div class="ext-main">
          <a href="${esc(r.url)}" target="_blank" rel="noopener"><strong>${esc(r.name)}</strong></a>
          <span class="badge">${TYPE_LABEL[r.type] || 'MOD'}</span>
          <span class="muted small">${r.author ? `by ${esc(r.author)} ・ ` : ''}⬇ ${formatDownloads(r.downloads)}</span>
          <div class="muted small">${esc(r.summary)}</div>
        </div>
        <div class="ext-act">${wikiPage ? `<a class="btn" href="${KINDS.pages.view(wikiPage.slug)}">Wikiで見る</a>`
          : canEdit() ? `<a class="btn primary" href="${u('/new')}?from=${encodeURIComponent(r.url)}">＋ ページを作る</a>` : ''}</div>
      </li>`;
  };
  const col = (title, list, note) => `
    <div class="ext-col">
      <h3>${title}</h3>
      ${list.length ? `<ul class="ext-list">${list.map(item).join('')}</ul>` : `<p class="muted small">${note}</p>`}
    </div>`;
  box.innerHTML = `
    <section class="external">
      <h2>🌐 Wikiの外で見つかったもの</h2>
      <p class="muted small">「＋ ページを作る」を押すと、MOD名・対応バージョンなどを読み込んだ状態で新しいページを作れます。</p>
      <div class="ext-cols">
        ${col('Modrinth', res.modrinth, '見つかりませんでした。英語名で探すと見つかりやすいです。')}
        ${col('CurseForge', res.curseforge, !res.curseforgeEnabled ? 'CurseForge の検索は準備中です。' : res.curseforgeError === 'forbidden' ? 'CurseForge の検索は今は使えません。CurseForge のURLを編集画面の「🔍 情報を取得」に入れれば、そこから読み込めます。' : res.curseforgeError ? 'CurseForge に接続できませんでした。' : '見つかりませんでした。')}
      </div>
    </section>`;
}

/* ===== ページ表示（MOD / 記事） ===== */
function bindPageView() {
  app.querySelectorAll('[data-jump]').forEach(a => a.addEventListener('click', e => {
    e.preventDefault();
    document.getElementById(a.dataset.jump).scrollIntoView({ behavior: 'smooth' });
  }));
}

async function renderView(col, slug) {
  const K = KINDS[col];
  loading();
  let m;
  try { m = await api(`/${col}/${encodeURIComponent(slug)}`); } catch (e) {
    if (e.status !== 404) { app.innerHTML = errorBox(e); return; }
    const del = e.data?.deleted;
    setMeta(pageTitle('ページが見つかりません'));
    app.innerHTML = `<div class="crumb">${crumbRoot(col)}</div>
      <h1 class="page-title">${esc(slug)}</h1>
      <div class="empty">${esc(e.message)}<br><br>${
        del ? (state.admin ? '<button class="btn primary" data-restore>♻️ このページを復元する</button>' : '')
          : canEdit() ? `<a class="btn primary" href="${K.newPath}/${encodeURIComponent(slug)}">このページを作成する</a>` : ''}</div>`;
    app.querySelector('[data-restore]')?.addEventListener('click', () => adminAction(`/${col}/${encodeURIComponent(slug)}/restore`, 'POST', null, '復元しました'));
    return;
  }
  if (col === 'pages') setMeta(modTitle(m), modDescription(m));
  else setMeta(articleTitle(m), articleDescription(m));
  const s = encodeURIComponent(m.slug);
  app.innerHTML = `
    <div class="page-tools">
      <div class="crumb">${crumbRoot(col)} › ${esc(m.name)}</div>
      <div class="btns">
        ${state.admin ? `
          <button class="btn" data-lock>${m.locked ? '🔓 ロック解除' : '🔒 ロック'}</button>
          <button class="btn danger" data-delete>🗑 削除</button>` : ''}
        <button class="btn like-btn${m.liked ? ' on' : ''}" data-like aria-pressed="${!!m.liked}">${m.liked ? '♥' : '♡'} いいね <b>${m.likes || 0}</b></button>
        <a class="btn" href="${K.hist(m.slug)}">🕘 履歴</a>
        ${canEdit(m) ? `<a class="btn primary" href="${K.edit(m.slug)}">✏️ 編集</a>` : `<span class="btn" aria-disabled="true">🔒 ${m.locked ? 'ロック中' : '編集停止中'}</span>`}
      </div>
    </div>
    ${m.locked ? `<div class="notice lock">🔒 このページはロックされています。${state.admin ? '（管理者は編集できます）' : '管理者のみ編集できます。'}</div>` : ''}
    ${pageView(m, col)}
    <div class="page-foot">
      <span>作成: ${userLabel({ uid: m.createdUid, user: m.createdBy })} ・ 最終更新: ${fmt(m.updatedAt)}（${userLabel({ uid: m.log?.[0]?.uid, user: m.updatedBy })}）・ 版 ${m.rev}</span>
      <button type="button" class="linkish report-link" data-report>🚩 このページを通報</button>
    </div>
    <section class="comments" id="comments">
      <h2 class="section-title">💬 コメント <small class="comment-count"></small></h2>
      <ul class="comment-list"><li class="muted small">読み込み中…</li></ul>
      ${m.commentsAccountOnly ? '<p class="muted small">🔒 このページは、アカウントを持っている人だけコメントできます。</p>' : ''}
      ${state.editLocked && !state.admin ? '<p class="muted small">現在、コメントの受付を停止しています。</p>'
        : m.commentsAccountOnly && !state.account && !state.admin ? '<div class="comment-login"><button type="button" class="btn primary" data-comment-login>ログイン / アカウント作成してコメントする</button></div>' : `
      <form class="comment-form">
        ${state.account ? '' : `<div class="comment-guest"><input name="user" maxlength="24" placeholder="名前" value="${esc(getUser() || '')}" required><span class="muted small">・<button type="button" class="linkish" data-comment-login>ログイン</button>すると名前の横にアイコンと肩書きが出ます</span></div>`}
        <textarea name="text" rows="3" maxlength="1000" required placeholder="感想・質問・補足などをどうぞ（1000文字まで）"></textarea>
        <input name="website" tabindex="-1" autocomplete="off" class="hp" aria-hidden="true">
        <div class="btns"><span class="muted small comment-len">0 / 1000</span><button class="btn primary">コメントする</button></div>
      </form>`}
    </section>`;
  bindPageView();
  bindComments(col, m.slug);
  app.querySelector('[data-report]').addEventListener('click', () => openReport(col, m.slug, m.name));
  app.querySelector('[data-like]').addEventListener('click', async e => {
    if (!state.account) { openAuth('login'); toast('いいねするにはログインしてください'); return; }
    const btn = e.currentTarget;
    const on = !btn.classList.contains('on');
    btn.disabled = true;
    try {
      const r = await api(`/${col}/${encodeURIComponent(m.slug)}/like`, { method: 'POST', body: JSON.stringify({ like: on }) });
      btn.classList.toggle('on', r.liked);
      btn.setAttribute('aria-pressed', r.liked);
      btn.innerHTML = `${r.liked ? '♥' : '♡'} いいね <b>${r.likes}</b>`;
      const item = listOf(col).find(x => x.slug === m.slug);
      if (item) item.likes = r.likes;
    } catch (err) { alert(err.message); }
    btn.disabled = false;
  });
  app.querySelector('[data-lock]')?.addEventListener('click', () =>
    adminAction(`/${col}/${s}/lock`, 'POST', { locked: !m.locked }, m.locked ? 'ロックを解除しました' : 'ロックしました'));
  app.querySelector('[data-delete]')?.addEventListener('click', () => {
    if (confirm(`「${m.name}」を削除しますか？\n（管理画面からいつでも復元できます）`)) adminAction(`/${col}/${s}`, 'DELETE', null, '削除しました');
  });
}

async function adminAction(path, method, body, msg) {
  try {
    await api(path, { method, body: body ? JSON.stringify(body) : undefined });
    await Promise.all([loadData(), refreshSettings()]);
    toast(msg);
    route();
  } catch (e) { alert(e.message); }
}

/* ===== 編集 ===== */
const slugify = s => s.toLowerCase().normalize('NFKC').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);

const RECIPE_CRAFT = '\n```recipe\n素材 | 素材 | 素材\n     | 棒   |\n     | 棒   |\n=> 完成品 x1\n```\n';
const RECIPE_SMELT = '\n```smelt\n素材\n=> 完成品\n```\n';

// ページのひな形（見出しごと）。「📋 テンプレ」で足りない見出しだけ追加できる
const TEMPLATES = {
  pages: [
    ['概要', '（どんなMODか、何ができるかを書く）'],
    ['主な要素', '- '],
    ['導入方法', '1. 対応するMinecraftのバージョンとMODローダー（Forge / NeoForge / Fabric）を用意する\n2. 前提MODがあれば先に入れる\n3. ダウンロードした .jar ファイルを mods フォルダに入れる\n4. ゲームを起動し、タイトル画面の「Mods」に表示されれば成功'],
    ['前提MOD', '- なし'],
    ['序盤の進め方', '1. '],
    ['レシピ', RECIPE_CRAFT.trim()],
    ['よくあるエラー・注意点', '> [!WARN]\n> '],
    ['おすすめの組み合わせ', '- [[jei]] — レシピ確認に便利'],
  ],
  articles: [
    ['はじめに', '（この記事で紹介する内容を書く）'],
    ['紹介するMOD', '### 1. [[mod-id]]\n- おすすめポイント: \n- 対応バージョン: \n\n### 2. [[mod-id]]\n- おすすめポイント: '],
    ['まとめ', ''],
  ],
};
const templateText = col => TEMPLATES[col].map(([h, b]) => `## ${h}\n${b}\n`).join('\n');

const TOOLBAR = [
  ['B', '太字', 'wrap', '**', '**', '太字'],
  ['I', '斜体', 'wrap', '*', '*', '斜体'],
  ['S', '取り消し線', 'wrap', '~~', '~~', '取り消し'],
  ['🖍', 'マーカー', 'wrap', '==', '==', '強調'],
  ['H', '見出し', 'line', '## '],
  ['H3', '小見出し', 'line', '### '],
  ['・', '箇条書き', 'line', '- '],
  ['1.', '番号付き', 'line', '1. '],
  ['🔗', 'リンク', 'wrap', '[', '](https://)', 'リンク文字'],
  ['📄', '他のMODページ', 'wrap', '[[', ']]', 'ページID'],
  ['📷', '画像・GIFをカーソル位置にアップロード（貼り付け・ドラッグ＆ドロップでもOK）', 'upload'],
  ['🎬', '動画（YouTube・ニコニコ動画）を貼る', 'video'],
  ['表', '表', 'insert', '\n| 項目 | 説明 |\n|---|---|\n| | |\n'],
  ['🧱', '作業台レシピ', 'insert', RECIPE_CRAFT],
  ['🔥', 'かまどレシピ', 'insert', RECIPE_SMELT],
  ['💡', 'ヒント', 'insert', '\n> [!TIP]\n> '],
  ['⚠️', '注意', 'insert', '\n> [!WARN]\n> '],
  ['`', 'コード', 'wrap', '`', '`', 'code'],
  ['📋 テンプレ', '足りない見出しをひな形から追加', 'template'],
];

function chipGroup(group, all, selected) {
  return `<div class="pick-row" data-group="${group}">${all.map(v =>
    `<button type="button" class="chip${selected.includes(v) ? ' on' : ''}" aria-pressed="${selected.includes(v)}" data-v="${esc(v)}">${esc(v)}</button>`).join('')}</div>`;
}

async function renderEdit(col, slug, { isNew = false, revertFrom = null } = {}) {
  const K = KINDS[col];
  const isMod = col === 'pages';
  loading();
  let cur = null;
  if (!isNew) {
    try { cur = await api(`/${col}/${encodeURIComponent(slug)}`); } catch (e) { app.innerHTML = errorBox(e); return; }
  } else if (slug && listOf(col).some(m => m.slug === slug)) {
    navigate(K.edit(slug)); return;
  }
  if (!canEdit(cur)) {
    app.innerHTML = `<div class="empty">🔒 ${cur?.locked ? 'このページはロックされているため、管理者しか編集できません。' : '現在、編集は一時停止されています。'}
      <br><br><a class="btn" href="${cur ? K.view(slug) : K.listPath}">戻る</a></div>`;
    return;
  }
  let src = cur || { name: '', summary: '', versions: [], loaders: [], tags: [], author: '', link: '', image: '', body: templateText(col), downloads: 0, downloadsAt: '' };
  if (revertFrom) {
    try { src = await api(`/${col}/${encodeURIComponent(slug)}/history/${revertFrom}`); } catch (e) { app.innerHTML = errorBox(e); return; }
  }
  const baseRev = cur?.rev || 0;

  // 下書き：?draft=ID で開いたらその内容を読み込む。既存ページに下書きがあれば知らせる
  const draftParam = new URLSearchParams(location.search).get('draft');
  const draftId = draftParam || (isNew ? `${col}:new:${Date.now().toString(36)}` : `${col}:${slug}`);
  const openedDraft = draftParam ? drafts.get(draftParam) : null;
  if (openedDraft) {
    src = { ...src, ...openedDraft.data };
    if (isNew && openedDraft.data.slug) slug = openedDraft.data.slug;
  }
  const waitingDraft = !draftParam && !isNew && !revertFrom ? drafts.get(draftId) : null;
  const what = isMod ? 'MODページ' : '記事';
  setMeta(pageTitle(isNew ? `新しい${what}を作る` : `${cur.name} を編集`));

  app.innerHTML = `
    <div class="crumb">${crumbRoot(col)} › ${isNew ? `新しい${what}` : `<a href="${K.view(slug)}">${esc(cur.name)}</a> › 編集`}</div>
    <h1 class="page-title">${isNew ? `新しい${what}を作る` : `「${esc(cur.name)}」を編集`}</h1>
    ${revertFrom ? `<div class="notice">版 ${revertFrom} の内容を読み込みました。保存すると、この内容で新しい版として差し戻されます。</div>` : ''}
    ${waitingDraft ? `<div class="notice draft-notice">📄 このページの下書きがあります（${fmt(waitingDraft.savedAt)} 保存）
      <a class="btn primary" href="${draftHref(draftId, waitingDraft)}">下書きを開く</a>
      <button type="button" class="btn" data-drop-draft>下書きを削除</button></div>` : ''}
    ${openedDraft ? `<div class="notice draft-notice">📄 ${fmt(openedDraft.savedAt)} に保存した下書きを開いています。${
      !isNew && cur && openedDraft.baseRev < cur.rev ? '<br><strong>下書きのあとにページが更新されています。</strong>保存すると相手の変更を上書きするので、<a href="' + K.hist(slug) + '" target="_blank">履歴</a>で確認してください。' : ''}</div>` : ''}
    <form class="edit-form" autocomplete="off">
      <section class="panel">
        <h2>基本情報</h2>
        ${isMod ? `
        <div class="fetch-box">
          <label class="field wide"><span>配布ページURL <small>CurseForge / Modrinth</small></span>
            <div class="input-with-btn"><input name="link" type="url" maxlength="400" value="${esc(src.link)}" placeholder="https://www.curseforge.com/minecraft/mc-mods/..."><button type="button" class="btn" data-fetch>🔍 情報を取得</button></div>
          </label>
          <p class="muted small">URLを入れて「情報を取得」を押すと、MOD名・対応バージョン・ローダー・作者・ダウンロード数などを読み込みます（反映前に確認できます）。</p>
        </div>` : ''}
        <div class="fields">
          <label class="field"><span>${isMod ? 'MOD名' : '記事のタイトル'} <b class="req">必須</b></span><input name="name" maxlength="80" required value="${esc(src.name)}" ${isMod ? '' : 'placeholder="例: 1.20.1 おすすめ軽量化MOD 5選"'}></label>
          ${isNew ? `<label class="field"><span>ページID <b class="req">必須</b><small>URLになります（半角英数字とハイフン）</small></span><input name="slug" maxlength="50" pattern="[a-z0-9][a-z0-9\\-]*" required value="${esc(slug || '')}" placeholder="${isMod ? '例: create' : '例: lightweight-mods-1-20-1'}"></label>` : ''}
          <label class="field wide"><span>ひとこと説明</span><input name="summary" maxlength="200" value="${esc(src.summary)}" placeholder="一覧や検索結果に表示される短い説明"></label>
          ${isMod ? `<label class="field"><span>作者</span><input name="author" maxlength="80" value="${esc(src.author)}"></label>` : ''}
          <label class="field ${isMod ? '' : 'wide'}"><span>${isMod ? 'アイコン・画像' : 'アイキャッチ画像'}</span>
            <div class="input-with-btn"><input name="image" maxlength="400" value="${esc(src.image)}" placeholder="https://... またはアップロード"><button type="button" class="btn" data-upload-image>📷</button></div>
          </label>
          <input type="hidden" name="downloads" value="${src.downloads || 0}"><input type="hidden" name="downloadsAt" value="${esc(src.downloadsAt || '')}">
        </div>
        <div class="downloads-note muted small">${src.downloads ? `ダウンロード数: ${src.downloads.toLocaleString()}（${esc(src.downloadsAt)} 時点）` : ''}</div>
      </section>
      <section class="panel">
        <h2>タグ <small>クリックで選択（複数選択できます）${isMod ? '' : '・記事は任意'}</small></h2>
        <div class="pick"><div class="pick-label">対応バージョン</div>${chipGroup('versions', VERSIONS, src.versions)}</div>
        <div class="pick"><div class="pick-label">MODローダー</div>${chipGroup('loaders', LOADERS, src.loaders)}</div>
        <div class="pick"><div class="pick-label">ジャンル</div>${chipGroup('tags', TAGS, src.tags)}</div>
      </section>
      <section class="panel">
        <h2>本文 <small><a href="${u('/help')}" target="_blank">書き方を見る</a></small></h2>
        <div class="toolbar">${TOOLBAR.map((t, i) => `<button type="button" title="${t[1]}" data-tool="${i}">${t[0]}</button>`).join('')}</div>
        <div class="editor">
          <div class="editor-tabs"><button type="button" class="on" data-pane="write">書く</button><button type="button" data-pane="preview">プレビュー</button></div>
          <textarea name="body" spellcheck="false">${esc(src.body)}</textarea>
          <div class="preview md"></div>
        </div>
      </section>
      <section class="panel save-panel">
        <div class="fields">
          ${state.account
            ? `<div class="field"><span>編集者</span><div class="as-account">👤 <strong>${esc(state.account.name)}</strong> として保存されます</div><input type="hidden" name="user" value="${esc(state.account.name)}"></div>`
            : `<label class="field"><span>ユーザー名 <b class="req">必須</b><small>履歴に表示されます ・ <a href="${u('/login')}" data-open-login>ログイン / アカウント作成</a></small></span><input name="user" maxlength="24" required value="${esc(getUser())}"></label>`}
          <label class="field"><span>編集内容の要約</span><input name="comment" maxlength="120" value="${esc(src.comment ?? (revertFrom ? `版 ${revertFrom} に差し戻し` : ''))}" placeholder="例: 導入方法を追記"></label>
          <input name="website" class="hp" tabindex="-1" aria-hidden="true">
        </div>
        ${(() => {
          const canSet = isNew || state.admin || (!!state.account && state.account.uid === cur?.createdUid);
          const on = src.commentsAccountOnly ?? cur?.commentsAccountOnly;
          return `<label class="check comment-setting${canSet ? '' : ' muted'}"><input type="checkbox" name="commentsAccountOnly"${on ? ' checked' : ''}${canSet ? '' : ' disabled'}> 💬 コメントはアカウントを持っている人だけにする
            <small class="muted">${canSet ? '（あとから変えられるのは、このページを作った人と管理者だけです）' : '（このページを作った人と管理者だけが変えられます）'}</small></label>`;
        })()}
        <div class="form-error" role="alert"></div>
        <div class="save-row">
          <span class="draft-status muted small">下書きはこのブラウザに保存されます（30秒ごとに自動保存）</span>
          <div class="btns">
            <a class="btn" href="${isNew ? K.listPath : K.view(slug)}">キャンセル</a>
            <button class="btn" type="button" data-save-draft>💾 下書き保存</button>
            <button class="btn primary" type="submit">公開する</button>
          </div>
        </div>
      </section>
    </form>`;

  const form = app.querySelector('form');
  const ta = form.body;
  const preview = app.querySelector('.preview');
  const errEl = app.querySelector('.form-error');
  let rev = baseRev;
  const refresh = () => { preview.innerHTML = renderMarkdown(ta.value) || '<p class="muted">（プレビュー）</p>'; };
  const dirty = () => { state.dirty = true; };
  refresh();
  state.dirty = false;
  form.addEventListener('input', dirty);
  ta.addEventListener('input', refresh);

  // ----- 下書き保存 -----
  const draftStatus = app.querySelector('.draft-status');
  const collect = () => {
    const picked = g => [...app.querySelectorAll(`[data-group="${g}"] .chip.on`)].map(b => b.dataset.v);
    return {
      name: form.name.value, slug: form.slug?.value || '', summary: form.summary.value, author: form.author?.value || '',
      link: form.link?.value || '', image: form.image.value, body: ta.value, comment: form.comment.value,
      versions: picked('versions'), loaders: picked('loaders'), tags: picked('tags'),
      downloads: Number(form.downloads.value) || 0, downloadsAt: form.downloadsAt.value,
      commentsAccountOnly: form.commentsAccountOnly.checked,
    };
  };
  const saveDraft = (auto = false) => {
    const ok = drafts.put(draftId, { col, slug: isNew ? '' : slug, isNew, data: collect(), baseRev: rev, savedAt: new Date().toISOString() });
    if (!ok) { draftStatus.textContent = '⚠️ 下書きを保存できませんでした（ブラウザの保存領域がいっぱいか、使えない設定です）'; return; }
    state.dirty = false;
    draftStatus.textContent = `💾 ${auto ? '自動で' : ''}下書き保存しました（${new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}）`;
    if (!auto) toast('💾 下書きを保存しました');
    // 新規ページは、再読み込みしても同じ下書きを開けるようURLに下書きIDを入れておく
    if (!draftParam && isNew) history.replaceState(null, '', `${location.pathname}?draft=${encodeURIComponent(draftId)}`);
  };
  app.querySelector('[data-save-draft]').addEventListener('click', () => saveDraft(false));
  app.querySelector('[data-drop-draft]')?.addEventListener('click', e => {
    if (!confirm('この下書きを削除しますか？')) return;
    drafts.remove(draftId);
    e.target.closest('.draft-notice').remove();
    toast('下書きを削除しました');
  });
  const autoSave = setInterval(() => {
    if (!app.contains(form)) { clearInterval(autoSave); return; }
    if (state.dirty) saveDraft(true);
  }, 30_000);

  if (isNew) {
    let touched = !!slug;
    form.slug.addEventListener('input', () => { touched = true; });
    form.name.addEventListener('input', () => { if (!touched) form.slug.value = slugify(form.name.value); });
  }

  const setChip = (b, on) => { b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); };
  app.querySelectorAll('.pick-row .chip').forEach(b => b.addEventListener('click', () => { setChip(b, !b.classList.contains('on')); dirty(); }));

  // 本文への画像・GIFアップロード（カーソル位置に入る。複数まとめてOK）
  let uploadSeq = 0;
  const insertImages = async files => {
    files = files.filter(f => f.type.startsWith('image/'));
    if (!files.length) return;
    const marks = files.map(() => `![アップロード中…${++uploadSeq}]()`);
    ta.setRangeText(`\n${marks.join('\n')}\n`, ta.selectionStart, ta.selectionEnd, 'end');
    refresh();
    let ok = 0;
    for (const [i, file] of files.entries()) { // 1枚ずつ順番に
      try {
        const imgUrl = await uploadImage(file);
        const alt = file.name.replace(/\.[a-z0-9]+$/i, '').replace(/[[\]|]/g, '').slice(0, 40) || '画像';
        ta.value = ta.value.replace(marks[i], `![${alt}](${imgUrl})`);
        ok++;
      } catch (e) {
        ta.value = ta.value.replace(`${marks[i]}\n`, '').replace(marks[i], '');
        alert(`${file.name}: ${e.message}`);
      }
      refresh();
    }
    if (ok) toast(`📷 ${ok}枚アップロードしました（![説明|300](…) のように書くと幅を変えられます）`);
    dirty();
  };
  ta.addEventListener('paste', e => {
    const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); insertImages(files); }
  });
  // ドラッグ＆ドロップ：落とした位置にカーソルを移してから入れる
  ta.addEventListener('dragover', e => {
    if ([...e.dataTransfer.items].some(i => i.kind === 'file')) { e.preventDefault(); ta.classList.add('drop'); }
  });
  ta.addEventListener('dragleave', () => ta.classList.remove('drop'));
  ta.addEventListener('drop', e => {
    const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/'));
    ta.classList.remove('drop');
    if (!files.length) return;
    e.preventDefault();
    const pos = caretFromPoint(ta, e.clientX, e.clientY);
    if (pos != null) ta.setSelectionRange(pos, pos);
    insertImages(files);
  });

  app.querySelectorAll('[data-tool]').forEach(b => b.addEventListener('click', async () => {
    const [, , kind, a, z = '', ph = ''] = TOOLBAR[b.dataset.tool];
    const { selectionStart: s, selectionEnd: e, value: v } = ta;
    if (kind === 'upload') {
      const files = await pickFile({ multiple: true });
      if (files.length) insertImages(files);
      return;
    }
    if (kind === 'video') {
      const url = prompt('YouTube かニコニコ動画のURLを入れてください\n（例: https://www.youtube.com/watch?v=… / https://youtu.be/…）');
      if (!url) return;
      if (!videoInfo(url)) { alert('YouTube かニコニコ動画の動画URLを入れてください。'); return; }
      const caption = prompt('動画の下に出す説明（なくてもOK）', '紹介動画') || '';
      const before = v.slice(0, s);
      const pre = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
      ta.setRangeText(`${pre}${caption ? `![${caption.replace(/[[\]]/g, '')}](${url.trim()})` : url.trim()}\n\n`, s, e, 'end');
      ta.focus();
      dirty(); refresh();
      toast('🎬 動画を入れました（プレビューで確認できます）');
      return;
    }
    if (kind === 'template') {
      const missing = TEMPLATES[col].filter(([h]) => !new RegExp(`^#{1,3}\\s*${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(v));
      if (!missing.length) { toast('ひな形の見出しはすべてそろっています'); return; }
      ta.value = v.replace(/\s*$/, '\n\n') + missing.map(([h, body]) => `## ${h}\n${body}\n`).join('\n');
      toast(`見出しを${missing.length}個追加しました`);
    } else if (kind === 'wrap') {
      const sel = v.slice(s, e) || ph;
      ta.setRangeText(a + sel + z, s, e);
      ta.setSelectionRange(s + a.length, s + a.length + sel.length);
    } else if (kind === 'line') {
      const ls = v.lastIndexOf('\n', s - 1) + 1;
      const le = v.indexOf('\n', e) === -1 ? v.length : v.indexOf('\n', e);
      ta.setRangeText(v.slice(ls, le).split('\n').map(l => a + l).join('\n'), ls, le, 'end');
    } else {
      ta.setRangeText(a, s, e, 'end');
    }
    ta.focus();
    dirty(); refresh();
  }));

  app.querySelector('[data-upload-image]').addEventListener('click', async () => {
    const file = await pickFile();
    if (!file) return;
    try {
      const res = await openCropper(file, { size: 512, title: isMod ? 'アイコンにする範囲を選ぶ' : '使う範囲を選ぶ', allowOriginal: true });
      if (!res) return;
      form.image.value = res.original ? await uploadImage(file) : await uploadBlob(res.blob, getUser());
      dirty(); toast('📷 画像をアップロードしました');
    } catch (e) { alert(e.message); }
  });

  // 配布ページから情報を取得 → 確認してから反映
  app.querySelector('[data-fetch]')?.addEventListener('click', async ev => {
    const btn = ev.currentTarget;
    if (!form.link.value.trim()) { form.link.focus(); return; }
    btn.disabled = true; btn.textContent = '取得中…';
    let info;
    try { info = await api(`/modinfo?url=${encodeURIComponent(form.link.value.trim())}`); } catch (e) { alert(e.message); return; }
    finally { btn.disabled = false; btn.textContent = '🔍 情報を取得'; }
    const picked = g => [...app.querySelectorAll(`[data-group="${g}"] .chip.on`)].map(b => b.dataset.v);
    const scalar = [
      ['name', 'MOD名', form.name.value, info.name],
      ['summary', 'ひとこと説明', form.summary.value, info.summary],
      ['author', '作者', form.author.value, info.author],
      ['image', 'アイコン', form.image.value, info.image],
      ['link', '配布ページURL', form.link.value, info.link],
    ].filter(([, , , v]) => v);
    const arrays = [['versions', '対応バージョン', info.versions], ['loaders', 'MODローダー', info.loaders], ['tags', 'ジャンル', info.tags]]
      .map(([k, l, vals]) => [k, l, vals.filter(v => !picked(k).includes(v))]).filter(([, , vals]) => vals.length);
    const show = (k, v) => (k === 'image' ? `<img class="fetch-icon" src="${esc(v)}" alt=""> ` : '') + esc(v);
    openModal('🔍 取得した情報を確認', `
      ${info.matchedBy === 'search' ? '<div class="notice">⚠️ CurseForge のURLから、Modrinth で名前が近いMODを探した結果です。<strong>同じMODか必ず確認してください。</strong></div>' : ''}
      <p class="muted small">反映する項目にチェックを入れてください。情報元: <a href="${esc(info.sourceUrl || info.modrinthUrl)}" target="_blank" rel="noopener">${esc(info.infoFrom || 'Modrinth')}</a>（説明文は英語のことがあります）</p>
      <div class="table-wrap"><table class="fetch-table">
        <thead><tr><th></th><th>項目</th><th>今の内容</th><th>取得した内容</th></tr></thead>
        <tbody>
          ${scalar.map(([k, l, curV, v]) => `<tr><td><input type="checkbox" name="f-${k}" ${!curV || k === 'image' && !curV ? 'checked' : ''} ${curV === v ? 'disabled' : ''}></td><th>${l}</th><td>${curV ? show(k, curV) : '<span class="muted">（空）</span>'}</td><td>${show(k, v)}</td></tr>`).join('')}
          ${arrays.map(([k, l, vals]) => `<tr><td><input type="checkbox" name="f-${k}" checked></td><th>${l}</th><td class="muted">追加</td><td>${vals.map(v => `<span class="tag">${esc(v)}</span>`).join(' ')}</td></tr>`).join('')}
          ${info.downloads ? `<tr><td><input type="checkbox" name="f-downloads" checked></td><th>ダウンロード数</th><td>${form.downloads.value > 0 ? Number(form.downloads.value).toLocaleString() : '<span class="muted">（空）</span>'}</td><td>${info.downloads.toLocaleString()}（${formatDownloads(info.downloads)}）</td></tr>` : ''}
        </tbody>
      </table></div>`,
    m => {
      const on = k => m[`f-${k}`]?.checked;
      for (const [k] of scalar) if (on(k)) form[k].value = info[k];
      if (on('name')) form.name.dispatchEvent(new Event('input', { bubbles: true })); // ページIDも自動で付ける
      for (const [k, , vals] of arrays) {
        if (on(k)) vals.forEach(v => { const b = app.querySelector(`[data-group="${k}"] .chip[data-v="${CSS.escape(v)}"]`); if (b) setChip(b, true); });
      }
      if (on('downloads')) {
        form.downloads.value = info.downloads;
        form.downloadsAt.value = info.downloadsAt;
        app.querySelector('.downloads-note').textContent = `ダウンロード数: ${info.downloads.toLocaleString()}（${info.downloadsAt} 時点）`;
      }
      dirty();
      toast('取得した情報を反映しました（まだ保存されていません）');
    }, { submitLabel: 'チェックした項目を反映', wide: true });
  });

  app.querySelectorAll('[data-pane]').forEach(b => b.addEventListener('click', () => {
    app.querySelectorAll('[data-pane]').forEach(x => x.classList.toggle('on', x === b));
    app.querySelector('.editor').dataset.show = b.dataset.pane;
  }));

  // 検索結果の「＋ ページを作る」から来たときは、配布ページの情報をすぐ読み込む
  const from = isNew && isMod && new URLSearchParams(location.search).get('from');
  if (from && /^https:\/\/(www\.)?(modrinth\.com|curseforge\.com)\//.test(from)) {
    form.link.value = from;
    app.querySelector('[data-fetch]').click();
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    errEl.innerHTML = '';
    const target = isNew ? form.slug.value.trim() : slug;
    if (isNew && listOf(col).some(m => m.slug === target)) {
      errEl.innerHTML = `ページID「${esc(target)}」は既に使われています。<a href="${K.view(target)}">そのページを見る</a>`;
      return;
    }
    const picked = g => [...app.querySelectorAll(`[data-group="${g}"] .chip.on`)].map(b => b.dataset.v);
    const payload = {
      name: form.name.value, summary: form.summary.value, author: form.author?.value || '', link: form.link?.value || '',
      image: form.image.value, body: ta.value, versions: picked('versions'), loaders: picked('loaders'), tags: picked('tags'),
      downloads: Number(form.downloads.value) || 0, downloadsAt: form.downloadsAt.value,
      user: form.user.value, comment: form.comment.value, website: form.website.value, baseRev: rev,
      ...(form.commentsAccountOnly.disabled ? {} : { commentsAccountOnly: form.commentsAccountOnly.checked }),
    };
    if (!state.account) setUser(payload.user.trim());
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true; btn.textContent = '公開中…';
    try {
      await api(`/${col}/${encodeURIComponent(target)}`, { method: 'PUT', body: JSON.stringify(payload) });
      state.dirty = false;
      clearInterval(autoSave);
      drafts.remove(draftId); // 公開できたので下書きは不要
      await loadData();
      navigate(K.view(target));
    } catch (err) {
      if (err.status === 409 && err.data.current) {
        const c = err.data.current;
        errEl.innerHTML = isNew
          ? `ページID「${esc(target)}」は既に使われています。`
          : `${esc(err.message)}（${esc(c.updatedBy)}・${fmt(c.updatedAt)}）<br>
             <a href="${K.hist(slug)}/${c.rev}" target="_blank">相手の変更を確認する</a> ／
             <button type="button" class="linkish" data-force>自分の内容で上書き保存する</button>`;
        errEl.querySelector('[data-force]')?.addEventListener('click', () => { rev = c.rev; form.requestSubmit(); });
      } else {
        errEl.textContent = err.message;
      }
    } finally {
      btn.disabled = false; btn.textContent = '公開する';
    }
  });
}

// テキストエリア内の座標から文字位置を求める（ドロップした場所に入れるため）
function caretFromPoint(ta, x, y) {
  const r = ta.getBoundingClientRect();
  const cs = getComputedStyle(ta);
  const mirror = document.createElement('div');
  for (const p of ['fontFamily', 'fontSize', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderLeftWidth', 'boxSizing', 'whiteSpace', 'wordBreak', 'overflowWrap']) mirror.style[p] = cs[p];
  Object.assign(mirror.style, { position: 'fixed', left: `${r.left}px`, top: `${r.top - ta.scrollTop}px`, width: `${r.width}px`, visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' });
  const spans = [...ta.value].map(ch => { const sp = document.createElement('span'); sp.textContent = ch; return sp; });
  mirror.append(...spans, document.createTextNode('​'));
  document.body.append(mirror);
  let best = null, bestD = Infinity;
  spans.forEach((sp, i) => {
    const b = sp.getBoundingClientRect();
    if (y < b.top || y > b.bottom + 2) return;
    const d = Math.abs(x - (b.left + b.width / 2));
    if (d < bestD) { bestD = d; best = x > b.left + b.width / 2 ? i + 1 : i; }
  });
  mirror.remove();
  if (best == null) return null;
  // 行の途中なら行末まで進めて、文の途中で改行されないようにする
  const nl = ta.value.indexOf('\n', best);
  return nl === -1 ? ta.value.length : nl;
}

/* ===== 履歴・差分 ===== */
function diffLines(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  const n = A.length, m = B.length;
  if (n * m > 4_000_000) return null;
  const dp = new Int32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] = A[i] === B[j] ? dp[(i + 1) * (m + 1) + j + 1] + 1
        : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { ops.push(['=', A[i]]); i++; j++; }
    else if (j < m && (i >= n || dp[i * (m + 1) + j + 1] >= dp[(i + 1) * (m + 1) + j])) ops.push(['+', B[j++]]);
    else ops.push(['-', A[i++]]);
  }
  return ops;
}

function diffView(oldP, newP) {
  const fields = [
    ['name', '名前'], ['summary', '説明'], ['versions', 'バージョン'], ['loaders', 'ローダー'],
    ['tags', 'タグ'], ['author', '作者'], ['link', '配布ページ'], ['image', '画像'], ['downloads', 'ダウンロード数'],
  ];
  const show = v => (Array.isArray(v) ? v.join(', ') : String(v ?? '')) || '（なし）';
  const meta = fields.filter(([k]) => JSON.stringify(oldP?.[k] ?? '') !== JSON.stringify(newP[k] ?? ''))
    .map(([k, label]) => `<tr><th>${label}</th><td class="d-del">${esc(oldP ? show(oldP[k]) : '（なし）')}</td><td class="d-add">${esc(show(newP[k]))}</td></tr>`).join('');

  const ops = diffLines(oldP?.body || '', newP.body);
  let body = '';
  if (!ops) body = '<p class="muted">差分が大きすぎるため表示できません。</p>';
  else if (!ops.some(o => o[0] !== '=')) body = '<p class="muted">本文に変更はありません。</p>';
  else {
    const near = ops.map((_, i) => ops.slice(Math.max(0, i - 2), i + 3).some(o => o[0] !== '='));
    let skipped = false;
    body = '<div class="diff">' + ops.map((o, i) => {
      if (!near[i]) { const s = skipped; skipped = true; return s ? '' : '<div class="d-skip">⋯</div>'; }
      skipped = false;
      const cls = o[0] === '+' ? 'd-add' : o[0] === '-' ? 'd-del' : '';
      return `<div class="d-line ${cls}"><span class="d-mark">${o[0] === '=' ? ' ' : o[0]}</span>${esc(o[1]) || ' '}</div>`;
    }).join('') + '</div>';
  }
  return `${meta ? `<h3>情報の変更</h3><div class="table-wrap"><table class="meta-diff"><thead><tr><th></th><th>変更前</th><th>変更後</th></tr></thead><tbody>${meta}</tbody></table></div>` : ''}
    <h3>本文の変更</h3>${body}`;
}

async function renderHistory(col, slug) {
  const K = KINDS[col];
  loading();
  let m;
  try { m = await api(`/${col}/${encodeURIComponent(slug)}`); } catch (e) { app.innerHTML = errorBox(e); return; }
  setMeta(pageTitle(`${m.name} の更新履歴`));
  app.innerHTML = `
    <div class="crumb">${crumbRoot(col)} › <a href="${K.view(slug)}">${esc(m.name)}</a> › 履歴</div>
    <h1 class="page-title">「${esc(m.name)}」の更新履歴</h1>
    <div class="table-wrap"><table class="history">
      <thead><tr><th>版</th><th>日時</th><th>ユーザー</th><th>要約</th><th>文字数</th><th></th></tr></thead>
      <tbody>${m.log.map(l => `
        <tr>
          <td>${l.rev}${l.rev === m.rev ? ' <span class="badge">最新</span>' : ''}</td>
          <td class="nowrap">${fmt(l.at)}</td>
          <td>${userLabel(l)}${crown(l)}${banBtn(l)}</td>
          <td>${esc(l.comment) || '<span class="muted">—</span>'}</td>
          <td>${delta(l.delta)}</td>
          <td class="nowrap"><a href="${K.hist(slug)}/${l.rev}">差分・表示</a></td>
        </tr>`).join('')}</tbody>
    </table></div>`;
  bindBanButtons();
}

async function renderRevision(col, slug, rev) {
  const K = KINDS[col];
  loading();
  let cur, snap, prev = null;
  const base = `/${col}/${encodeURIComponent(slug)}`;
  try {
    [cur, snap] = await Promise.all([api(base), api(`${base}/history/${rev}`)]);
    if (rev > 1) prev = await api(`${base}/history/${rev - 1}`);
  } catch (e) { app.innerHTML = errorBox(e); return; }
  setMeta(pageTitle(`${snap.name}（版 ${rev}）`));
  app.innerHTML = `
    <div class="crumb">${crumbRoot(col)} › <a href="${K.view(slug)}">${esc(cur.name)}</a> › <a href="${K.hist(slug)}">履歴</a> › 版 ${rev}</div>
    <div class="page-tools">
      <h1 class="page-title">版 ${rev}${rev === cur.rev ? '（最新）' : ''}</h1>
      <div class="btns">
        ${rev > 1 ? `<a class="btn" href="${K.hist(slug)}/${rev - 1}">← 前の版</a>` : ''}
        ${rev < cur.rev ? `<a class="btn" href="${K.hist(slug)}/${rev + 1}">次の版 →</a>` : ''}
        ${rev < cur.rev && canEdit(cur) ? `<a class="btn primary" href="${K.revert(slug, rev)}">この版に戻す</a>` : ''}
      </div>
    </div>
    <p class="rev-meta">${fmt(snap.at)} ・ <strong>${userLabel(snap)}</strong>${crown(snap)}${banBtn(snap)}${snap.comment ? ` ・ 「${esc(snap.comment)}」` : ''} ${delta(snap.delta)}</p>
    <div class="editor-tabs rev-tabs"><button type="button" class="on" data-v="diff">差分（版 ${rev - 1 || 'なし'} → ${rev}）</button><button type="button" data-v="page">この版の表示</button></div>
    <div class="rev-pane" data-v="diff">${rev === 1 ? '<p class="muted">最初の版です（ページ作成）。</p>' : ''}${diffView(prev, snap)}</div>
    <div class="rev-pane" data-v="page" hidden>${pageView(snap, col)}</div>`;
  app.querySelectorAll('.rev-tabs button').forEach(b => b.addEventListener('click', () => {
    app.querySelectorAll('.rev-tabs button').forEach(x => x.classList.toggle('on', x === b));
    app.querySelectorAll('.rev-pane').forEach(p => { p.hidden = p.dataset.v !== b.dataset.v; });
  }));
  bindPageView();
  bindBanButtons();
}

const ACTIONS = { lock: '🔒 ロック', unlock: '🔓 ロック解除', delete: '🗑 削除', restore: '♻️ 復元' };

async function renderRecent() {
  loading();
  let list;
  try { list = await api('/recent'); } catch (e) { app.innerHTML = errorBox(e); return; }
  setMeta(pageTitle('最近の更新'), 'Minecraft MOD Wikiの最近の編集履歴です。');
  const K = r => KINDS[r.col || 'pages'];
  const kindBadge = r => (r.col === 'articles' ? ' <span class="badge">記事</span>' : '');
  app.innerHTML = `
    <h1 class="page-title">最近の更新</h1>
    <p class="lead">直近100件の編集です。</p>
    <ul class="recent">${list.map(r => r.action ? `
      <li>
        <span class="nowrap muted">${fmt(r.at)}</span>
        <a href="${K(r).view(r.slug)}"><strong>${esc(r.name)}</strong></a>${kindBadge(r)}
        <span class="badge">${ACTIONS[r.action] || esc(r.action)}</span>${crown(r)}
      </li>` : `
      <li>
        <span class="nowrap muted">${fmt(r.at)}</span>
        <a href="${K(r).view(r.slug)}"><strong>${esc(r.name)}</strong></a>${kindBadge(r)}
        ${r.isNew ? '<span class="badge new">新規</span>' : ''}
        <a class="muted" href="${K(r).hist(r.slug)}/${r.rev}">（差分）</a>
        ${delta(r.delta)} ・ ${userLabel(r)}${crown(r)}${banBtn(r)}${r.comment ? ` <span class="muted">「${esc(r.comment)}」</span>` : ''}
      </li>`).join('') || '<li class="muted">まだ更新はありません。</li>'}</ul>`;
  bindBanButtons();
}

/* ===== 管理画面 ===== */
async function renderAdmin() {
  if (!state.admin) { app.innerHTML = '<div class="empty">管理者のみ表示できます。</div>'; return; }
  loading();
  let s;
  try { [s] = await Promise.all([api('/admin/state'), loadNews()]); } catch (e) { app.innerHTML = errorBox(e); return; }
  s.news = state.news;
  setMeta(pageTitle('管理'));
  const bans = Object.entries(s.bans);
  const link = p => `<a href="${KINDS[p.col || 'pages'].view(p.slug)}">${esc(p.name)}</a>${p.col === 'articles' ? ' <span class="badge">記事</span>' : ''}`;
  app.innerHTML = `
    <div class="page-head">
      <div><h1 class="page-title">👑 管理画面</h1><p class="lead">キーボードで <code>admin</code> と打つといつでもここに来られます。</p></div>
      <button class="btn" data-logout>ログアウト</button>
    </div>
    <section class="panel reports-panel">
      <h2>🚩 通報 <small>${s.reports.length}件（未対応）</small></h2>
      ${s.reports.length ? `<ul class="reports">${s.reports.map(r => `
        <li>
          <div>${link(r)} <span class="badge warn">${esc(r.reason)}</span> <span class="muted small">${fmt(r.at)}${r.user ? ` ・ ${esc(r.user)}` : ''} ・ 通報時の版 ${r.rev}</span></div>
          ${r.comment ? `<p>${esc(r.comment)}</p>` : ''}
          <div class="btns"><a class="btn" href="${KINDS[r.col].hist(r.slug)}">履歴を見る</a><button class="btn" data-resolve="${r.id}">✓ 対応済みにする</button>${r.ipHash ? `<button class="btn danger" data-ban="${r.ipHash}" data-user="${esc(r.user || '通報者')}">通報者をブロック</button>` : ''}</div>
        </li>`).join('')}</ul>` : '<p class="muted">未対応の通報はありません。</p>'}
    </section>
    <section class="panel news-admin">
      <h2>📢 お知らせ <small>トップページと「お知らせ」ページに表示されます（Markdown が使えます）</small></h2>
      <form class="news-form">
        <input type="hidden" name="newsId">
        <label class="field"><span>タイトル</span><input name="title" maxlength="100" required placeholder="例: 新しい機能を追加しました"></label>
        <label class="field"><span>本文 <small>任意・5000文字まで</small></span><textarea name="body" rows="5" maxlength="5000"></textarea></label>
        <div class="btns"><label class="check"><input type="checkbox" name="pinned"> 📌 上に固定する</label><button type="button" class="btn" data-news-cancel hidden>やめる</button><button class="btn primary" data-news-submit>投稿する</button></div>
      </form>
      ${s.news.length ? `<ul class="news-admin-list">${s.news.map(n => `
        <li><span class="news-date">${newsDate(n)}</span>${n.pinned ? '<span class="badge warn">📌</span>' : ''}<strong>${esc(n.title)}</strong>
          <button class="linkish" data-news-edit="${n.id}">編集</button><button class="linkish danger-text" data-news-del="${n.id}">削除</button></li>`).join('')}</ul>`
        : '<p class="muted">まだありません。</p>'}
    </section>
    <section class="panel backup-panel">
      <h2>💾 バックアップ <small>ページ・記事・履歴・アカウント・コメント・お問い合わせなどを、まとめて1つのファイル（JSON）に保存します</small></h2>
      <p class="muted small">⚠ アカウントのメールアドレスや（暗号化した）パスワードも入るので、ファイルは人に渡さず大切に保管してください。画像そのものは入りません（画像のURL一覧は入ります）。</p>
      <div class="btns"><button type="button" class="btn primary" data-backup>💾 バックアップをダウンロード</button><span class="muted small backup-result"></span></div>
    </section>
    <section class="panel users-panel">
      <h2>👥 ユーザー一覧 <small class="users-count">読み込み中…</small></h2>
      <input class="users-filter" type="search" placeholder="名前・メールアドレス・肩書きで絞り込み">
      <div class="table-wrap"><table class="users-table">
        <thead><tr><th>ユーザー</th><th>メールアドレス</th><th>作成</th><th>編集</th><th>登録日</th><th></th></tr></thead>
        <tbody></tbody>
      </table></div>
    </section>
    <section class="panel contacts-panel">
      <h2>📮 お問い合わせ <small>未対応 ${s.contacts.filter(c => !c.done).length}件 / 全${s.contacts.length}件</small></h2>
      ${s.contacts.length ? `<ul class="reports">${s.contacts.map(c => `
        <li class="${c.done ? 'done' : ''}">
          <div><span class="badge${c.done ? '' : ' warn'}">${esc(c.type)}</span>${c.done ? ' <span class="badge">✓ 対応済み</span>' : ''}
            <span class="muted small">${fmt(c.at)} ・ ${c.uid ? userLabel(c) : esc(c.user || '名前なし')}</span></div>
          <p class="contact-message">${esc(c.message).replace(/\n/g, '<br>')}</p>
          ${c.reply ? `<div class="small">↩ 返信先: <strong>${esc(c.reply)}</strong></div>` : ''}
          ${c.page ? `<div class="small muted">ページ: ${/^https?:\/\//.test(c.page) ? `<a href="${esc(c.page)}" target="_blank" rel="noopener">${esc(c.page)}</a>` : esc(c.page)}</div>` : ''}
          <div class="btns"><button class="btn" data-contact-done="${c.id}" data-done="${c.done ? '' : '1'}">${c.done ? '↺ 未対応に戻す' : '✓ 対応済みにする'}</button>
            <button class="btn danger" data-contact-del="${c.id}">🗑 削除</button>
            ${c.ipHash ? `<button class="btn danger" data-ban="${c.ipHash}" data-user="${esc(c.user || '問い合わせ者')}">送り主をブロック</button>` : ''}</div>
        </li>`).join('')}</ul>` : '<p class="muted">まだありません。</p>'}
    </section>
    <div class="admin-grid">
      <section class="panel">
        <h2>サイト全体の編集</h2>
        <p>${s.settings.editLocked ? '<strong class="danger-text">停止中</strong>：管理者以外は編集・新規作成・画像アップロードできません。' : '<strong>受付中</strong>：だれでも編集できます。'}</p>
        <button class="btn ${s.settings.editLocked ? 'primary' : 'danger'}" data-sitelock>${s.settings.editLocked ? '▶ 編集を再開する' : '⏸ 編集を停止する'}</button>
      </section>
      <section class="panel">
        <h2>ロック中のページ <small>${s.locked.length}件</small></h2>
        ${s.locked.length ? `<ul>${s.locked.map(p => `<li>${link(p)} <button class="linkish" data-unlock="${p.col}/${p.slug}">解除</button></li>`).join('')}</ul>`
          : '<p class="muted">ありません。各ページの「🔒 ロック」でロックできます。</p>'}
      </section>
      <section class="panel">
        <h2>ブロック中のユーザー <small>${bans.length}件</small></h2>
        ${bans.length ? `<ul>${bans.map(([h, b]) => `<li><strong>${esc(b.user || '(名前なし)')}</strong> <span class="muted">${fmt(b.at)}${b.reason ? ` ・ ${esc(b.reason)}` : ''}</span> <button class="linkish" data-unban="${h}">解除</button></li>`).join('')}</ul>`
          : '<p class="muted">ありません。履歴や最近の更新の「🚫 ブロック」から追加できます。</p>'}
      </section>
      <section class="panel">
        <h2>🏷 特別な肩書きを贈る</h2>
        <p class="muted small">アカウントに肩書き（例: サイト管理人・公式ライター）を付けます。もらった人はプロフィールで選んで表示できます。</p>
        <form class="grant-form">
          <div class="input-with-btn"><input name="account" placeholder="アカウント名" required maxlength="20"><input name="title" placeholder="肩書き（12文字まで）" required maxlength="12"><button class="btn" name="mode" value="add">付ける</button><button class="btn danger" name="mode" value="remove">外す</button></div>
        </form>
      </section>
      <section class="panel">
        <h2>名前でアカウントに紐付け</h2>
        <p class="muted small">ゲストIDが無かった頃（アカウント機能より前）の編集を、入力したユーザー名ごとアカウントのものにします。</p>
        <form class="attribute-form">
          <div class="input-with-btn"><input name="fromName" placeholder="履歴の名前（例: かるわか）" required maxlength="24"><input name="account" placeholder="アカウント名" required maxlength="20"><button class="btn">紐付け</button></div>
        </form>
      </section>
      <section class="panel">
        <h2>削除したページ <small>${s.deleted.length}件</small></h2>
        ${s.deleted.length ? `<ul>${s.deleted.map(p => `<li>${esc(p.name)}${p.col === 'articles' ? ' <span class="badge">記事</span>' : ''} <span class="muted">${fmt(p.deletedAt)}</span> <button class="linkish" data-restore="${p.col}/${p.slug}">復元</button></li>`).join('')}</ul>`
          : '<p class="muted">ありません。</p>'}
      </section>
    </div>
    <section class="panel">
      <h2>📷 最近アップロードされた画像 <small>不適切なものは削除できます</small></h2>
      ${s.images.length ? `<div class="image-grid">${s.images.map(i => `
        <figure><a href="${esc(i.url || u(`/img/${i.id}`))}" target="_blank"><img src="${esc(i.url || u(`/img/${i.id}`))}" alt="" loading="lazy"></a>
          <figcaption>${fmt(i.at)}<br>${esc(i.user || '名前なし')} ・ ${Math.round(i.size / 1024)}KB<br>
          <button class="linkish danger-text" data-delimg="${i.id}">削除</button>${i.ipHash ? ` <button class="linkish ban" data-ban="${i.ipHash}" data-user="${esc(i.user || 'アップロード者')}">ブロック</button>` : ''}</figcaption></figure>`).join('')}</div>`
        : '<p class="muted">まだありません。</p>'}
    </section>`;
  app.querySelector('[data-logout]').addEventListener('click', async () => {
    store.set(TOKEN_KEY, '');
    await refreshSettings();
    toast('ログアウトしました');
    navigate('/');
  });
  // お知らせの投稿・編集・削除
  const nf = app.querySelector('.news-form');
  const resetNews = () => { nf.reset(); nf.newsId.value = ''; nf.querySelector('[data-news-submit]').textContent = '投稿する'; nf.querySelector('[data-news-cancel]').hidden = true; };
  nf.querySelector('[data-news-cancel]').addEventListener('click', resetNews);
  nf.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api('/admin/news', { method: 'POST', body: JSON.stringify({ id: nf.newsId.value, title: nf.elements.title.value, body: nf.body.value, pinned: nf.pinned.checked }) });
      toast(nf.newsId.value ? 'お知らせを更新しました' : 'お知らせを投稿しました');
      route();
    } catch (err) { alert(err.message); }
  });
  app.querySelectorAll('[data-news-edit]').forEach(b => b.addEventListener('click', () => {
    const n = s.news.find(x => x.id === b.dataset.newsEdit);
    nf.newsId.value = n.id;
    nf.elements.title.value = n.title;
    nf.body.value = n.body || '';
    nf.pinned.checked = !!n.pinned;
    nf.querySelector('[data-news-submit]').textContent = '更新する';
    nf.querySelector('[data-news-cancel]').hidden = false;
    nf.scrollIntoView({ block: 'center' });
    nf.elements.title.focus();
  }));
  app.querySelectorAll('[data-news-del]').forEach(b => b.addEventListener('click', async () => {
    const n = s.news.find(x => x.id === b.dataset.newsDel);
    if (!confirm(`お知らせ「${n.title}」を削除しますか？`)) return;
    try { await api('/admin/news', { method: 'POST', body: JSON.stringify({ id: n.id, remove: true }) }); toast('削除しました'); route(); } catch (err) { alert(err.message); }
  }));
  app.querySelector('.grant-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    const remove = e.submitter?.value === 'remove';
    try {
      const r = await api('/admin/grant-title', { method: 'POST', body: JSON.stringify({ account: f.account.value, title: f.title.value, remove }) });
      toast(`${r.account} の肩書き: ${r.granted.map(t => `【${t}】`).join('') || 'なし'}`);
      await loadUsers();
    } catch (err) { alert(err.message); }
  });
  app.querySelector('.attribute-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    if (!confirm(`履歴の「${f.fromName.value}」名義の編集（アカウント無しのもの）を、アカウント「${f.account.value}」のものにしますか？`)) return;
    try {
      const r = await api('/admin/attribute', { method: 'POST', body: JSON.stringify({ fromName: f.fromName.value, account: f.account.value }) });
      toast(`${r.edits}件の編集（${r.pages}ページ）を紐付けました`);
      await loadData();
    } catch (err) { alert(err.message); }
  });
  app.querySelector('[data-sitelock]').addEventListener('click', () =>
    adminAction('/admin/settings', 'POST', { editLocked: !s.settings.editLocked }, s.settings.editLocked ? '編集を再開しました' : '編集を停止しました'));
  app.querySelectorAll('[data-unlock]').forEach(b => b.addEventListener('click', () =>
    adminAction(`/${b.dataset.unlock}/lock`, 'POST', { locked: false }, 'ロックを解除しました')));
  app.querySelectorAll('[data-unban]').forEach(b => b.addEventListener('click', () =>
    adminAction('/admin/unban', 'POST', { ipHash: b.dataset.unban }, 'ブロックを解除しました')));
  app.querySelectorAll('[data-restore]').forEach(b => b.addEventListener('click', () =>
    adminAction(`/${b.dataset.restore}/restore`, 'POST', null, '復元しました')));
  // バックアップのダウンロード
  app.querySelector('[data-backup]').addEventListener('click', async e => {
    const btn = e.currentTarget;
    const out = app.querySelector('.backup-result');
    btn.disabled = true;
    out.textContent = '作成中…';
    try {
      const data = await api('/admin/backup');
      const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
      const t = new Date(data.createdAt);
      const p2 = n => String(n).padStart(2, '0');
      const stamp = `${t.getFullYear()}${p2(t.getMonth() + 1)}${p2(t.getDate())}-${p2(t.getHours())}${p2(t.getMinutes())}`;
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `mc-mod-wiki-backup-${stamp}.json` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      const c = data.counts;
      out.textContent = `✓ 保存しました（MOD ${c.pages || 0}・記事 ${c.articles || 0}・履歴 ${(c.history || 0) + (c.ahistory || 0)}・アカウント ${c.accounts || 0}・全${Object.keys(data.entries).length}件、${Math.ceil(blob.size / 1024)}KB）`;
    } catch (err) { out.textContent = ''; alert(err.message); }
    btn.disabled = false;
  });
  // ユーザー一覧（あとから読み込む）
  api('/admin/users').then(users => {
    const panel = app.querySelector('.users-panel');
    if (!panel) return;
    const tbody = panel.querySelector('tbody');
    const draw = q => {
      const w = q.trim().toLowerCase();
      const list = w ? users.filter(a => [a.name, a.email, ...a.titles].some(v => (v || '').toLowerCase().includes(w))) : users;
      panel.querySelector('.users-count').textContent = w ? `${list.length} / ${users.length}人` : `${users.length}人`;
      tbody.innerHTML = list.map(a => `<tr>
        <td><a class="user-link" href="${userHref(a.name)}">${avatarHtml(a, 'mini-avatar')} ${esc(a.name)}</a>${titleBadges(a.titles)}${a.bio ? `<div class="muted small">${esc(a.bio)}</div>` : ''}</td>
        <td>${a.email ? esc(a.email) : '<span class="muted">なし</span>'}</td>
        <td>${a.created}</td><td>${a.edits}</td>
        <td class="small">${a.createdAt ? fmt(a.createdAt).split(' ')[0] : ''}</td>
        <td><button type="button" class="linkish small" data-grant-to="${esc(a.name)}">肩書きを贈る</button></td>
      </tr>`).join('') || '<tr><td colspan="6" class="muted">見つかりません</td></tr>';
      tbody.querySelectorAll('[data-grant-to]').forEach(b => b.addEventListener('click', () => {
        const gf = app.querySelector('.grant-form');
        gf.account.value = b.dataset.grantTo;
        gf.scrollIntoView({ block: 'center' });
        gf.title.focus();
      }));
    };
    draw('');
    panel.querySelector('.users-filter').addEventListener('input', e => draw(e.target.value));
  }).catch(err => { const c = app.querySelector('.users-count'); if (c) c.textContent = `読み込めませんでした（${err.message}）`; });
  app.querySelectorAll('[data-contact-done]').forEach(b => b.addEventListener('click', () =>
    adminAction('/admin/contact', 'POST', { id: b.dataset.contactDone, done: !!b.dataset.done }, b.dataset.done ? '対応済みにしました' : '未対応に戻しました')));
  app.querySelectorAll('[data-contact-del]').forEach(b => b.addEventListener('click', () => {
    if (confirm('このお問い合わせを削除しますか？')) adminAction('/admin/contact', 'POST', { id: b.dataset.contactDel, remove: true }, '削除しました');
  }));
  app.querySelectorAll('[data-resolve]').forEach(b => b.addEventListener('click', () =>
    adminAction('/admin/resolve-report', 'POST', { id: b.dataset.resolve }, '対応済みにしました')));
  app.querySelectorAll('[data-delimg]').forEach(b => b.addEventListener('click', () => {
    if (confirm('この画像を削除しますか？（使われているページでは表示されなくなります）')) adminAction('/admin/delete-image', 'POST', { id: b.dataset.delimg }, '画像を削除しました');
  }));
  bindBanButtons();
}

/* ===== 下書き一覧 ===== */
function renderDrafts() {
  setMeta(pageTitle('下書き'));
  const list = Object.entries(drafts.all()).sort((a, b) => b[1].savedAt.localeCompare(a[1].savedAt));
  app.innerHTML = `
    <h1 class="page-title">📄 下書き</h1>
    <p class="lead">このブラウザに保存されている書きかけのページです。ほかの端末やブラウザからは見えません。公開すると自動で消えます。</p>
    ${list.length ? `<ul class="draft-list">${list.map(([id, d]) => `
      <li>
        <div>
          <strong>${esc(d.data.name || '（タイトル未入力）')}</strong>
          <span class="badge">${KINDS[d.col].label}</span>${d.isNew ? ' <span class="badge new">新規</span>' : ''}
          <div class="muted small">${fmt(d.savedAt)} 保存 ・ 本文 ${d.data.body.length.toLocaleString()} 文字${d.isNew ? '' : ` ・ <a href="${KINDS[d.col].view(d.slug)}">元のページ</a>`}</div>
        </div>
        <div class="btns"><a class="btn primary" href="${draftHref(id, d)}">✏️ 続きを書く</a><button class="btn danger" data-del="${esc(id)}">削除</button></div>
      </li>`).join('')}</ul>` : '<div class="empty">下書きはありません。編集画面の「💾 下書き保存」で保存できます。</div>'}`;
  app.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
    if (!confirm('この下書きを削除しますか？')) return;
    drafts.remove(b.dataset.del);
    renderDrafts();
  }));
}

/* ===== 書き方 ===== */
const HELP = [
  ['見出し', '## 大見出し\n### 小見出し'],
  ['太字・斜体', '**太字** と *斜体* と ~~取り消し~~'],
  ['マーカー', '==目立たせたい部分=='],
  ['コード', '`/give @p minecraft:diamond`'],
  ['箇条書き', '- りんご\n- みかん\n  - ネストは2スペース'],
  ['番号付き', '1. 作業台を作る\n2. かまどを作る'],
  ['リンク', '[CurseForge](https://www.curseforge.com)'],
  ['MODページへ', '[[jei]] や [[jei|JEIはこちら]]'],
  ['画像・GIF', '![説明](画像のURL)\n（📷ボタン・貼り付け・ドラッグ＆ドロップで\nカーソル位置にアップロード）'],
  ['動画', 'https://youtu.be/動画のID\n![紹介動画](https://www.youtube.com/watch?v=…)\n（YouTube・ニコニコ動画のURLだけの行が動画になる。\n🎬ボタンからも入れられる）'],
  ['画像の大きさ', '![説明|300](画像のURL)\n![説明|小](画像のURL)\n（数字＝幅px。小・中・大も使える）'],
  ['表', '| キー | 動作 |\n|---|---|\n| R | レシピ |'],
  ['作業台レシピ', '```recipe\n鉄 | 鉄 | 鉄\n   | 棒 |\n   | 棒 |\n=> 鉄のツルハシ\n```'],
  ['かまどレシピ', '```smelt\n鉄鉱石\n=> 鉄インゴット\n```'],
  ['ヒント', '> [!TIP]\n> 便利な情報'],
  ['注意', '> [!WARN]\n> 気をつけること'],
  ['引用', '> ふつうの引用'],
  ['区切り線', '---'],
];

function renderHelp() {
  setMeta(pageTitle('書き方・編集ガイド'), 'Minecraft MOD Wikiのページの書き方（Markdown記法・レシピの書き方）と編集ルールです。');
  app.innerHTML = `
    <h1 class="page-title">書き方</h1>
    <p class="lead">各ページの「✏️ 編集」から、だれでも編集できます。編集画面のボタンでも入力できます。</p>
    <div class="md">
      <div class="table-wrap"><table class="help-table">
        <thead><tr><th>用途</th><th>書き方</th><th>表示</th></tr></thead>
        <tbody>${HELP.map(([n, src]) => `<tr><td>${n}</td><td><pre><code>${esc(src)}</code></pre></td><td>${n.startsWith('画像') || n === '動画' ? `<span class="muted">（${n === '動画' ? '動画' : '画像'}が表示されます）</span>` : renderMarkdown(src)}</td></tr>`).join('')}</tbody>
      </table></div>
      <p>改行はそのまま改行として表示されます。空行で段落が分かれます。</p>
      <h2>レシピの書き方</h2>
      <ul>
        <li>作業台は <code>|</code> で3列に区切り、3行まで書きます。空きマスは何も書かなくてOKです。</li>
        <li><code>=&gt;</code> の後ろに完成品を書きます。<code>x4</code> のように書くと個数が付きます。</li>
        <li>マスの中に <code>[[ページID]]</code> を書くと、そのMODのページへのリンクになります。</li>
      </ul>
      <h2>編集のルール</h2>
      <ul>
        <li>編集するとユーザー名と日時が<strong>履歴</strong>に残ります。</li>
        <li>荒らされても、履歴の「この版に戻す」で元に戻せます。</li>
        <li>おかしな内容を見つけたら、ページ下の「🚩 通報」で管理者に知らせてください。</li>
      </ul>
    </div>`;
}

/* ===== ルーティング（/mod/xxx のような普通のURL） ===== */
let currentPath = location.pathname;
let firstRender = true; // 最初の表示はサーバーが描画済みなので「読み込み中」を出さない

// path はサイト内パス（/mod/xxx）でも、フォルダ付き（/mc-mod-wiki/mod/xxx）でもよい
function navigate(path) {
  const full = config.base && !path.startsWith(config.base + '/') && path !== config.base ? u(path) : path;
  if (full === location.pathname + location.search) return route();
  history.pushState(null, '', full);
  route();
}

async function route() {
  const path = location.pathname;
  const sitePath = appPath(path);
  if (state.dirty && path !== currentPath) {
    if (!confirm('保存していない変更があります。ページを離れますか？')) {
      history.pushState(null, '', currentPath);
      return;
    }
    state.dirty = false;
  }
  currentPath = path;
  document.querySelector('.modal-bg')?.remove();
  const p = sitePath.split('/').filter(Boolean).map(decodeURIComponent);
  if (!firstRender) window.scrollTo(0, 0);
  const [a, b, c, d] = p;
  if (a === 'mod' && b) await renderView('pages', b);
  else if (a === 'edit' && b) await renderEdit('pages', b);
  else if (a === 'new') await renderEdit('pages', b || '', { isNew: true });
  else if (a === 'revert' && b) await renderEdit('pages', b, { revertFrom: +c });
  else if (a === 'history' && b && c) await renderRevision('pages', b, +c);
  else if (a === 'history' && b) await renderHistory('pages', b);
  else if (a === 'articles' && b === 'new') await renderEdit('articles', c || '', { isNew: true });
  else if (a === 'articles' && !b) renderArticles();
  else if (a === 'article' && b && c === 'edit') await renderEdit('articles', b);
  else if (a === 'article' && b && c === 'revert') await renderEdit('articles', b, { revertFrom: +d });
  else if (a === 'article' && b && c === 'history' && d) await renderRevision('articles', b, +d);
  else if (a === 'article' && b && c === 'history') await renderHistory('articles', b);
  else if (a === 'article' && b && !c) await renderView('articles', b);
  else if (a === 'search') await renderSearch();
  else if (a === 'news') await renderNews();
  else if (a === 'contact') renderContact();
  else if (a === 'recent') await renderRecent();
  else if (a === 'help') renderHelp();
  else if (a === 'admin') await renderAdmin();
  else if (a === 'drafts') renderDrafts();
  else if (a === 'user' && b) await renderUser(b);
  else if (a === 'login') {
    if (state.account) navigate(userHref(state.account.name));
    else { renderHome(); history.replaceState(null, '', u('/')); openAuth('login'); }
  }
  else if (LISTS[a] && b) renderHome({ kind: a, value: b });
  else if (!p.length) {
    state.q = new URLSearchParams(location.search).get('q') || state.q;
    renderHome();
  } else {
    setMeta(pageTitle('ページが見つかりません'));
    app.innerHTML = `<div class="empty">ページが見つかりません。<br><br><a class="btn" href="${u('/')}">トップへ</a></div>`;
  }
  firstRender = false;
  const top = a === 'article' ? 'articles' : a || '';
  document.querySelectorAll('.site-header nav a').forEach(x => x.classList.toggle('on', x.getAttribute('href') === u(`/${top}`)));
  const hq = document.querySelector('.header-search input');
  if (hq && a !== 'search') hq.value = '';
}

// サイト内リンクはページ遷移せずに切り替える
document.addEventListener('click', e => {
  const a = e.target.closest('a[href]');
  if (!a || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  const href = a.getAttribute('href');
  if (a.target === '_blank' || !href.startsWith(config.base + '/') || href.startsWith('//') || /^\/(api|img)\//.test(appPath(href))) return;
  e.preventDefault();
  navigate(href);
});
// 「ログイン」リンクはページ移動せずにダイアログを開く
document.addEventListener('click', e => {
  const a = e.target.closest('#account-link, [data-open-login]');
  if (!a || state.account || e.ctrlKey || e.metaKey) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  openAuth('login');
}, true);
// ヘッダーの検索欄
document.addEventListener('submit', e => {
  if (!e.target.matches('.header-search')) return;
  e.preventDefault();
  const q = e.target.q.value.trim();
  navigate(q ? `/search?q=${encodeURIComponent(q)}` : '/search');
});
window.addEventListener('popstate', () => route());
window.addEventListener('beforeunload', e => { if (state.dirty) e.preventDefault(); });

// 画面上のオープンチャットのお知らせ。×で閉じたら、このブラウザではもう出さない
const OPENCHAT_CLOSED_KEY = 'modwiki-openchat-closed';
function showOpenchatBar() {
  if (store.get(OPENCHAT_CLOSED_KEY) || document.getElementById('openchat-bar')) return;
  const bar = document.createElement('div');
  bar.id = 'openchat-bar';
  bar.className = 'openchat-bar';
  bar.innerHTML = `<a href="${esc(OPENCHAT.url)}" target="_blank" rel="noopener"><span class="oc-badge">LINE</span>
      <span>オープンチャット<b>「${esc(OPENCHAT.name)}」</b>に参加しよう！<span class="oc-bar-sub">相談・質問・雑談なんでもOK</span></span></a>
    <button type="button" class="oc-close" aria-label="閉じる（もう表示しない）" title="閉じる（もう表示しない）">×</button>`;
  bar.querySelector('.oc-close').addEventListener('click', () => { store.set(OPENCHAT_CLOSED_KEY, '1'); bar.remove(); });
  document.querySelector('.site-header')?.after(bar);
}

(async () => {
  showOpenchatBar();
  // 古い #/mod/xxx 形式のURLを新しい形式に置き換える
  if (location.hash.startsWith('#/')) history.replaceState(null, '', u(location.hash.slice(1)));
  try { await Promise.all([loadData(), refreshSettings()]); } catch (e) {
    // サーバーが描画した中身はそのまま残す（検索エンジンや一時的な通信エラーで消さない）
    console.warn('データを読み込めませんでした', e);
    return;
  }
  route();
})();
