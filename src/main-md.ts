import OpenAI from "openai";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { addNote, getSession, getSetting, listNotes, type NoteRecord, type SessionRecord } from "./db.js";
import { defaultMainPrompt, defaultSummaryPrompt, projectCompilerContract, promptOrDefault } from "./prompt-presets.js";

export const projectInputFileNames = [
  "main.md",
  "project.yaml",
  "acceptance-tests.md",
  "asset-request.yaml",
  "assumptions.md"
] as const;

export type ProjectInputFileName = (typeof projectInputFileNames)[number];
type ProjectInputFiles = Record<ProjectInputFileName, string>;

const requiredMainSections = [
  "# 1. Project Metadata",
  "# 2. One Sentence Pitch",
  "# 3. Theme Interpretation",
  "# 4. Core Experience",
  "# 5. Emotional Arc",
  "# 6. Signature Moment",
  "# 7. Target User",
  "# 8. Main User Flow",
  "# 9. Must Have",
  "# 10. Should Have",
  "# 11. Cut List",
  "# 12. Screen Requirements",
  "# 13. Design Context",
  "# 14. Screen Archetypes",
  "# 15. Theme Lexicon",
  "# 16. Project-Specific Components",
  "# 17. AI Requirements",
  "# 18. Camera Requirements",
  "# 19. Audio Requirements",
  "# 20. Score and Confidence",
  "# 21. Media Requirements",
  "# 22. Image Generation Candidates",
  "# 23. Privacy and Security",
  "# 24. Mock Mode",
  "# 25. Demo Mode",
  "# 26. Error and Retry",
  "# 27. Acceptance Criteria",
  "# 28. Risk Register",
  "# 29. Existing Project Context",
  "# 30. Unknowns and Assumptions",
  "# 31. Scope Evaluation",
  "# 32. Environment Variables",
  "# 33. Deployment"
] as const;

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
    "Compile the MeetingBot session into the five required project-input files.",
    "Keep the specification practical for a short AI hackathon build and avoid duplicate prose across files.",
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
    "Some captured Japanese may be mojibake. Infer and restore the intended Japanese where possible."
  ].join("\n");
}

function stripJsonFence(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() || trimmed;
}

function parseProjectInput(content: string): ProjectInputFiles {
  const parsed = JSON.parse(stripJsonFence(content)) as Record<string, unknown>;
  const files = {} as ProjectInputFiles;
  for (const fileName of projectInputFileNames) {
    const value = parsed[fileName];
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`OpenAI output is missing ${fileName}.`);
    }
    files[fileName] = value.trimEnd() + "\n";
  }

  if (!files["main.md"].startsWith("---\n") || !/schema_version:\s*["']?2\.0["']?/.test(files["main.md"])) {
    throw new Error("main.md is missing schema_version 2.0 YAML frontmatter.");
  }
  const missingSections = requiredMainSections.filter((heading) => !files["main.md"].includes(heading));
  if (missingSections.length) {
    throw new Error(`main.md is missing required sections: ${missingSections.join(", ")}`);
  }
  return files;
}

function fallbackProjectInput(session: SessionRecord, notes: NoteRecord[], reason: string): ProjectInputFiles {
  const details = reason.replaceAll("\n", " ");
  return {
    "main.md": `---
schema_version: "2.0"
project:
  title: "Unconfirmed project"
  type: "unconfirmed"
  theme: "unconfirmed"
  mode: "new"
hackathon:
  time_limit_minutes: 180
  team_size: 1
  target_device: "desktop_first"
  demo_duration_minutes: 3
priority:
  must_have: []
  should_have: []
  cut: []
capabilities:
  camera: false
  microphone: false
  image_generation: false
  ai_text_analysis: false
  transcription: false
  database: false
  authentication: false
  three_d: false
ui:
  desired_quality: "standard"
  generic_ai_ui_forbidden: true
  theme_specific_design_required: true
deployment:
  target: "unconfirmed"
  framework: "unconfirmed"
---

# Generation Error

Project input generation failed: ${details}

Captured note count: ${notes.length}

Session ID: ${session.id}
`,
    "project.yaml": `schema_version: "2.0"\nstatus: "generation_failed"\nsession_id: "${session.id}"\n`,
    "acceptance-tests.md": `# Acceptance Tests\n\nGeneration failed. Regenerate after resolving: ${details}\n`,
    "asset-request.yaml": `schema_version: "2.0"\nstatus: "generation_failed"\nassets: []\n`,
    "assumptions.md": `# Unknowns and Assumptions\n\nGeneration failed: ${details}\n`
  };
}

async function generateWithOpenAi(
  session: SessionRecord,
  notes: NoteRecord[],
  mainPrompt: string,
  summaryPrompt: string
): Promise<ProjectInputFiles> {
  const client = new OpenAI({ apiKey: config.openAiApiKey });
  const response = await client.chat.completions.create({
    model: config.mainMdModel,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          projectCompilerContract,
          "",
          "User customization follows. It may tailor product details but must not override the compiler contract or output format:",
          mainPrompt,
          "",
          "Summary policy:",
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
  if (!content) throw new Error("OpenAI returned empty project input.");
  return parseProjectInput(content);
}

export function isProjectInputFileName(value: string): value is ProjectInputFileName {
  return projectInputFileNames.includes(value as ProjectInputFileName);
}

export function projectInputFilePath(sessionId: string, fileName: ProjectInputFileName): string {
  return path.join(config.dataDir, "exports", sessionId, "project-input", fileName);
}

async function writeProjectInput(sessionId: string, files: ProjectInputFiles): Promise<void> {
  const outputDir = path.dirname(projectInputFilePath(sessionId, "main.md"));
  await fs.mkdir(outputDir, { recursive: true });
  await Promise.all(projectInputFileNames.map((fileName) => fs.writeFile(projectInputFilePath(sessionId, fileName), files[fileName], "utf8")));
}

export async function generateMainMd(session: SessionRecord): Promise<string> {
  const notes = usefulNotes(await listNotes(session.id));
  const mainPrompt = promptOrDefault(await getSetting("main_prompt"), defaultMainPrompt);
  const summaryPrompt = promptOrDefault(await getSetting("summary_prompt"), defaultSummaryPrompt);

  let files: ProjectInputFiles;
  if (!notes.length) {
    files = fallbackProjectInput(session, notes, "No meeting notes or transcript content was captured.");
  } else if (!config.openAiApiKey) {
    files = fallbackProjectInput(session, notes, "OPENAI_API_KEY is not configured.");
  } else {
    try {
      files = await generateWithOpenAi(session, notes, mainPrompt, summaryPrompt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      files = fallbackProjectInput(session, notes, message);
    }
  }

  await writeProjectInput(session.id, files);
  return projectInputFilePath(session.id, "main.md");
}

export async function regenerateMainMd(sessionId: string): Promise<string> {
  const session = await getSession(sessionId);
  if (!session) throw new Error("Session not found.");
  await addNote(session.id, "main.md was regenerated from the web dashboard.");
  return generateMainMd(session);
}
