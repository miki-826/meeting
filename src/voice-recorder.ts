import OpenAI from "openai";
import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import prism from "prism-media";
import { EndBehaviorType, VoiceConnection, VoiceConnectionStatus } from "@discordjs/voice";
import { config } from "./config.js";
import {
  addNote,
  incrementSessionDiagnostics,
  insertTranscript,
  listTranscripts,
  upsertSessionDiagnostics,
  getSetting,
  type SessionRecord
} from "./db.js";
import { defaultTranscribePrompt, promptOrDefault } from "./prompt-presets.js";

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BIT_DEPTH = 16;
const BYTES_PER_SAMPLE = BIT_DEPTH / 8;
const MIN_PCM_BYTES = Math.max(1, config.minTranscribeSeconds) * SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;

type Segment = {
  userId: string;
  startedAt: number;
  buffers: Buffer[];
  bytes: number;
  finalized: boolean;
  opusStream: NodeJS.ReadableStream & { destroy?: () => void };
  chunkTimer: NodeJS.Timeout | null;
  flushChain: Promise<void>;
};

type CaptureController = {
  session: SessionRecord;
  connection: VoiceConnection;
  active: boolean;
  segments: Map<string, Segment>;
  pending: Set<Promise<void>>;
};

const captures = new Map<string, CaptureController>();

function wavHeader(dataBytes: number): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;
  const blockAlign = CHANNELS * BYTES_PER_SAMPLE;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BIT_DEPTH, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

async function writeWav(filePath: string, pcm: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.concat([wavHeader(pcm.length), pcm]));
}

async function deleteSessionAudio(sessionId: string): Promise<void> {
  const audioDir = path.join(config.dataDir, "sessions", sessionId, "audio");
  await fs.rm(audioDir, { recursive: true, force: true });
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { maxBuffer: 1024 * 1024 * 10 }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve();
    });
  });
}

