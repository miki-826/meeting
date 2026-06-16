import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

const dbPath = path.join(config.dataDir, "app.db");
const sqliteRetryDelaysMs = [100, 250, 500, 1000, 1500, 2000, 3000, 5000];
let sqliteQueue: Promise<unknown> = Promise.resolve();

export type SessionStatus = "recording" | "processing" | "completed" | "failed" | "reset";

export type SessionRecord = {
  id: string;
  guild_id: string | null;
  text_channel_id: string | null;
  voice_channel_id: string | null;
  output_channel_id: string | null;
  reminder_channel_id: string | null;
  status: SessionStatus;
  app_name: string | null;
  started_at: string;
  ended_at: string | null;
  last_reminded_at: string | null;
  next_reminder_at: string | null;
  created_at: string;
};

export type GeneratedFileRecord = {
  id: string;
  session_id: string;
  type: string;
  file_path: string;
  discord_message_id: string | null;
  discord_channel_id: string | null;
  sent_to_discord_at: string | null;
  created_at: string;
};

export type NoteRecord = {
  id: string;
  session_id: string;
  content: string;
  created_at: string;
};

export type TranscriptRecord = {
  id: string;
  session_id: string;
  user_id: string | null;
  audio_path: string;
  text: string;
  duration_ms: number | null;
  created_at: string;
};

export type SessionDiagnosticRecord = {
  session_id: string;
  voice_connection_status: string | null;
  receiver_status: string | null;
  recording_status: string | null;
  active_speakers: number | null;
  audio_chunk_count: number | null;
  audio_bytes: number | null;
  transcript_count: number | null;
  last_audio_at: string | null;
  last_transcript_at: string | null;
  last_error: string | null;
  updated_at: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSqliteBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("database is locked") || message.includes("SQLITE_BUSY") || message.includes("SQLITE_LOCKED");
}

