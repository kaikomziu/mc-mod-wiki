// 最初に入れておくサンプルページ（ストアが空のときだけ投入）
export const SEED = [
  {
    "slug": "create",
    "name": "Create",
    "summary": "歯車とシャフトで動く、からくり装置を組み立てる技術MOD",
    "versions": [
      "1.20.1",
      "1.21.1"
    ],
    "loaders": [
      "Forge",
      "NeoForge"
    ],
    "tags": [
      "技術",
      "エネルギー",
      "輸送・物流"
    ],
    "author": "simibubi",
    "link": "https://www.curseforge.com/minecraft/mc-mods/create",
    "image": "",
    "body": "**Create** は、電気ではなく**回転力（応力）**を使って機械を動かす技術系MODです。\n見た目がアニメーションで動くので、作っていて楽しいのが特徴。\n\n## 基本の仕組み\n動力源で回転を作り、**シャフト**や**歯車**で伝えて機械を動かします。\n\n| 動力源 | 特徴 |\n|---|---|\n| 手回しクランク | 序盤用。手動で回す |\n| 水車 | 水流があれば無限に回る |\n| 風車 | 帆を増やすほど強い |\n| 蒸気エンジン | 中盤以降の高出力動力 |\n\n> [!TIP]\n> 回転速度（RPM）と**応力（SU）**の2つを意識すると、設計がぐっと楽になります。\n\n## 序盤のおすすめ\n1. **安山岩合金**を作る\n2. 水車 + シャフトで動力を確保\n3. **メカニカルプレス**と**ミキサー**で自動化を始める\n\n## 注意点\n> [!WARN]\n> 応力が足りないと機械が**止まります**。ゴーグルを被って数値を確認しましょう。\n\n## 関連MOD\n- [[jei]] — レシピ確認にほぼ必須\n"
  },
  {
    "slug": "jei",
    "name": "Just Enough Items (JEI)",
    "summary": "アイテムのレシピと使い道をゲーム内で検索できる定番MOD",
    "versions": [
      "1.20.1",
      "1.21.1"
    ],
    "loaders": [
      "Forge",
      "NeoForge",
      "Fabric"
    ],
    "tags": [
      "ユーティリティ",
      "QoL",
      "初心者向け"
    ],
    "author": "mezz",
    "link": "https://www.curseforge.com/minecraft/mc-mods/jei",
    "image": "",
    "body": "インベントリを開くと画面右にアイテム一覧が表示され、**レシピ検索**ができるようになります。\nMODを多く入れるなら**ほぼ必須**。\n\n## 操作方法\n| キー | 動作 |\n|---|---|\n| `R` | カーソル中のアイテムの**作り方**を表示 |\n| `U` | カーソル中のアイテムの**使い道**を表示 |\n| `A` | ブックマークに追加 |\n\n## 検索のコツ\n- `@create` のように `@MOD名` で MOD ごとに絞り込み\n- `#` でツールチップ検索\n\n## 関連MOD\n- [[create]]\n"
  },
  {
    "slug": "sodium",
    "name": "Sodium",
    "summary": "描画エンジンを置き換えてFPSを大幅に上げる軽量化MOD",
    "versions": [
      "1.20.1",
      "1.21.1",
      "1.21.4"
    ],
    "loaders": [
      "Fabric",
      "NeoForge"
    ],
    "tags": [
      "軽量化",
      "描画・シェーダー",
      "クライアントのみ"
    ],
    "author": "CaffeineMC",
    "link": "https://modrinth.com/mod/sodium",
    "image": "",
    "body": "**Sodium** はバニラの描画処理を最適化し、*見た目をほとんど変えずに* FPSを大きく向上させます。\n\n## 特徴\n- 低スペックPCでも**FPSが数倍**になることも\n- 設定画面がわかりやすく整理される\n- 同じ作者の ==Lithium==（処理軽量化）と組み合わせるのが定番\n\n> [!WARN]\n> 一部の描画系MOD（OptiFine など）とは**併用できません**。\n"
  }
];
