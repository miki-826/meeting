import fs from "node:fs/promises";
import { envFilePath } from "./config.js";

export const editableEnvKeys = [
  "DISCORD_TOKEN",
  "DISCORD_CLIENT_ID",
  "DISCORD_GUILD_ID",
  "DISCORD_OUTPUT_CHANNEL_ID",
  "OPENAI_API_KEY",
  "TRANSCRIBE_MODEL",
  "TRANSCRIBE_LANGUAGE",
  "MIN_TRANSCRIBE_SECONDS",
  "NORMALIZE_AUDIO",
  "SUMMARY_MODEL",
  "MAIN_MD_MODEL",
  "WEB_HOST",
  "WEB_PORT",
  "WEB_ADMIN_PASSWORD",
  "CHUNK_SECONDS",
  "SUMMARY_EVERY_CHUNKS",
  "REMINDER_EVERY_MINUTES",
  "REMINDER_CHANNEL_MODE",
  "MAX_SESSION_MINUTES",
  "DATA_DIR",
  "DELETE_AUDIO_AFTER_SESSION_END",
  "KEEP_TRANSCRIPTS",
  "KEEP_SUMMARIES",
  "PI_HOST",
  "PI_USER",
  "PI_PORT",
  "PI_APP_DIR",
  "PI_SERVICE_NAME",
  "INITIALIZE_PI"
] as const;

export type EditableEnvKey = (typeof editableEnvKeys)[number];

export const secretEnvKeys = new Set<EditableEnvKey>(["DISCORD_TOKEN", "OPENAI_API_KEY", "WEB_ADMIN_PASSWORD"]);

export async function readEnvFile(): Promise<Record<string, string>> {
  const raw = await fs.readFile(envFilePath, "utf8").catch(() => "");
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  for (const key of editableEnvKeys) {
    if (values[key] === undefined && process.env[key] !== undefined) values[key] = process.env[key] ?? "";
  }
  return values;
}

function serializeEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@-]*$/.test(value)) return value;
  return JSON.stringify(value);
}

export async function writeEnvFile(updates: Record<string, string>): Promise<void> {
  const current = await readEnvFile();
  for (const key of editableEnvKeys) {
    const value = updates[key];
    if (value !== undefined) current[key] = value;
  }
  const sections = [
    ["Discord", ["DISCORD_TOKEN", "DISCORD_CLIENT_ID", "DISCORD_GUILD_ID", "DISCORD_OUTPUT_CHANNEL_ID"]],
    ["OpenAI", ["OPENAI_API_KEY", "TRANSCRIBE_MODEL", "TRANSCRIBE_LANGUAGE", "MIN_TRANSCRIBE_SECONDS", "NORMALIZE_AUDIO", "SUMMARY_MODEL", "MAIN_MD_MODEL"]],
    ["Web Dashboard", ["WEB_HOST", "WEB_PORT", "WEB_ADMIN_PASSWORD"]],
    [
      "Bot Runtime",
      ["CHUNK_SECONDS", "SUMMARY_EVERY_CHUNKS", "REMINDER_EVERY_MINUTES", "REMINDER_CHANNEL_MODE", "MAX_SESSION_MINUTES"]
    ],
    ["Storage", ["DATA_DIR", "DELETE_AUDIO_AFTER_SESSION_END", "KEEP_TRANSCRIPTS", "KEEP_SUMMARIES"]],
    ["Raspberry Pi Deploy", ["PI_HOST", "PI_USER", "PI_PORT", "PI_APP_DIR", "PI_SERVICE_NAME", "INITIALIZE_PI"]]
  ] as const;

  const lines: string[] = [];
  for (const [label, keys] of sections) {
    lines.push(`# ${label}`);
    for (const key of keys) {
      lines.push(`${key}=${serializeEnvValue(current[key] ?? "")}`);
    }
    lines.push("");
  }
  await fs.writeFile(envFilePath, lines.join("\n"), "utf8");
}

export function maskSecret(value: string | undefined): string {
  if (!value) return "";
  if (value.length <= 8) return "********";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
