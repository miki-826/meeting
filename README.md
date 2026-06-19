# MeetingBot

MeetingBot は、Discord のボイスチャットを録音・文字起こしして、会議内容から `main.md` を自動生成する Raspberry Pi 向けのBotです。

AIハッカソンのアイデア出しや要件定義ミーティングで、「話した内容をそのまま実装用のMarkdownにまとめたい」時に使います。

## できること

- Discord のVCに参加して音声を受信
- `/start-dev` から `/end-dev` まで文字起こしを継続
- OpenAI APIで日本語会議を文字起こし
- ffmpegで音声を正規化して認識精度を改善
- 会議メモ、文字起こし、生成ファイル、状態診断をSQLiteに保存
- Web画面からAPIキー、トークン、プロンプト、モデル設定を変更
- Web画面から `main.md` をダウンロード
- 生成した `main.md` をDiscordの指定テキストチャンネルへ送信
- DiscordコマンドをWeb画面から即時同期
- VC切断時の再接続、Bot再起動後の録音復帰に対応

## 全体の流れ

```text
Discord VCに入る
↓
/start-dev を実行
↓
MeetingBotがVC音声を録音・文字起こし
↓
必要なら /add-dev で手動メモを追加
↓
/end-dev を実行
↓
main.md を生成
↓
Discordへ送信、またはWeb画面からダウンロード
```

## 必要なもの

- Raspberry Pi 5 推奨
- Node.js 22 LTS
- ffmpeg
- sqlite3
- Discord Bot Token
- OpenAI API Key

## セットアップ

まず依存関係を入れてビルドします。

```bash
npm install
npm run build
```

ローカルPCで起動する場合は `sqlite3` コマンドも必要です。Windowsで `spawn sqlite3 ENOENT` が出る場合は、sqlite3 CLIがPCに入っていません。

## 環境変数

`.env.example` を `.env` にコピーして、必要な値を入れます。

```bash
cp .env.example .env
```

主に設定する項目は以下です。

| 項目 | 説明 |
|---|---|
| `DISCORD_TOKEN` | Discord Bot Token |
| `DISCORD_CLIENT_ID` | DiscordアプリケーションID。空でもBotログイン後に自動取得します |
| `DISCORD_GUILD_ID` | コマンドを優先登録するDiscordサーバーID。空なら参加中サーバーへ登録します。複数指定はカンマ区切りです |
| `DISCORD_OUTPUT_CHANNEL_ID` | `main.md` の既定送信先チャンネルID |
| `OPENAI_API_KEY` | OpenAI API Key |
| `TRANSCRIBE_MODEL` | 文字起こしモデル。精度優先は `gpt-4o-transcribe` |
| `TRANSCRIBE_LANGUAGE` | 日本語会議なら `ja` |
| `MIN_TRANSCRIBE_SECONDS` | 短すぎる音声を捨てる秒数 |
| `NORMALIZE_AUDIO` | `true` で音声正規化を有効化 |
| `WEB_ADMIN_PASSWORD` | Web設定画面の管理パスワード |
| `CHUNK_SECONDS` | 音声を何秒ごとに区切って処理するか |
| `PI_APP_DIR` | Raspberry Pi上の配置先 |
| `PI_SERVICE_NAME` | systemdサービス名 |

初期値の例:

```env
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
DISCORD_OUTPUT_CHANNEL_ID=
ADMIN_DISCORD_USER_IDS=
ADMIN_DISCORD_ROLE_IDS=

OPENAI_API_KEY=
TRANSCRIBE_MODEL=gpt-4o-transcribe
TRANSCRIBE_LANGUAGE=ja
MIN_TRANSCRIBE_SECONDS=2
NORMALIZE_AUDIO=true
SUMMARY_MODEL=gpt-4.1-mini
MAIN_MD_MODEL=gpt-5.5

WEB_HOST=0.0.0.0
WEB_PORT=3000
WEB_ADMIN_PASSWORD=replace_with_a_strong_password

CHUNK_SECONDS=60
SUMMARY_EVERY_CHUNKS=5
REMINDER_EVERY_MINUTES=10
REMINDER_CHANNEL_MODE=start_channel
MAX_SESSION_MINUTES=180

DATA_DIR=./data
DELETE_AUDIO_AFTER_SESSION_END=true
KEEP_TRANSCRIPTS=true
KEEP_SUMMARIES=true

PI_HOST=miki1586.local
PI_USER=pi
PI_PORT=22
PI_APP_DIR=/opt/talk2main-pi
PI_SERVICE_NAME=talk2main
INITIALIZE_PI=false
```

## Raspberry Piへデプロイ

`.env` の `PI_HOST`、`PI_USER`、`PI_PORT`、`PI_APP_DIR` を確認してから実行します。

```bash
npm run deploy:pi
```

systemdで起動する場合のサービス例は `scripts/talk2main.service` にあります。

## 起動

```bash
npm start
```

起動するとWeb画面が開けます。

```text
http://<Raspberry PiのIP>:3000/
```

例:

```text
http://192.168.0.173:3000/
```

## Web画面

| ページ | 説明 |
|---|---|
| `/` | セッション一覧、録音中・完了・失敗数の確認 |
| `/settings` | Discord、OpenAI、音声認識、プロンプト、Pi設定の編集 |
| `/help` | 操作方法、コマンド、API設定の説明 |
| `/latest/main.md` | 最新の `main.md` をダウンロード |
| `/sessions/:id` | セッション詳細、録音状態、文字起こし、エラー確認 |

設定画面に入るには `WEB_ADMIN_PASSWORD` が必要です。`change_me` のままだと安全のため起動しません。必ず強いパスワードへ変更してください。

## Discordコマンド

