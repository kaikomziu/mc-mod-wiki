// いいね・フォロー（どちらもアカウントのみ）
//   likes/<col>/<slug>  … { uids: [いいねした人] }
//   likesby/<uid>       … { items: [{ col, slug, at }] }（その人がいいねしたページ）
//   following/<uid>     … { uids: [フォローしている人] }
//   followers/<uid>     … { uids: [フォローされている人] }
const err = (status, message) => Object.assign(new Error(message), { status });
const uidsOf = async (store, key) => (await store.get(key))?.uids || [];

export async function likeState(store, col, slug, account) {
  const uids = await uidsOf(store, `likes/${col}/${slug}`);
  return { likes: uids.length, liked: !!account && uids.includes(account.uid) };
}

export async function setLike(store, account, col, slug, on) {
  const key = `likes/${col}/${slug}`;
  const uids = await uidsOf(store, key);
  const has = uids.includes(account.uid);
  if (on !== has) {
    const next = on ? [...uids, account.uid] : uids.filter(u => u !== account.uid);
    await store.set(key, { uids: next });
    const mk = `likesby/${account.uid}`;
    const items = ((await store.get(mk))?.items || []).filter(i => !(i.col === col && i.slug === slug));
    if (on) items.unshift({ col, slug, at: new Date().toISOString() });
    await store.set(mk, { items: items.slice(0, 500) });
    return { likes: next.length, liked: on };
  }
  return { likes: uids.length, liked: has };
}

// 一覧用：slug → いいね数
export async function likeCounts(store, col) {
  const keys = await store.list(`likes/${col}/`);
  const counts = {};
  await Promise.all(keys.map(async k => { counts[k.slice(`likes/${col}/`.length)] = (await uidsOf(store, k)).length; }));
  return counts;
}

export async function setFollow(store, account, target, on) {
  if (account.uid === target.uid) throw err(400, '自分はフォローできません。');
  const fk = `following/${account.uid}`;
  const rk = `followers/${target.uid}`;
  const [following, followers] = await Promise.all([uidsOf(store, fk), uidsOf(store, rk)]);
  const without = (list, u) => list.filter(x => x !== u);
  const nextFollowing = on ? [...without(following, target.uid), target.uid] : without(following, target.uid);
  const nextFollowers = on ? [...without(followers, account.uid), account.uid] : without(followers, account.uid);
  await Promise.all([store.set(fk, { uids: nextFollowing }), store.set(rk, { uids: nextFollowers })]);
  return { following: on, followers: nextFollowers.length };
}

export const followingOf = (store, uid) => uidsOf(store, `following/${uid}`);
export const followersOf = (store, uid) => uidsOf(store, `followers/${uid}`);

// 一覧表示用：uid → { name, avatar }
export async function briefAccounts(store, uids) {
  const list = await Promise.all(uids.map(u => store.get(`accounts/${u}`)));
  return list.filter(Boolean).map(a => ({ name: a.name, avatar: a.avatar || '' }));
}

export async function likedBy(store, uid) {
  return (await store.get(`likesby/${uid}`))?.items || [];
}
