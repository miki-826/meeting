import OpenAI from "openai";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { addNote, getSession, getSetting, listNotes, type NoteRecord, type SessionRecord } from "./db.js";
import { defaultMainPrompt, defaultSummaryPrompt, promptOrDefault } from "./prompt-presets.js";

function formatDate(value: string | null): string {
  if (!value) return "-";
  return new Date(value).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
}

function usefulNotes(notes: NoteRecord[]): NoteRecord[] {
  return notes.filter((note) => {
    const content = note.content.trim();
    if (!content) return false;
    if (content.startsWith("Session started in voice channel")) return false;
    if (content === "main.md was regenerated from the web dashboard.") return false;
    return true;
  });
}

function buildSessionContext(session: SessionRecord, notes: NoteRecord[]): string {
  const noteLines = notes.length
    ? notes.map((note, index) => `${index + 1}. ${note.content}`).join("\n")
    : "No meeting notes or transcript content was captured.";

  return [
    "Create the final main.md from the following MeetingBot session context.",
    "",
    "Session:",
    `- Session ID: ${session.id}`,
    `- App Name: ${session.app_name || "-"}`,
    `- Status: ${session.status}`,
    `- Started At: ${formatDate(session.started_at)}`,
    `- Ended At: ${formatDate(session.ended_at)}`,
    `- Guild ID: ${session.guild_id || "-"}`,
    `- Start Channel ID: ${session.text_channel_id || "-"}`,
    `- Output Channel ID: ${session.output_channel_id || "-"}`,
    `- Voice Channel ID: ${session.voice_channel_id || "-"}`,
    "",
    "Captured meeting notes/transcripts:",
    noteLines,
    "",
    "Important:",
    "- Output only the final main.md Markdown.",
    "- Do not include these instructions or the system prompt in the output.",
    "- Some captured Japanese may be mojibake. Infer and restore the intended Japanese where possible.",
    "- If the captured content is insufficient, clearly state what is missing and list next actions."
  ].join("\n");
}

function fallbackMainMd(session: SessionRecord, notes: NoteRecord[], reason?: string): string {
  const warning = reason ? `\nGeneration error: ${reason}\n` : "";
  const noteCount = notes.length;

  return `# main.md generation failed

## Session

| Item | Value |
|---|---|
| Session ID | ${session.id} |
| App Name | ${session.app_name || "-"} |
| Status | ${session.status} |
| Started At | ${formatDate(session.started_at)} |
| Ended At | ${formatDate(session.ended_at)} |
| Guild ID | ${session.guild_id || "-"} |
| Start Channel ID | ${session.text_channel_id || "-"} |
| Output Channel ID | ${session.output_channel_id || "-"} |
| Voice Channel ID | ${session.voice_channel_id || "-"} |

## Result

MeetingBot could not generate the final prompted main.md.
${warning}
Captured note count: ${noteCount}

## Next Actions

1. Check OPENAI_API_KEY and MAIN_MD_MODEL in Settings.
2. Regenerate main.md from the session page.
3. If the error continues, change MAIN_MD_MODEL to a model that supports Chat Completions.
`;
}

async function generateWithOpenAi(session: SessionRecord, notes: NoteRecord[], mainPrompt: string, summaryPrompt: string): Promise<string> {
  const client = new OpenAI({ apiKey: config.openAiApiKey });
  const response = await client.chat.completions.create({
    model: config.mainMdModel,
    messages: [
      {
        role: "system",
        content: [
          mainPrompt,
          "",
          "Also apply this summary policy when organizing the meeting content:",
          summaryPrompt
        ].join("\n")
      },
      {
        role: "user",
        content: buildSessionContext(session, notes)
      }
    ]
  });

  const content = response.choices[0]?.message?.content?.trim();
  if (!content) throw new Error("OpenAI returned an empty main.md.");
  return content;
}

export async function generateMainMd(session: SessionRecord): Promise<string> {
  const notes = usefulNotes(await listNotes(session.id));
  const mainPrompt = promptOrDefault(await getSetting("main_prompt"), defaultMainPrompt);
  const summaryPrompt = promptOrDefault(await getSetting("summary_prompt"), defaultSummaryPrompt);
  const exportDir = path.join(config.dataDir, "exports", session.id);
  await fs.mkdir(exportDir, { recursive: true });
  const filePath = path.join(exportDir, "main.md");

  let content: string;
  if (!notes.length) {
    content = fallbackMainMd(session, notes, "No meeting notes or transcript content was captured.");
  } else if (!config.openAiApiKey) {
    content = fallbackMainMd(session, notes, "OPENAI_API_KEY is not configured.");
  } else {
    try {
      content = await generateWithOpenAi(session, notes, mainPrompt, summaryPrompt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      content = fallbackMainMd(session, notes, message);
    }
  }

  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

export async function regenerateMainMd(sessionId: string): Promise<string> {
  const session = await getSession(sessionId);
  if (!session) throw new Error("Session not found.");
  await addNote(session.id, "main.md was regenerated from the web dashboard.");
  return generateMainMd(session);
}