| コマンド | 説明 |
|---|---|
| `/start-dev` | VC録音と文字起こしを開始します |
| `/end-dev` | 録音を終了し、`main.md` を生成してDiscordへ送信します |
| `/status-dev` | VC接続、録音状態、文字起こし件数、エラーを確認します |
| `/add-dev content:<text>` | 会議中の補足メモを追加します |
| `/set-prompt content:<text>` | `main.md` 生成用プロンプトを更新します |
| `/show-prompt` | 現在の `main.md` 生成用プロンプトを表示します |
| `/export-dev` | 生成済みの `main.md` を再送信します |
| `/reset-dev` | 進行中セッションをリセットします |

Botを新しいDiscordサーバーへ追加した場合、MeetingBotは参加時にそのサーバーへスラッシュコマンドを登録します。
Discordコマンドが表示されない場合は、Web画面の `/settings` から **Sync Discord Commands Now** を押してください。
招待URLには `applications.commands` スコープが必要です。

## プロンプトの役割

| 項目 | 使い道 |
|---|---|
| `Transcribe Prompt` | VC音声を文字起こしするときの聞き取り方です。固有名詞、コマンド名、ファイル名、モデル名を残すために使います |
| `Summary Prompt` | 長い会議内容を `main.md` に入れやすく整理する方針です。決定事項、TODO、未確認事項の残し方を決めます |
| `main.md Prompt` | 最後にダウンロードする `main.md` の構成、粒度、出力ルールを決めます |

## `/hackathon-build` 向け出力

MeetingBotは会議内容を要件コンパイラとして整理し、セッションごとに以下の5ファイルを生成します。

```text
project-input/
├── main.md
├── project.yaml
├── acceptance-tests.md
├── asset-request.yaml
└── assumptions.md
```

| ファイル | 内容 |
|---|---|
| `main.md` | YAML frontmatterと33セクションを含む、人間・機械両方向けの要件定義 |
| `project.yaml` | Skill Routing、プロジェクトモード、能力、優先度、スコープ評価用の機械可読データ |
| `acceptance-tests.md` | UI、AI、カメラ、音声、エラー、Mock Mode、レスポンシブ、デモ信頼性の受け入れ条件 |
| `asset-request.yaml` | 画像、音声、アイコンなどの生成要否、利用箇所、代替手段、優先度 |
| `assumptions.md` | 不明点、仮定、ビルド前の決定事項、既存プロジェクト情報、最大5件の重要質問 |

`main.md Prompt` はプロジェクト固有の方向性を調整します。Must Have最大3件、必須セクション、5ファイル出力などのコンパイラ契約は常に適用されます。

## 音声認識の精度を上げる設定

標準では精度優先の設定です。

```env
TRANSCRIBE_MODEL=gpt-4o-transcribe
TRANSCRIBE_LANGUAGE=ja
MIN_TRANSCRIBE_SECONDS=2
NORMALIZE_AUDIO=true
```

精度を上げたい場合:

- `TRANSCRIBE_MODEL` は `gpt-4o-transcribe` のままにする
- `TRANSCRIBE_LANGUAGE=ja` にする
- `NORMALIZE_AUDIO=true` にする
- `Transcribe Prompt` に固有名詞、サービス名、話者名、専門用語を入れる

速度を優先したい場合:

```env
TRANSCRIBE_MODEL=gpt-4o-mini-transcribe
```

## ステータス表示の見方

セッション詳細画面では、どこで問題が起きているか確認できます。

| 表示 | 見るポイント |
|---|---|
| Voice Connection | Discord VCに接続できているか |
| Recording | 録音処理が動いているか |
| Receiver | 音声受信が始まっているか |
| Active Speakers | 現在検出中の話者数 |
| Audio Chunks | 保存された音声チャンク数 |
| Transcripts | 文字起こし件数 |
| Last Audio | 最後に音声を受信した時刻 |
| Last Transcript | 最後に文字起こしが成功した時刻 |
| Last Error | 直近のエラー内容 |

## Botに必要なDiscord権限

- View Channels
- Send Messages
- Attach Files
- Read Message History
- Connect
- Speak
- Use Voice Activity
- `applications.commands`

## よくあるトラブル

### Discordコマンドが出ない

1. `/settings` を開く
2. `DISCORD_TOKEN` が設定されているか確認
3. **Restart App and Apply .env** を押す
4. **Sync Discord Commands Now** を押す
5. Discordのチャンネルを開き直す
6. 招待URLに `applications.commands` が入っているか確認

### BotがVCから落ちる

`/status-dev` またはWebのセッション詳細で `Last Error` を確認してください。

SQLiteの `database is locked` 対策として、DBアクセスはキュー化とリトライを入れています。VC接続が切れた場合も、セッションが録音中なら再接続を試みます。

### 文字起こしされない

以下を確認してください。

- BotがVCに入っている
- Botがスピーカーミュートでも問題ありません。受信には `selfDeaf: false` が重要です
- Discord権限に `Connect`、`Speak`、`Use Voice Activity` がある
- `OPENAI_API_KEY` が設定されている
- `Last Audio` が更新されている
- `Last Error` にOpenAIやffmpegのエラーが出ていない

### PCで起動できない

`spawn sqlite3 ENOENT` が出る場合は、PCに sqlite3 CLI を入れてください。Raspberry Pi側には `sqlite3` をインストールしておく必要があります。

## セキュリティ

- `.env` はGitHubに上げないでください
- `DISCORD_TOKEN` と `OPENAI_API_KEY` はサーバー側だけで使ってください
- Web画面はLAN内利用を想定しています
- インターネットへ直接公開しないでください
- 録音、文字起こし、`main.md` には会議の機密情報が含まれる可能性があります

## ライセンス

MIT
