import dotenv from "dotenv";
import path from "node:path";

dotenv.config();

export const envFilePath = path.resolve(".env");

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  discordToken: process.env.DISCORD_TOKEN ?? "",
  discordClientId: process.env.DISCORD_CLIENT_ID ?? "",
  discordGuildId: process.env.DISCORD_GUILD_ID ?? "",
  discordOutputChannelId: process.env.DISCORD_OUTPUT_CHANNEL_ID ?? "",
  openAiApiKey: process.env.OPENAI_API_KEY ?? "",
  transcribeModel: process.env.TRANSCRIBE_MODEL ?? "gpt-4o-transcribe",
  transcribeLanguage: process.env.TRANSCRIBE_LANGUAGE ?? "ja",
  minTranscribeSeconds: intFromEnv("MIN_TRANSCRIBE_SECONDS", 2),
  normalizeAudio: process.env.NORMALIZE_AUDIO !== "false",
  summaryModel: process.env.SUMMARY_MODEL ?? "gpt-4.1-mini",
  mainMdModel: process.env.MAIN_MD_MODEL ?? "gpt-4.1",
  webHost: process.env.WEB_HOST ?? "0.0.0.0",
  webPort: intFromEnv("WEB_PORT", 3000),
  webAdminPassword: process.env.WEB_ADMIN_PASSWORD ?? "change_me",
  chunkSeconds: intFromEnv("CHUNK_SECONDS", 60),
  summaryEveryChunks: intFromEnv("SUMMARY_EVERY_CHUNKS", 5),
  reminderEveryMinutes: intFromEnv("REMINDER_EVERY_MINUTES", 10),
  reminderChannelMode: process.env.REMINDER_CHANNEL_MODE === "output_channel" ? "output_channel" : "start_channel",
  maxSessionMinutes: intFromEnv("MAX_SESSION_MINUTES", 180),
  dataDir: path.resolve(process.env.DATA_DIR ?? "./data"),
  piHost: process.env.PI_HOST ?? "miki1586.local",
  piUser: process.env.PI_USER ?? "pi",
  piPort: intFromEnv("PI_PORT", 22),
  piAppDir: process.env.PI_APP_DIR ?? "/opt/talk2main-pi",
  piServiceName: process.env.PI_SERVICE_NAME ?? "talk2main",
  initializePi: process.env.INITIALIZE_PI === "true"
} as const;

export function dashboardUrl(sessionId?: string): string {
  const base = `http://${config.piHost}:${config.webPort}`;
  return sessionId ? `${base}/sessions/${encodeURIComponent(sessionId)}` : base;
}