function runSqliteOnce(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("sqlite3", ["-cmd", ".timeout 10000", ...args], { maxBuffer: 1024 * 1024 * 20 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

function runSqlite(args: string[]): Promise<string> {
  const task = async (): Promise<string> => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= sqliteRetryDelaysMs.length; attempt += 1) {
      try {
        return await runSqliteOnce(args);
      } catch (error) {
        lastError = error;
        if (!isSqliteBusy(error) || attempt === sqliteRetryDelaysMs.length) {
          throw error;
        }
        await sleep(sqliteRetryDelaysMs[attempt]);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };

  const next = sqliteQueue.then(task, task);
  sqliteQueue = next.catch(() => undefined);
  return next;
}

export function sqlValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "NULL";
  if (typeof value === "number") return String(value);
  return `'${value.replaceAll("'", "''")}'`;
}

export async function execSql(sql: string): Promise<void> {
  await runSqlite([dbPath, sql]);
}

export async function queryAll<T>(sql: string): Promise<T[]> {
  const stdout = await runSqlite(["-json", dbPath, sql]);
  if (!stdout.trim()) return [];
  return JSON.parse(stdout) as T[];
}

export async function initDb(): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.mkdir(path.join(config.dataDir, "sessions"), { recursive: true });
  await fs.mkdir(path.join(config.dataDir, "exports"), { recursive: true });
  await execSql(`
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=10000;
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  guild_id TEXT,
  text_channel_id TEXT,
  voice_channel_id TEXT,
  output_channel_id TEXT,
  reminder_channel_id TEXT,
  status TEXT NOT NULL,
  app_name TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  last_reminded_at TEXT,
  next_reminder_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS generated_files (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  file_path TEXT NOT NULL,
  discord_message_id TEXT,
  discord_channel_id TEXT,
  sent_to_discord_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);
CREATE TABLE IF NOT EXISTS transcripts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT,
  audio_path TEXT NOT NULL,
  text TEXT NOT NULL,
  duration_ms INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);
CREATE TABLE IF NOT EXISTS session_diagnostics (
  session_id TEXT PRIMARY KEY,
  voice_connection_status TEXT,
  receiver_status TEXT,
  recording_status TEXT,
  active_speakers INTEGER DEFAULT 0,
  audio_chunk_count INTEGER DEFAULT 0,
  audio_bytes INTEGER DEFAULT 0,
  transcript_count INTEGER DEFAULT 0,
  last_audio_at TEXT,
  last_transcript_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL
);
`);
}

export function createId(prefix: string): string {
  return `${prefix}_${new Date().toISOString().replace(/[-:.TZ]/g, "")}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function createSession(input: {
  guildId: string;
  textChannelId: string;
  voiceChannelId: string;
  outputChannelId: string | null;
  reminderChannelId: string;
  appName: string | null;
}): Promise<SessionRecord> {
  const now = new Date().toISOString();
  const nextReminder = new Date(Date.now() + config.reminderEveryMinutes * 60_000).toISOString();
  const session: SessionRecord = {
    id: createId("session"),
    guild_id: input.guildId,
    text_channel_id: input.textChannelId,
    voice_channel_id: input.voiceChannelId,
    output_channel_id: input.outputChannelId,
    reminder_channel_id: input.reminderChannelId,
    status: "recording",
    app_name: input.appName,
    started_at: now,
    ended_at: null,
    last_reminded_at: null,
    next_reminder_at: nextReminder,
    created_at: now
  };
  await execSql(`
INSERT INTO sessions (
  id, guild_id, text_channel_id, voice_channel_id, output_channel_id,
  reminder_channel_id, status, app_name, started_at, ended_at,
  last_reminded_at, next_reminder_at, created_at
) VALUES (
  ${sqlValue(session.id)}, ${sqlValue(session.guild_id)}, ${sqlValue(session.text_channel_id)},
  ${sqlValue(session.voice_channel_id)}, ${sqlValue(session.output_channel_id)},
  ${sqlValue(session.reminder_channel_id)}, ${sqlValue(session.status)}, ${sqlValue(session.app_name)},
  ${sqlValue(session.started_at)}, NULL, NULL, ${sqlValue(session.next_reminder_at)}, ${sqlValue(session.created_at)}
);
`);
  return session;
}

export async function getSession(sessionId: string): Promise<SessionRecord | null> {
  const rows = await queryAll<SessionRecord>(`SELECT * FROM sessions WHERE id = ${sqlValue(sessionId)} LIMIT 1;`);
  return rows[0] ?? null;
}

export async function getLatestSession(): Promise<SessionRecord | null> {
  const rows = await queryAll<SessionRecord>("SELECT * FROM sessions ORDER BY created_at DESC LIMIT 1;");
  return rows[0] ?? null;
}

export async function getActiveSession(guildId: string): Promise<SessionRecord | null> {
  const rows = await queryAll<SessionRecord>(`
SELECT * FROM sessions
WHERE guild_id = ${sqlValue(guildId)} AND status IN ('recording', 'processing')
ORDER BY created_at DESC
LIMIT 1;
`);
  return rows[0] ?? null;
}

export async function listRecordingSessions(): Promise<SessionRecord[]> {
  return queryAll<SessionRecord>("SELECT * FROM sessions WHERE status = 'recording' ORDER BY started_at ASC;");
}

export async function listSessions(limit = 50): Promise<SessionRecord[]> {
  return queryAll<SessionRecord>(`SELECT * FROM sessions ORDER BY created_at DESC LIMIT ${limit};`);
}

export async function updateSessionStatus(sessionId: string, status: SessionStatus): Promise<void> {
  const ended = status === "completed" || status === "failed" || status === "reset" ? `, ended_at = ${sqlValue(new Date().toISOString())}` : "";
  await execSql(`UPDATE sessions SET status = ${sqlValue(status)}${ended} WHERE id = ${sqlValue(sessionId)};`);
}

export async function updateReminderTimestamps(sessionId: string): Promise<void> {
  const now = new Date().toISOString();
  const next = new Date(Date.now() + config.reminderEveryMinutes * 60_000).toISOString();
  await execSql(`
UPDATE sessions
SET last_reminded_at = ${sqlValue(now)}, next_reminder_at = ${sqlValue(next)}
WHERE id = ${sqlValue(sessionId)};
`);
}

export async function addNote(sessionId: string, content: string): Promise<void> {
  await execSql(`
INSERT INTO notes (id, session_id, content, created_at)
VALUES (${sqlValue(createId("note"))}, ${sqlValue(sessionId)}, ${sqlValue(content)}, ${sqlValue(new Date().toISOString())});
`);
}

export async function listNotes(sessionId: string): Promise<NoteRecord[]> {
  return queryAll<NoteRecord>(`SELECT * FROM notes WHERE session_id = ${sqlValue(sessionId)} ORDER BY created_at ASC;`);
}

export async function insertTranscript(input: {
  sessionId: string;
  userId: string | null;
  audioPath: string;
  text: string;
  durationMs: number | null;
}): Promise<void> {
  const now = new Date().toISOString();
  await execSql(`
INSERT INTO transcripts (id, session_id, user_id, audio_path, text, duration_ms, created_at)
VALUES (
  ${sqlValue(createId("transcript"))},
  ${sqlValue(input.sessionId)},
  ${sqlValue(input.userId)},
  ${sqlValue(input.audioPath)},
  ${sqlValue(input.text)},
  ${sqlValue(input.durationMs)},
  ${sqlValue(now)}
);
`);
}

export async function listTranscripts(sessionId: string): Promise<TranscriptRecord[]> {
  return queryAll<TranscriptRecord>(`SELECT * FROM transcripts WHERE session_id = ${sqlValue(sessionId)} ORDER BY created_at ASC;`);
}

export async function getSessionDiagnostics(sessionId: string): Promise<SessionDiagnosticRecord | null> {
  const rows = await queryAll<SessionDiagnosticRecord>(`
SELECT * FROM session_diagnostics WHERE session_id = ${sqlValue(sessionId)} LIMIT 1;
`);
  return rows[0] ?? null;
}

export async function upsertSessionDiagnostics(
  sessionId: string,
  updates: Partial<Omit<SessionDiagnosticRecord, "session_id" | "updated_at">>
): Promise<void> {
  const hasLastError = Object.prototype.hasOwnProperty.call(updates, "last_error");
  await execSql(`
INSERT INTO session_diagnostics (
  session_id, voice_connection_status, receiver_status, recording_status,
  active_speakers, audio_chunk_count, audio_bytes, transcript_count,
  last_audio_at, last_transcript_at, last_error, updated_at
) VALUES (
  ${sqlValue(sessionId)},
  ${sqlValue(updates.voice_connection_status)},
  ${sqlValue(updates.receiver_status)},
  ${sqlValue(updates.recording_status)},
  ${sqlValue(updates.active_speakers)},
  ${sqlValue(updates.audio_chunk_count)},
  ${sqlValue(updates.audio_bytes)},
  ${sqlValue(updates.transcript_count)},
  ${sqlValue(updates.last_audio_at)},
  ${sqlValue(updates.last_transcript_at)},
  ${sqlValue(updates.last_error)},
  ${sqlValue(new Date().toISOString())}
)
ON CONFLICT(session_id) DO UPDATE SET
  voice_connection_status = COALESCE(excluded.voice_connection_status, voice_connection_status),
  receiver_status = COALESCE(excluded.receiver_status, receiver_status),
  recording_status = COALESCE(excluded.recording_status, recording_status),
  active_speakers = COALESCE(excluded.active_speakers, active_speakers),
  audio_chunk_count = COALESCE(excluded.audio_chunk_count, audio_chunk_count),
  audio_bytes = COALESCE(excluded.audio_bytes, audio_bytes),
  transcript_count = COALESCE(excluded.transcript_count, transcript_count),
  last_audio_at = COALESCE(excluded.last_audio_at, last_audio_at),
  last_transcript_at = COALESCE(excluded.last_transcript_at, last_transcript_at),
  last_error = ${hasLastError ? "excluded.last_error" : "last_error"},
  updated_at = excluded.updated_at;
`);
}

export async function incrementSessionDiagnostics(
  sessionId: string,
  updates: {
    audioChunks?: number;
    audioBytes?: number;
    transcripts?: number;
    lastAudioAt?: string;
    lastTranscriptAt?: string;
    lastError?: string | null;
  }
): Promise<void> {
  await execSql(`
INSERT INTO session_diagnostics (
  session_id, voice_connection_status, receiver_status, recording_status,
  active_speakers, audio_chunk_count, audio_bytes, transcript_count,
  last_audio_at, last_transcript_at, last_error, updated_at
) VALUES (
  ${sqlValue(sessionId)}, NULL, NULL, NULL, 0,
  ${sqlValue(updates.audioChunks ?? 0)},
  ${sqlValue(updates.audioBytes ?? 0)},
  ${sqlValue(updates.transcripts ?? 0)},
  ${sqlValue(updates.lastAudioAt ?? null)},
  ${sqlValue(updates.lastTranscriptAt ?? null)},
  ${sqlValue(updates.lastError ?? null)},
  ${sqlValue(new Date().toISOString())}
)
ON CONFLICT(session_id) DO UPDATE SET
  audio_chunk_count = audio_chunk_count + ${sqlValue(updates.audioChunks ?? 0)},
  audio_bytes = audio_bytes + ${sqlValue(updates.audioBytes ?? 0)},
  transcript_count = transcript_count + ${sqlValue(updates.transcripts ?? 0)},
  last_audio_at = COALESCE(${sqlValue(updates.lastAudioAt ?? null)}, last_audio_at),
  last_transcript_at = COALESCE(${sqlValue(updates.lastTranscriptAt ?? null)}, last_transcript_at),
  last_error = ${updates.lastError === undefined ? "last_error" : sqlValue(updates.lastError)},
  updated_at = ${sqlValue(new Date().toISOString())};
`);
}

export async function insertGeneratedFile(sessionId: string, filePath: string): Promise<GeneratedFileRecord> {
  const now = new Date().toISOString();
  const record: GeneratedFileRecord = {
    id: createId("file"),
    session_id: sessionId,
    type: "main.md",
    file_path: filePath,
    discord_message_id: null,
    discord_channel_id: null,
    sent_to_discord_at: null,
    created_at: now
  };
  await execSql(`
INSERT INTO generated_files (
  id, session_id, type, file_path, discord_message_id,
  discord_channel_id, sent_to_discord_at, created_at
) VALUES (
  ${sqlValue(record.id)}, ${sqlValue(record.session_id)}, ${sqlValue(record.type)},
  ${sqlValue(record.file_path)}, NULL, NULL, NULL, ${sqlValue(record.created_at)}
);
`);
  return record;
}

export async function getGeneratedFile(sessionId: string): Promise<GeneratedFileRecord | null> {
  const rows = await queryAll<GeneratedFileRecord>(`
SELECT * FROM generated_files
WHERE session_id = ${sqlValue(sessionId)} AND type = 'main.md'
ORDER BY created_at DESC
LIMIT 1;
`);
  return rows[0] ?? null;
}

export async function getLatestGeneratedFile(): Promise<GeneratedFileRecord | null> {
  const rows = await queryAll<GeneratedFileRecord>(`
SELECT * FROM generated_files
WHERE type = 'main.md'
ORDER BY created_at DESC
LIMIT 1;
`);
  return rows[0] ?? null;
}

export async function markGeneratedFileSent(fileId: string, channelId: string, messageId: string): Promise<void> {
  await execSql(`
UPDATE generated_files
SET discord_channel_id = ${sqlValue(channelId)},
    discord_message_id = ${sqlValue(messageId)},
    sent_to_discord_at = ${sqlValue(new Date().toISOString())}
WHERE id = ${sqlValue(fileId)};
`);
}

export async function setSetting(key: string, value: string): Promise<void> {
  await execSql(`
INSERT INTO app_settings (key, value, updated_at)
VALUES (${sqlValue(key)}, ${sqlValue(value)}, ${sqlValue(new Date().toISOString())})
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
`);
}

export async function getSetting(key: string): Promise<string | null> {
  const rows = await queryAll<{ value: string | null }>(`SELECT value FROM app_settings WHERE key = ${sqlValue(key)} LIMIT 1;`);
  return rows[0]?.value ?? null;
}
