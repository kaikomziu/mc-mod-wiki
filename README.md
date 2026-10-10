# Minecraft MOD Wiki

だれでもブラウザ上で編集できる Minecraft MOD 解説Wiki。
編集にはユーザー名が必要で、すべての編集が履歴（差分・差し戻し付き）に残ります。

- サイト: https://kaikomziu.github.io/mc-mod-wiki/

## しくみ
| 役割 | 置き場所 |
|---|---|
| 画面（HTML/CSS/JS） | GitHub Pages（このリポジトリ） |
| 検索エンジン向けの静的ページ | GitHub Actions が30分ごとに `tools/build.js` で作り直す |
| API（保存・履歴・管理者機能など） | Supabase Edge Function `mod-wiki-api`（中身は `lib/wiki.js`） |
| データ | Supabase の `wiki_kv` テーブル（API以外からは読めない） |
| 画像 | Supabase Storage の `wiki-images` バケット |

編集した内容はブラウザが API から直接読むので、すぐに反映されます。
静的ページ（検索エンジン用）は最大30分遅れて更新されます。
まだ静的ページが無いURL（作ったばかりのページなど）は `404.html` からブラウザで表示します。

## ローカルで動かす
```
node serve.js
```
→ http://localhost:8080 。データは `.data/` に保存されます（Supabase とは別）。
管理者の言葉は `.env`（`ADMIN_NE=` / `ADMIN_CL=` / `ADMIN_CH=`）に書きます。

## API（Edge Function）を更新する
`supabase/functions/mod-wiki-api/index.ts` と、それが読み込む `lib/*.js`・`public/tags.js`・`public/markdown.js`・`public/paths.js` を一緒にデプロイします。

## 管理者
入力欄以外の場所でキーボードで `admin` と打つとログイン画面が出ます（Ne / Cl / Ch）。
言葉は Supabase の Edge Function Secrets（`ADMIN_NE` など）か、`wiki_kv` の `config/env` に置きます。
CurseForge のAPIキーは Edge Function Secrets の `CF_API_KEY` に置きます。

## タグを増やす・減らす
`public/tags.js` の `VERSIONS` / `LOADERS` / `TAGS` を書き換えてください（APIの再デプロイも必要）。

## 構成
| ファイル | 役割 |
|---|---|
| `public/` | 画面（app.js・style.css など） |
| `public/paths.js` | サイトの置き場所（`/mc-mod-wiki`）と API の場所 |
| `public/markdown.js` / `seo.js` / `views.js` | 本文の変換・タイトル・ページのHTML（サーバーとブラウザで共通） |
| `lib/wiki.js` | API本体（保存・履歴・競合チェック・連投制限・管理者） |
| `lib/ssr.js` | 静的ページ・sitemap.xml の組み立て |
| `lib/modinfo.js` / `lib/external.js` | Modrinth・CurseForge からの情報取得と検索 |
| `supabase/functions/mod-wiki-api/` | Supabase につなぐ部分 |
| `tools/build.js` | 静的サイトを `_site/` に書き出す |
| `serve.js` | ローカル用サーバー（ファイル保存） |
