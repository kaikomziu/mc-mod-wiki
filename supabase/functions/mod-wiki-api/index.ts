// Minecraft MOD Wiki の API（Supabase Edge Function）。
// 中身は lib/wiki.js（手元の serve.js と同じコード）で、ここでは保存先を Supabase につなぐだけ。
//   データ: public.wiki_kv テーブル（RLSでservice role以外は読めない）
//   画像  : Storage の wiki-images バケット（公開読み取り）
//   設定  : 環境変数（Edge Function Secrets）→ 無ければ wiki_kv の config/env
import { createClient } from 'npm:@supabase/supabase-js@2';
import { handle } from './lib/wiki.js';

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});
const TABLE = 'wiki_kv';
const BUCKET = 'wiki-images';

const store = {
  async get(key: string) {
    const { data, error } = await sb.from(TABLE).select('value').eq('key', key).maybeSingle();
    if (error) throw error;
    return data?.value ?? null;
  },
  async set(key: string, value: unknown) {
    const { error } = await sb.from(TABLE).upsert({ key, value, updated_at: new Date().toISOString() });
    if (error) throw error;
  },
  async delete(key: string) {
    if (key.startsWith('img/')) {
      await sb.storage.from(BUCKET).remove([key.slice(4)]);
      return;
    }
    const { error } = await sb.from(TABLE).delete().eq('key', key);
    if (error) throw error;
  },
  async list(prefix: string) {
    const keys: string[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from(TABLE).select('key').like('key', `${prefix}%`).order('key').range(from, from + 999);
      if (error) throw error;
      keys.push(...data.map(r => r.key));
      if (data.length < 1000) return keys;
    }
  },
  async getBlob(key: string) {
    const { data, error } = await sb.storage.from(BUCKET).download(key.slice(4));
    if (error || !data) return null;
    return { data: await data.arrayBuffer(), contentType: data.type };
  },
  async setBlob(key: string, data: ArrayBuffer, contentType: string) {
    const { error } = await sb.storage.from(BUCKET).upload(key.slice(4), data, { contentType, cacheControl: '31536000', upsert: true });
    if (error) throw error;
  },
  imageUrl: (id: string) => sb.storage.from(BUCKET).getPublicUrl(id).data.publicUrl,
};

// 管理者パスワードなどの設定（1分キャッシュ）
let cfg: { at: number; env: Record<string, string> } | null = null;
async function getEnv() {
  if (!cfg || Date.now() - cfg.at > 60_000) {
    const fromDb = ((await store.get('config/env').catch(() => null)) || {}) as Record<string, string>;
    cfg = { at: Date.now(), env: fromDb };
  }
  const env: Record<string, string> = { ...cfg.env };
  for (const k of ['ADMIN_NE', 'ADMIN_CL', 'ADMIN_CH', 'CF_API_KEY']) {
    const v = Deno.env.get(k);
    if (v) env[k] = v;
  }
  return env;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, x-admin-token',
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'access-control-max-age': '86400',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  // /mod-wiki-api/pages → /api/pages（lib/wiki.js は /api/... を受け取る作り）
  const url = new URL(req.url);
  url.pathname = url.pathname.replace(/^(\/functions\/v1)?\/mod-wiki-api/, '/api');
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await req.arrayBuffer();
  const inner = new Request(url, { method: req.method, headers: req.headers, body });
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
  const res = await handle(inner, store, { ip, env: await getEnv() });
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
});
