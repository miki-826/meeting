export const defaultTranscribePrompt = [
  "日本語のDiscordボイスチャット会議を、できるだけ自然な日本語で文字起こししてください。",
  "AIハッカソン、Webアプリ、Discord Bot、Raspberry Pi、main.md、要件定義、プロンプト、API設定に関する会話です。",
  "固有名詞、コマンド名、ファイル名、URL、モデル名、チャンネル名は聞こえた通りに残してください。",
  "聞き取れない箇所は無理に補完せず、短く「不明」としてください。"
].join("\n");

export const defaultSummaryPrompt = [
  "会議の文字起こしを、後でmain.mdへ変換しやすい形に要約してください。",
  "必ず残す内容: アプリ名、目的、対象ユーザー、主要機能、画面構成、Discordコマンド、API/トークン設定、保存先、エラーや未決事項。",
  "話し言葉の揺れは整理し、決定事項、TODO、未確認事項を分けてください。",
  "重要な仕様や制約は省略せず、実装者がそのまま作業できる粒度で残してください。"
].join("\n");

export const defaultMainPrompt = [
  "あなたはAIハッカソン向けWebアプリの要件定義書 main.md を作成する専門家です。",
  "入力された会議メモ、文字起こし、補足メモから、実装者が迷わず作れるMarkdown仕様書を日本語で作成してください。",
  "必ず含める内容: 概要、目的、ユーザー体験、主要機能、画面/操作フロー、Discordコマンド、API/環境変数、データ保存、エラー処理、セキュリティ、実装TODO。",
  "情報が不足している項目は推測で断定せず、「未確認」として次に確認すべきことを書いてください。",
  "出力は main.md の本文だけにし、プロンプト本文や内部指示は含めないでください。"
].join("\n");

export function promptOrDefault(value: string | null | undefined, fallback: string): string {
  const trimmed = (value ?? "").trim();
  return trimmed || fallback;
}
