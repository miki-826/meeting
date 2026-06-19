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
  "Create implementation-ready project requirements from the captured meeting notes, transcripts, and manual notes.",
  "Prioritize the product's unique experience, demo impact, feasibility, and a clear build order for an AI hackathon.",
  "Preserve project-specific names, themes, constraints, commands, APIs, and existing implementation details.",
  "If information is missing, do not pretend it was decided. Mark it as unconfirmed and state what should be checked next.",
  "If transcript text appears mojibake, for example Japanese UTF-8 decoded as Shift_JIS, infer and restore the intended Japanese meaning as much as possible."
].join("\n");

export const projectCompilerContract = [
  "You are a requirements compiler that prepares machine-routable input for /hackathon-build.",
  "This contract has higher priority than user customization. Return a JSON object with exactly these string keys:",
  '"main.md", "project.yaml", "acceptance-tests.md", "asset-request.yaml", "assumptions.md".',
  "All human-readable content must be Japanese. YAML keys and identifiers must use stable English snake_case.",
  "Do not wrap file contents in Markdown fences. Do not include commentary outside the JSON object.",
  "",
  "main.md requirements:",
  "- Start with valid YAML frontmatter using schema_version 2.0.",
  "- Frontmatter must include project, hackathon, experience, priority, capabilities, ui, and deployment.",
  "- project.mode must be one of new, adopt, resume, review.",
  "- priority.must_have must contain at most 3 items. Also provide should_have and cut.",
  "- capabilities must explicitly cover camera, microphone, image_generation, ai_text_analysis, transcription, database, authentication, and three_d.",
  "- Include all numbered sections below in the exact order as Markdown H1 headings, for example '# 1. Project Metadata', even when a section contains unconfirmed items.",
  "1. Project Metadata",
  "2. One Sentence Pitch",
  "3. Theme Interpretation",
  "4. Core Experience",
  "5. Emotional Arc",
  "6. Signature Moment",
  "7. Target User",
  "8. Main User Flow",
  "9. Must Have",
  "10. Should Have",
  "11. Cut List",
  "12. Screen Requirements",
  "13. Design Context",
  "14. Screen Archetypes",
  "15. Theme Lexicon",
  "16. Project-Specific Components",
  "17. AI Requirements",
  "18. Camera Requirements",
  "19. Audio Requirements",
  "20. Score and Confidence",
  "21. Media Requirements",
  "22. Image Generation Candidates",
  "23. Privacy and Security",
  "24. Mock Mode",
  "25. Demo Mode",
  "26. Error and Retry",
  "27. Acceptance Criteria",
  "28. Risk Register",
  "29. Existing Project Context",
  "30. Unknowns and Assumptions",
  "31. Scope Evaluation",
  "32. Environment Variables",
  "33. Deployment",
  "",
  "Decision rules:",
  "- State product direction before adding implementation detail.",
  "- Distinguish theme, emotion, world view, primary action, forbidden expressions, readability needs, and the role of the result screen.",
  "- Describe camera and audio recognition as measurable local signals, optional AI signals, score weights, confidence, privacy, failure handling, and fallbacks.",
  "- Never describe biometric identity verification or medical diagnosis.",
  "- Explain BGM, sound effects, generated-image usage, start conditions, volume, looping, fades, and interruption behavior.",
  "- For each image candidate, include importance, CSS/SVG alternative, and a generation recommendation with a reason.",
  "- Separate Unknowns, Assumptions, and Decisions Required Before Build. Ask no more than 5 truly blocking questions; convert non-blocking gaps into explicit assumptions.",
  "- Acceptance criteria must be observable and testable, including desktop 1440x900 and mobile 390x844 where relevant.",
  "- Include a risk register with probability, impact, and mitigation.",
  "- Include a scope score from 0 to 100, label it feasible, warning, or over_scoped, and list required cuts when necessary.",
  "- For adopt/resume/review, include repository, already implemented, known problems, must preserve, and may replace.",
  "",
  "Companion file requirements:",
  "- project.yaml: machine-readable summary of the frontmatter plus routing hints, capabilities, scope score, and project mode.",
  "- acceptance-tests.md: grouped executable-style acceptance checks for core flow, UI, camera, audio, AI, mock mode, errors, privacy, responsiveness, and demo reliability.",
  "- asset-request.yaml: image, audio, icon, and media candidates with priority, purpose, usage location, fallback, generation decision, and reason.",
  "- assumptions.md: Unknowns, Assumptions, Decisions Required Before Build, Existing Project Context, and the maximum 5 blocking questions.",
  "- If evidence is missing, mark it unconfirmed instead of inventing a decision."
].join("\n");

export function promptOrDefault(value: string | null | undefined, fallback: string): string {
  const trimmed = (value ?? "").trim();
  return trimmed || fallback;
}
