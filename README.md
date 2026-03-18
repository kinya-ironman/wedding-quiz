# 🎉 結婚式二次会 クイズ大会アプリ

QRコードでスマホ参加 → リアルタイムランキング投影ができるクイズシステムです。

---

## 📁 ファイル構成

```
quiz-app/
├── server.js        ← サーバー本体（触らなくてOK）
├── questions.js     ← ★ 問題をここに編集してください
├── package.json     ← 依存関係（触らなくてOK）
├── render.yaml      ← Renderデプロイ設定（触らなくてOK）
└── public/
    ├── index.html   ← トップページ
    ├── host.html    ← 幹事コントロール画面
    └── play.html    ← 参加者スマホ画面
```

---

## ✏️ STEP 1：問題を編集する

`questions.js` を開いて、各問題の内容を実際のものに書き換えてください。

```js
{
  question: "新郎（◯◯さん）の出身地はどこ？",   // ← 問題文
  choices: ["東京都", "大阪府", "福岡県", "北海道"],  // ← 選択肢（4つ）
  correct: 0,   // ← 正解のインデックス（0=A, 1=B, 2=C, 3=D）
  hint: "ヒント：関東地方です"  // ← ヒント（幹事画面に表示）
},
```

問題数を変えたい場合は、同じ形式でオブジェクトを増減させてください。

---

## 🚀 STEP 2：GitHubにアップロードする

### 2-1. GitHubアカウント作成
https://github.com にアクセスして「Sign up」でアカウント作成

### 2-2. 新しいリポジトリを作成
1. GitHubにログイン後、右上「+」→「New repository」
2. Repository name: `wedding-quiz`（なんでもOK）
3. Public を選択
4. 「Create repository」をクリック

### 2-3. ファイルをアップロード
1. 作成されたリポジトリのページで「uploading an existing file」をクリック
2. `quiz-app` フォルダの中身を**すべて選択**してドラッグ＆ドロップ
   - ※ `public` フォルダごとドラッグしてください
3. 「Commit changes」をクリック

---

## ☁️ STEP 3：Renderにデプロイする

### 3-1. Renderアカウント作成
https://render.com にアクセスして「Get Started for Free」
→ 「Sign in with GitHub」でGitHubアカウントと連携

### 3-2. 新しいWebサービスを作成
1. Renderダッシュボードで「New +」→「Web Service」
2. 「Connect a repository」でGitHubの`wedding-quiz`リポジトリを選択
3. 設定を入力：
   - **Name**: `wedding-quiz`（任意）
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free` を選択
4. 「Create Web Service」をクリック

### 3-3. デプロイ完了を確認
- 数分でデプロイが完了します
- `https://wedding-quiz-xxxx.onrender.com` のようなURLが発行されます
- このURLが **参加者に共有するURL** です

> ⚠️ Renderの無料プランは15分アクセスがないとスリープします。
> 当日の30分前に幹事画面を開いておくと確実です。

---

## 🎮 STEP 4：当日の使い方

### 幹事側（PC・タブレット）
1. `https://your-app.onrender.com/host` を大画面に投影
2. QRコードが表示されるので、参加者に読み取ってもらう
3. 参加者が揃ったら「クイズ開始！」ボタンをクリック
4. 各問題で「正解を発表する」ボタンで正解発表
5. 「ランキングを表示」で現在順位を大画面表示
6. 「次の問題へ」で進む

### 参加者側（スマホ）
1. QRコードを読み取って参加
2. ニックネームを入力して「参加する！」
3. 問題が来たらA〜Dを選んでタップ
4. 早く答えるほど高得点（最大1000pt、最小100pt）

---

## ⚙️ カスタマイズ

### 制限時間を変えたい
`server.js` の以下の行を変更：
```js
const QUESTION_TIME = 20; // 秒（デフォルト20秒）
```

### 最大・最小ポイントを変えたい
```js
const MAX_POINTS = 1000; // 一番早く正解したときのポイント
const MIN_POINTS = 100;  // 制限時間ギリギリで正解したときのポイント
```

---

## 🆘 トラブルシューティング

**Q: Renderでデプロイエラーが出る**
→ GitHubに `package.json` がルートにあるか確認してください

**Q: 参加者がQRで入れない**
→ 幹事と参加者が同じURLにアクセスできているか確認。Renderの無料URLが正しいか確認

**Q: リアルタイムで更新されない**
→ ページをリロードしてみてください。WebSocketが再接続されます