async function prepareTranscriptionAudio(inputPath: string): Promise<string> {
  if (!config.normalizeAudio) return inputPath;
  const outputPath = inputPath.replace(/\.wav$/i, "_clean.wav");
  try {
    await runFfmpeg([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputPath,
      "-ac",
      "1",
      "-ar",
      "16000",
      "-af",
      "highpass=f=80,lowpass=f=7800,afftdn=nf=-25,dynaudnorm=f=150:g=15",
      outputPath
    ]);
    return outputPath;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Audio normalization failed, using raw audio: ${message}`);
    return inputPath;
  }
}

function durationMsFromPcm(bytes: number): number {
  return Math.round((bytes / (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE)) * 1000);
}

async function buildTranscriptionPrompt(sessionId: string): Promise<string | undefined> {
  const prompt = promptOrDefault(await getSetting("transcribe_prompt"), defaultTranscribePrompt);
  const recent = await listTranscripts(sessionId).catch(() => []);
  const recentText = recent
    .slice(-8)
    .map((item) => item.text)
    .join("\n")
    .trim();
  return [prompt, recentText ? `Recent conversation context:\n${recentText}` : ""].filter(Boolean).join("\n\n").slice(-1800);
}

async function transcribeWav(sessionId: string, filePath: string): Promise<string> {
  if (!config.openAiApiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }
  const prompt = await buildTranscriptionPrompt(sessionId);
  const client = new OpenAI({ apiKey: config.openAiApiKey });
  const result = await client.audio.transcriptions.create({
    file: fsSync.createReadStream(filePath),
    model: config.transcribeModel,
    prompt,
    language: config.transcribeLanguage || undefined,
    temperature: 0
  });
  return result.text.trim();
}

async function flushSegment(controller: CaptureController, segment: Segment, reason: string): Promise<void> {
  const pcmBytes = segment.bytes;
  const buffers = segment.buffers;
  segment.buffers = [];
  segment.bytes = 0;

  if (pcmBytes < MIN_PCM_BYTES) {
    return;
  }

  const pcm = Buffer.concat(buffers);
  const durationMs = durationMsFromPcm(pcm.length);
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const audioPath = path.join(config.dataDir, "sessions", controller.session.id, "audio", `${timestamp}_${segment.userId}_${reason}.wav`);
  await writeWav(audioPath, pcm);
  const transcriptionAudioPath = await prepareTranscriptionAudio(audioPath);
  await incrementSessionDiagnostics(controller.session.id, {
    audioChunks: 1,
    audioBytes: pcm.length,
    lastAudioAt: new Date().toISOString(),
    lastError: null
  });

  try {
    const text = await transcribeWav(controller.session.id, transcriptionAudioPath);
    if (text) {
      await insertTranscript({
        sessionId: controller.session.id,
        userId: segment.userId,
        audioPath: transcriptionAudioPath,
        text,
        durationMs
      });
      await addNote(controller.session.id, `[transcript user:${segment.userId} duration:${durationMs}ms] ${text}`);
      await incrementSessionDiagnostics(controller.session.id, {
        transcripts: 1,
        lastTranscriptAt: new Date().toISOString(),
        lastError: null
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await incrementSessionDiagnostics(controller.session.id, { lastError: `transcribe failed (${reason}): ${message}` });
  }
}

function queueSegmentFlush(controller: CaptureController, segment: Segment, reason: string): Promise<void> {
  const flush = segment.flushChain
    .then(() => flushSegment(controller, segment, reason))
    .catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      await incrementSessionDiagnostics(controller.session.id, { lastError: `audio flush failed (${reason}): ${message}` }).catch(console.error);
    });
  segment.flushChain = flush;
  trackPromise(controller, flush);
  return flush;
}

async function finalizeSegment(controller: CaptureController, segment: Segment, reason: string): Promise<void> {
  if (segment.finalized) return;
  segment.finalized = true;
  if (segment.chunkTimer) clearInterval(segment.chunkTimer);
  controller.segments.delete(segment.userId);
  await upsertSessionDiagnostics(controller.session.id, {
    active_speakers: controller.segments.size,
    recording_status: controller.active ? "recording" : "stopping"
  }).catch(console.error);
  await queueSegmentFlush(controller, segment, reason);
}

function trackPromise(controller: CaptureController, promise: Promise<void>): void {
  controller.pending.add(promise);
  promise.finally(() => controller.pending.delete(promise)).catch(() => undefined);
}

function startSpeakerSegment(controller: CaptureController, userId: string): void {
  if (!controller.active || controller.segments.has(userId)) return;

  const opusStream = controller.connection.receiver.subscribe(userId, {
    end: {
      behavior: EndBehaviorType.AfterSilence,
      duration: 1000
    }
  });
  const chunkMs = Math.max(5, config.chunkSeconds) * 1000;
  const segment: Segment = {
    userId,
    startedAt: Date.now(),
    buffers: [],
    bytes: 0,
    finalized: false,
    opusStream,
    chunkTimer: null,
    flushChain: Promise.resolve()
  };
  segment.chunkTimer = setInterval(() => {
    if (!controller.active || segment.finalized) return;
    queueSegmentFlush(controller, segment, "interval");
  }, chunkMs);
  controller.segments.set(userId, segment);
  upsertSessionDiagnostics(controller.session.id, {
    receiver_status: "receiving_audio",
    recording_status: "recording",
    active_speakers: controller.segments.size,
    last_audio_at: new Date().toISOString(),
    last_error: null
  }).catch(console.error);

  try {
    const decoder = new prism.opus.Decoder({
      frameSize: 960,
      channels: CHANNELS,
      rate: SAMPLE_RATE
    });

    decoder.on("data", (chunk: Buffer) => {
      segment.buffers.push(chunk);
      segment.bytes += chunk.length;
    });
    decoder.on("error", (error: Error) => {
      incrementSessionDiagnostics(controller.session.id, { lastError: `opus decode failed: ${error.message}` }).catch(console.error);
    });
    opusStream.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      incrementSessionDiagnostics(controller.session.id, { lastError: `opus receive failed: ${message}` }).catch(console.error);
    });
    opusStream.on("end", () => {
      trackPromise(controller, finalizeSegment(controller, segment, "silence"));
    });
    opusStream.pipe(decoder);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    incrementSessionDiagnostics(controller.session.id, { lastError: `voice decoder setup failed: ${message}` }).catch(console.error);
    trackPromise(controller, finalizeSegment(controller, segment, "decoder-error"));
  }
}

export async function startVoiceCapture(connection: VoiceConnection, session: SessionRecord): Promise<void> {
  const existing = captures.get(session.id);
  if (existing) await stopVoiceCapture(session.id);

  const controller: CaptureController = {
    session,
    connection,
    active: true,
    segments: new Map(),
    pending: new Set()
  };
  captures.set(session.id, controller);
  await upsertSessionDiagnostics(session.id, {
    voice_connection_status: connection.state.status,
    receiver_status: "ready",
    recording_status: "recording",
    active_speakers: 0,
    last_error: null
  });

  connection.on("stateChange", (_oldState, newState) => {
    upsertSessionDiagnostics(session.id, {
      voice_connection_status: newState.status,
      recording_status: newState.status === VoiceConnectionStatus.Destroyed ? "stopped" : "recording"
    }).catch(console.error);
  });

  connection.receiver.speaking.on("start", (userId) => {
    startSpeakerSegment(controller, userId);
  });
}

export async function stopVoiceCapture(sessionId: string): Promise<void> {
  const controller = captures.get(sessionId);
  if (!controller) return;
  controller.active = false;
  await upsertSessionDiagnostics(sessionId, {
    recording_status: "stopping",
    active_speakers: controller.segments.size
  });

  for (const segment of [...controller.segments.values()]) {
    try {
      segment.opusStream.destroy?.();
    } catch {
      // Ignore stream teardown errors while flushing remaining buffers.
    }
    trackPromise(controller, finalizeSegment(controller, segment, "manual-stop"));
  }

  await Promise.allSettled([...controller.pending]);
  captures.delete(sessionId);
  if (config.deleteAudioAfterSessionEnd) {
    await deleteSessionAudio(sessionId).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      incrementSessionDiagnostics(sessionId, { lastError: `audio cleanup failed: ${message}` }).catch(console.error);
    });
  }
  await upsertSessionDiagnostics(sessionId, {
    recording_status: "stopped",
    active_speakers: 0
  });
}
