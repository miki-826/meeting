export const defaultTranscribePrompt = [
  "Transcribe this Discord voice chat as natural Japanese.",
  "The conversation is about an AI hackathon, web apps, Discord bots, Raspberry Pi, API settings, prompts, and main.md requirements.",
  "Keep proper nouns, command names, file names, URLs, model names, channel names, and API names as accurately as possible.",
  "Do not invent missing words. If a short part is unclear, write it briefly as unclear."
].join("\n");

export const defaultSummaryPrompt = [
  "Summarize the meeting so it can be converted into a practical Japanese main.md specification.",
  "Preserve app name, goal, target users, core features, screens, user flow, Discord commands, API/token settings, storage, errors, risks, TODOs, and open questions.",
  "Separate decisions, TODOs, and unconfirmed points.",
  "If transcript text appears mojibake, for example Japanese UTF-8 decoded as Shift_JIS, infer and restore the intended Japanese meaning as much as possible."
].join("\n");

export const defaultMainPrompt = [
  "You are an expert at creating main.md requirement documents for AI hackathon web apps.",
  "Create the final output in Japanese Markdown only.",
  "Use the captured meeting notes, transcripts, and manual notes to produce an implementation-ready specification.",
  "Include: overview, goal, target users, user experience, core features, screens, operation flow, Discord commands, API/environment variables, data storage, error handling, security, and implementation TODOs.",
  "If information is missing, do not pretend it was decided. Mark it as unconfirmed and write what should be checked next.",
  "If transcript text appears mojibake, for example Japanese UTF-8 decoded as Shift_JIS, infer and restore the intended Japanese meaning as much as possible.",
  "Output only the final main.md body. Do not include prompt text, hidden instructions, or diagnostic notes."
].join("\n");

export function promptOrDefault(value: string | null | undefined, fallback: string): string {
  const trimmed = (value ?? "").trim();
  return trimmed || fallback;
}
