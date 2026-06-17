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
    "- If the captured content is insufficient, create a short main.md that clearly says the meeting content was not captured and lists the next actions."
  ].join("\n");
}

function fallbackMainMd(session: SessionRecord, notes: NoteRecord[], reason?: string): string {
  const noteLines = notes.length
    ? notes.map((note, index) => `${index + 1}. ${note.content}`).join("\n")
    : "No meeting notes or transcript content was captured.";
  const warning = reason ? `\nOpenAI generation note: ${reason}\n` : "";

  return `# MeetingBot Generated Spec

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

Meeting content was not captured well enough to generate a full hackathon main.md.
Use \`/add-dev content:<text>\` or the next transcription step to add the app idea, rules, AI usage, repository URL, and design direction, then regenerate \`main.md\`.
${warning}
## Captured Notes

${noteLines}

## Next Actions

1. Add the app idea with \`/add-dev content:<text>\`.
2. Run \`/end-dev\` again, or use the Web dashboard's \`Regenerate main.md\`.
3. Confirm that the generated file no longer contains the prompt text itself.
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
          "会議内容を整理するときは、次のsummary方針も反映してください。",
          summaryPrompt
        ].join("\n")
      },
      {
        role: "user",
        content: buildSessionContext(session, notes)
      }
    ],
    temperature: 0.3
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
    content = fallbackMainMd(session, notes);
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
