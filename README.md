# さとのこ5きょうだい大冒険

5人を切り替えながら進む、Phaser 3 + TypeScript + Vite の横スクロールMVPです。

## 起動

```bash
npm install
npm run dev
```

## 操作

| 操作 | キー |
| --- | --- |
| 左右移動 | ← → |
| ジャンプ | Space |
| とくぎ | X |
| 前のキャラ | Q |
| 次のキャラ | E |
| リスタート | R |

## キャラ

- 祈里: スター・ハイジャンプ
- 優里: がおがおサモン
- 茉里: むてきにこにこタイム
- 汐里: ふわふわフライト
- 明里: キラキラダッシュ

茉里のIDは `matsuri` 固定です。

## ワールドランキング設定 Firebase Spark + Firestore

ランキングは Firebase の無料 Spark プランで、Firestore だけを使います。Cloud Storage と Cloud Functions は使いません。

このリポジトリ側では、以下を設定済みです。

- `firebase.json`: Firestore Rules をデプロイするための Firebase CLI 設定
- `firestore.rules`: ランキング保存用のセキュリティルール
- `firestore.indexes.json`: Firestore インデックス設定
- `.firebaserc.example`: Firebase プロジェクトIDを入れる見本
- `.env.example`: ゲーム側に貼る `firebaseConfig` の見本

### 1. Firebaseプロジェクトを作る

1. Firebase Console を開く  
   https://console.firebase.google.com/
2. 「プロジェクトを追加」を押す
3. プロジェクト名を入れる  
   例: `satonoko-5-adventure`
4. Google Analytics はオフでOK
5. 料金プランは Spark のままでOK

### 2. Firestoreを有効にする

1. Firebase Console の左メニューで「構築」→「Firestore Database」を開く
2. 「データベースの作成」を押す
3. 本番環境モードで開始する
4. ロケーションは日本向けなら `asia-northeast1` などを選ぶ  
   ここは後から変更できないので注意

### 3. Firestore Rulesを貼る

Firebase Console の Firestore Database →「ルール」に、リポジトリの `firestore.rules` の内容を貼って公開します。

このルールは以下の方針です。

- `satonokoRoundRankings` だけ読み取り可能
- ランキングの新規作成だけ許可
- 更新と削除は禁止
- 名前、ラウンド、難易度、コイン数、タイム、ポイントの形式をチェック
- それ以外のコレクションは読み書き禁止

Firebase CLIを使える場合は、次でも反映できます。

```bash
copy .firebaserc.example .firebaserc
```

`.firebaserc` の `your-firebase-project-id` を自分のFirebaseプロジェクトIDに変えてから、

```bash
npx firebase-tools login
npm run firebase:rules
```

### 4. Webアプリを追加してfirebaseConfigを取得する

1. Firebase Console の「プロジェクトの設定」を開く
2. 「マイアプリ」で Web アプリを追加する
3. アプリ名を入れる  
   例: `satonoko-web`
4. Hosting は使わないのでチェック不要
5. 表示される `firebaseConfig` から、次の2つを使う

```ts
const firebaseConfig = {
  apiKey: "...",
  projectId: "...",
};
```

### 5. ゲーム側へ貼り付ける場所

`.env.example` をコピーして `.env.local` を作ります。

```bash
copy .env.example .env.local
```

`.env.local` に `firebaseConfig` の値を貼ります。

```env
VITE_FIREBASE_PROJECT_ID=firebaseConfigのprojectId
VITE_FIREBASE_API_KEY=firebaseConfigのapiKey
```

`.env.local` は `.gitignore` 済みなので、GitHubへは上がりません。

### 6. 動作確認

```bash
npm run dev
```

ゲームで名前を入れてラウンドをクリアすると、Firestore の `satonokoRoundRankings` に記録が作られます。  
Firebase設定がまだ入っていない場合は、ゲーム内に「ワールドランキング：接続待ち」と表示されます。

### 7. 公開版に反映するとき

GitHub Pages用にビルドするときも、同じ環境変数が必要です。ローカルから公開版を作る場合は `.env.local` がある状態で通常通りビルドします。

```bash
npm run build
```

GitHub Actionsで自動デプロイする場合は、Repository secrets に以下を追加してください。

- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_API_KEY`

Firebase の Web API Key はブラウザ用の公開キーですが、Firestore Rules で書き込み範囲を必ず制限します。
