import express from "express";
import fs from "node:fs/promises";
import { config, dashboardUrl } from "./config.js";
import { discordClient, syncDiscordCommands } from "./discord-bot.js";
import {
  getGeneratedFile,
  getLatestGeneratedFile,
  getSessionDiagnostics,
  getSession,
  insertGeneratedFile,
  listNotes,
  listTranscripts,
  listSessions,
  getSetting,
  setSetting,
  type SessionRecord
} from "./db.js";
import { generateMainMd } from "./main-md.js";
import { sendMainMdToDiscord } from "./discord-delivery.js";
import { editableEnvKeys, maskSecret, readEnvFile, secretEnvKeys, writeEnvFile, type EditableEnvKey } from "./settings.js";

function escapeHtml(value: string | number | null | undefined): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function statusTone(status: string | null | undefined): string {
  if (!status) return "neutral";
  if (["recording", "ready", "receiving_audio", "completed", "active"].includes(status)) return "good";
  if (["processing", "stopping", "connecting", "signalling"].includes(status)) return "warn";
  if (["failed", "reset", "destroyed", "disconnected", "not_joined"].includes(status)) return "bad";
  return "neutral";
}

function badge(value: string | null | undefined): string {
  const label = value || "-";
  return `<span class="badge ${statusTone(label)}">${escapeHtml(label)}</span>`;
}

function metric(label: string, value: string | number | null | undefined, hint = ""): string {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value ?? "-")}</strong>${hint ? `<small>${escapeHtml(hint)}</small>` : ""}</div>`;
}

function emptyState(text: string): string {
  return `<div class="empty">${escapeHtml(text)}</div>`;
}

function page(title: string, body: string, active: "sessions" | "settings" | "help" = "sessions"): string {
  const nav = [
    ["sessions", "/", "Sessions"],
    ["settings", "/settings", "Settings"],
    ["help", "/help", "Help"],
    ["latest", "/latest/main.md", "Latest main.md"]
  ]
    .map(([key, href, label]) => `<a class="${active === key ? "active" : ""}" href="${href}">${label}</a>`)
    .join("");

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f4f2;
      --surface: #ffffff;
      --ink: #0a0a0a;
      --muted: #626262;
      --line: #d8d8d4;
      --soft: #eeeeeb;
      --dark: #0a0a0a;
      --good: #0f5132;
      --good-bg: #e9f7ef;
      --warn: #6b4e00;
      --warn-bg: #fff6d8;
      --bad: #8a1f1f;
      --bad-bg: #fdecec;
      --radius: 8px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.55;
    }
    a { color: inherit; text-decoration-thickness: 1px; text-underline-offset: 3px; }
    main { max-width: 1180px; margin: 0 auto; padding: 26px 20px 48px; }
    .topbar {
      position: sticky;
      top: 0;
      z-index: 2;
      background: rgba(244, 244, 242, 0.94);
      border-bottom: 1px solid var(--line);
      backdrop-filter: blur(10px);
    }
    .topbar-inner {
      max-width: 1180px;
      margin: 0 auto;
      padding: 14px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
    }
    .brand { display: flex; flex-direction: column; gap: 0; min-width: 150px; }
    .brand strong { font-size: 15px; letter-spacing: 0; }
    .brand small { color: var(--muted); font-size: 12px; }
    nav { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
    nav a {
      border: 1px solid transparent;
      border-radius: 999px;
      padding: 7px 11px;
      color: var(--muted);
      text-decoration: none;
      font-size: 14px;
    }
    nav a:hover, nav a.active { border-color: var(--ink); color: var(--ink); background: var(--surface); }
    .page-head {
      display: grid;
      gap: 8px;
      margin: 28px 0 22px;
      padding-bottom: 18px;
      border-bottom: 1px solid var(--line);
    }
    .eyebrow {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0;
      font-weight: 700;
    }
    h1, h2, h3 { margin: 0; line-height: 1.2; letter-spacing: 0; }
    h1 { font-size: clamp(30px, 4vw, 48px); }
    h2 { font-size: 19px; }
    h3 { font-size: 15px; }
    p { margin: 0; color: var(--muted); }
    .layout { display: grid; gap: 18px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
    .split { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 16px; align-items: start; }
    .panel {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      padding: 18px;
    }
    .panel-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 14px;
    }
    .panel-head p { margin-top: 4px; font-size: 14px; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 14px 0 0; }
    .button, button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 38px;
      padding: 8px 12px;
      border: 1px solid var(--dark);
      border-radius: 7px;
      background: var(--dark);
      color: #fff;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
      text-decoration: none;
      white-space: nowrap;
    }
    .button.secondary, button.secondary { background: var(--surface); color: var(--ink); }
    .button.danger, button.danger { background: #8a1f1f; border-color: #8a1f1f; }
    input, textarea, select {
      width: 100%;
      padding: 10px 11px;
      border: 1px solid #bdbdb8;
      border-radius: 7px;
      background: #fff;
      color: var(--ink);
      font: inherit;
    }
    textarea { min-height: 160px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13px; }
    label { display: grid; gap: 6px; margin: 12px 0; font-weight: 750; }
    label small { color: var(--muted); font-weight: 500; }
    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      overflow: hidden;
    }
    th, td { padding: 11px 12px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    th { width: 190px; background: #f8f8f6; font-size: 12px; text-transform: uppercase; color: var(--muted); letter-spacing: 0; }
    tr:last-child th, tr:last-child td { border-bottom: 0; }
    .table-wrap { overflow-x: auto; border-radius: var(--radius); }
    .session-link { font-weight: 800; text-decoration: none; }
    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      border-radius: 999px;
      padding: 3px 9px;
      font-size: 12px;
      font-weight: 800;
      border: 1px solid var(--line);
      background: var(--soft);
      color: var(--ink);
      white-space: nowrap;
    }
    .badge.good { background: var(--good-bg); color: var(--good); border-color: #b8dec8; }
    .badge.warn { background: var(--warn-bg); color: var(--warn); border-color: #ead98c; }
    .badge.bad { background: var(--bad-bg); color: var(--bad); border-color: #efb9b9; }
    .metric {
      display: grid;
      gap: 4px;
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      padding: 14px;
      min-height: 96px;
    }
    .metric span, .metric small { color: var(--muted); font-size: 12px; }
    .metric strong { font-size: 24px; line-height: 1.1; overflow-wrap: anywhere; }
    .callout {
      border-left: 4px solid var(--ink);
      background: var(--surface);
      padding: 14px 16px;
      border-radius: 0 var(--radius) var(--radius) 0;
    }
    .empty {
      border: 1px dashed #bdbdb8;
      border-radius: var(--radius);
      padding: 18px;
      color: var(--muted);
      background: #fafaf8;
    }
    .settings-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(330px, 1fr)); gap: 14px; }
    .prompt-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; }
    .help-list { display: grid; gap: 10px; padding-left: 20px; margin: 0; }
    .code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; background: #efefec; border-radius: 5px; padding: 1px 5px; }
    pre { padding: 16px; overflow: auto; background: #111; color: #f4f4f2; border-radius: var(--radius); }
    @media (max-width: 760px) {
      .topbar-inner { align-items: flex-start; flex-direction: column; }
      nav { justify-content: flex-start; }
      main { padding: 20px 14px 40px; }
      .split { grid-template-columns: 1fr; }
      th { width: auto; }
      table, thead, tbody, tr, th, td { display: block; }
      thead { display: none; }
      tr { border-bottom: 1px solid var(--line); }
      th, td { border-bottom: 0; }
      td { padding-top: 3px; }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="topbar-inner">
      <a class="brand" href="/"><strong>MeetingBot</strong><small>Discord VC to main.md</small></a>
      <nav>${nav}</nav>
    </div>
  </header>
  <main>${body}</main>
</body>
</html>`;
}

function cookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const chunk of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = chunk.trim().split("=");
    if (rawKey === name) return decodeURIComponent(rawValue.join("="));
  }
  return null;
}

function isAuthed(req: express.Request): boolean {
  const token = cookieValue(req.headers.cookie, "talk2main_admin");
  return token === config.webAdminPassword;
}

function requireAdmin(req: express.Request, res: express.Response): boolean {
  if (isAuthed(req)) return true;
  res.status(401).send(page(
    "Admin Login",
    `<div class="page-head"><span class="eyebrow">Private Area</span><h1>Admin Login</h1><p>設定変更には管理パスワードが必要です。</p></div>
    <section class="panel" style="max-width:520px">
      <form method="post" action="/login">
        <label>管理パスワード<input name="password" type="password" autocomplete="current-password"></label>
        <div class="actions"><button>Login</button></div>
      </form>
      <p style="margin-top:12px"><small>初期値は .env の <span class="code">WEB_ADMIN_PASSWORD</span> で変更できます。</small></p>
    </section>`,
    "settings"
  ));
  return false;
}

function sessionTable(sessions: SessionRecord[]): string {
  if (sessions.length === 0) return emptyState("まだセッションがありません。Discordで /start-dev を実行するとここに表示されます。");
  const rows = sessions.map((session) => `
    <tr>
      <td><a class="session-link" href="/sessions/${encodeURIComponent(session.id)}">${escapeHtml(session.app_name || session.id)}</a><br><small>${escapeHtml(session.id)}</small></td>
      <td>${badge(session.status)}</td>
      <td>${escapeHtml(session.started_at)}</td>
      <td>${session.ended_at ? escapeHtml(session.ended_at) : "-"}</td>
    </tr>`).join("");
  return `<div class="table-wrap"><table><thead><tr><th>Session</th><th>Status</th><th>Started</th><th>Ended</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function envInput(key: EditableEnvKey, value: string): string {
  const isSecret = secretEnvKeys.has(key);
  const shown = isSecret ? "" : value;
  const placeholder = isSecret && value ? maskSecret(value) : "";
  const saved = isSecret && value ? `<small>保存済み: ${escapeHtml(maskSecret(value))}</small>` : "";
  return `<label>${escapeHtml(key)}${saved}
    <input name="${escapeHtml(key)}" value="${escapeHtml(shown)}" placeholder="${escapeHtml(placeholder)}" ${isSecret ? 'autocomplete="off"' : ""}>
  </label>`;
}

function envSection(title: string, description: string, keys: EditableEnvKey[], values: Record<string, string>): string {
  const inputs = keys.map((key) => envInput(key, values[key] ?? "")).join("");
  return `<section class="panel"><div class="panel-head"><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></div></div>${inputs}</section>`;
}

export async function startWebServer(): Promise<void> {
  const app = express();
  app.use(express.urlencoded({ extended: true }));

  app.post("/login", (req, res) => {
    const password = String(req.body.password || "");
    if (password !== config.webAdminPassword) {
      res.status(403).send(page("Login Failed", `<div class="page-head"><span class="eyebrow">Login</span><h1>Login Failed</h1><p>管理パスワードが違います。</p></div><a class="button secondary" href="/settings">Try again</a>`, "settings"));
      return;
    }
    res.setHeader("Set-Cookie", `talk2main_admin=${encodeURIComponent(password)}; HttpOnly; SameSite=Lax; Path=/`);
    res.redirect("/settings");
  });

  app.post("/logout", (_req, res) => {
    res.setHeader("Set-Cookie", "talk2main_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    res.redirect("/");
  });

  app.get("/", async (_req, res) => {
    const sessions = await listSessions();
    const latest = await getLatestGeneratedFile();
    const recordingCount = sessions.filter((session) => session.status === "recording").length;
    const completedCount = sessions.filter((session) => session.status === "completed").length;
    const failedCount = sessions.filter((session) => session.status === "failed").length;
    const latestLink = latest ? `<a class="button" href="/latest/main.md">Download latest main.md</a>` : `<span class="button secondary" aria-disabled="true">No main.md yet</span>`;
    res.send(page("MeetingBot", `
      <div class="page-head">
        <span class="eyebrow">Dashboard</span>
        <h1>Discord会議から main.md へ</h1>
        <p>${escapeHtml(dashboardUrl())}</p>
        <div class="actions">${latestLink}<a class="button secondary" href="/settings">Open settings</a><a class="button secondary" href="/help">Command guide</a></div>
      </div>
      <section class="grid">
        ${metric("Recording", recordingCount)}
        ${metric("Completed", completedCount)}
        ${metric("Failed", failedCount)}
        ${metric("Total Sessions", sessions.length)}
      </section>
      <section class="panel" style="margin-top:16px">
        <div class="panel-head"><div><h2>Sessions</h2><p>録音、文字起こし、main.md生成の履歴です。</p></div></div>
        ${sessionTable(sessions)}
      </section>`));
  });

  app.get("/help", (_req, res) => {
    res.send(page("Help", `
      <div class="page-head">
        <span class="eyebrow">Guide</span>
        <h1>操作方法と設定の見方</h1>
        <p>Discordコマンド、API設定、文字起こし精度、main.md生成までをここで確認できます。</p>
      </div>
      <div class="layout">
        <section class="panel">
          <div class="panel-head"><div><h2>基本の流れ</h2><p>普段使う操作はこの順番です。</p></div></div>
          <ol class="help-list">
            <li><a href="/settings">Settings</a> でDiscord Token、OpenAI API Key、プロンプトを設定します。</li>
            <li>設定を保存したら <strong>Restart App and Apply .env</strong> を押します。</li>
            <li>Discordコマンドが出ない時は <strong>Sync Discord Commands Now</strong> を押します。</li>
            <li>DiscordのVCに入って <span class="code">/start-dev</span> を実行します。</li>
            <li>会議が終わったら <span class="code">/end-dev</span> を実行します。</li>
            <li>生成された <span class="code">main.md</span> はDiscordへ送信され、Webからもダウンロードできます。</li>
          </ol>
        </section>

        <section class="panel">
          <div class="panel-head"><div><h2>Discord Commands</h2><p>Botに入力するコマンド一覧です。</p></div></div>
          <div class="table-wrap"><table>
            <tr><th>Command</th><th>用途</th></tr>
            <tr><td><span class="code">/start-dev</span></td><td>VC録音と文字起こしを開始します。必要ならアプリ名と出力チャンネルを指定します。</td></tr>
            <tr><td><span class="code">/end-dev</span></td><td>録音を終了し、main.mdを生成してDiscordへ送信します。</td></tr>
            <tr><td><span class="code">/status-dev</span></td><td>VC接続、録音、文字起こし件数、最後のエラーを確認します。</td></tr>
            <tr><td><span class="code">/add-dev</span></td><td>会議中の補足メモを追加します。</td></tr>
            <tr><td><span class="code">/export-dev</span></td><td>生成済みのmain.mdを再送信します。</td></tr>
            <tr><td><span class="code">/set-prompt</span></td><td>Discordからmain.md用プロンプトを更新します。</td></tr>
            <tr><td><span class="code">/show-prompt</span></td><td>現在のmain.md用プロンプトを表示します。</td></tr>
            <tr><td><span class="code">/reset-dev</span></td><td>進行中セッションをリセットします。</td></tr>
          </table></div>
        </section>

        <section class="panel">
          <div class="panel-head"><div><h2>音声認識の設定</h2><p>精度が気になる時に見る項目です。</p></div></div>
          <div class="table-wrap"><table>
            <tr><th>TRANSCRIBE_MODEL</th><td><span class="code">gpt-4o-transcribe</span> が精度優先です。速度優先なら <span class="code">gpt-4o-mini-transcribe</span> に変更できます。</td></tr>
            <tr><th>TRANSCRIBE_LANGUAGE</th><td>日本語会議なら <span class="code">ja</span> のままにします。</td></tr>
            <tr><th>MIN_TRANSCRIBE_SECONDS</th><td>短すぎるノイズを捨てる秒数です。聞き逃しが多いなら1、ノイズが多いなら2から3にします。</td></tr>
            <tr><th>NORMALIZE_AUDIO</th><td><span class="code">true</span> で音量正規化、ノイズ低減、16kHzモノラル変換を行います。</td></tr>
            <tr><th>Transcribe Prompt</th><td>固有名詞、サービス名、専門用語、話者の癖を入れると認識が安定します。</td></tr>
          </table></div>
        </section>

        <section class="panel">
          <div class="panel-head"><div><h2>Botに必要な権限</h2><p>VC録音とmain.md送信に必要です。</p></div></div>
          <div class="grid">
            ${metric("Text", "Send / Attach", "メッセージ送信、ファイル添付")}
            ${metric("Voice", "Connect / Speak", "VC参加と音声受信")}
            ${metric("Commands", "applications.commands", "スラッシュコマンド")}
          </div>
        </section>
      </div>`, "help"));
  });

  app.get("/settings", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const envValues = await readEnvFile();
    const mainPrompt = await getSetting("main_prompt");
    const transcribePrompt = await getSetting("transcribe_prompt");
    const summaryPrompt = await getSetting("summary_prompt");
    res.send(page("Settings", `
      <div class="page-head">
        <span class="eyebrow">Settings</span>
        <h1>設定とプロンプト</h1>
        <p>API、Discord、音声認識、main.md生成をまとめて調整できます。トークン欄は空のまま保存すると既存値を維持します。</p>
      </div>
      <form method="post" action="/settings">
        <div class="settings-grid">
          ${envSection("Discord", "Bot接続と送信先チャンネルの設定です。", ["DISCORD_TOKEN", "DISCORD_CLIENT_ID", "DISCORD_GUILD_ID", "DISCORD_OUTPUT_CHANNEL_ID"], envValues)}
          ${envSection("OpenAI", "文字起こし、要約、main.md生成に使うモデルとAPIキーです。", ["OPENAI_API_KEY", "TRANSCRIBE_MODEL", "TRANSCRIBE_LANGUAGE", "MIN_TRANSCRIBE_SECONDS", "NORMALIZE_AUDIO", "SUMMARY_MODEL", "MAIN_MD_MODEL"], envValues)}
          ${envSection("Web", "管理画面の接続先とパスワードです。", ["WEB_HOST", "WEB_PORT", "WEB_ADMIN_PASSWORD"], envValues)}
          ${envSection("Runtime", "録音チャンク、通知、セッション継続時間の設定です。", ["CHUNK_SECONDS", "SUMMARY_EVERY_CHUNKS", "REMINDER_EVERY_MINUTES", "REMINDER_CHANNEL_MODE", "MAX_SESSION_MINUTES"], envValues)}
          ${envSection("Storage", "録音、文字起こし、要約データの保存設定です。", ["DATA_DIR", "DELETE_AUDIO_AFTER_SESSION_END", "KEEP_TRANSCRIPTS", "KEEP_SUMMARIES"], envValues)}
          ${envSection("Raspberry Pi", "Piへの配置とサービス名です。", ["PI_HOST", "PI_USER", "PI_PORT", "PI_APP_DIR", "PI_SERVICE_NAME", "INITIALIZE_PI"], envValues)}
        </div>
        <section class="panel" style="margin-top:14px">
          <div class="panel-head"><div><h2>Prompts</h2><p>Webから編集するのがおすすめです。Discordコマンドより長文を扱いやすくなります。</p></div></div>
          <div class="prompt-grid">
            <label>main.md Prompt<textarea name="main_prompt">${escapeHtml(mainPrompt || "")}</textarea></label>
            <label>Transcribe Prompt<textarea name="transcribe_prompt">${escapeHtml(transcribePrompt || "")}</textarea></label>
            <label>Summary Prompt<textarea name="summary_prompt">${escapeHtml(summaryPrompt || "")}</textarea></label>
          </div>
        </section>
        <div class="actions"><button>Save Settings</button></div>
      </form>
      <div class="actions">
        <form method="post" action="/settings/restart"><button class="danger">Restart App and Apply .env</button></form>
        <form method="post" action="/settings/sync-discord-commands"><button class="secondary">Sync Discord Commands Now</button></form>
        <form method="post" action="/logout"><button class="secondary">Logout</button></form>
      </div>`, "settings"));
  });

  app.post("/settings", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const existing = await readEnvFile();
    const envUpdates: Record<string, string> = {};
    for (const key of editableEnvKeys) {
      const value = req.body[key];
      if (value === undefined) continue;
      const next = String(value);
      envUpdates[key] = secretEnvKeys.has(key) && next === "" ? existing[key] ?? "" : next;
    }
    await writeEnvFile(envUpdates);
    await setSetting("main_prompt", String(req.body.main_prompt || ""));
    await setSetting("transcribe_prompt", String(req.body.transcribe_prompt || ""));
    await setSetting("summary_prompt", String(req.body.summary_prompt || ""));
    res.send(page("Settings Saved", `
      <div class="page-head"><span class="eyebrow">Saved</span><h1>Settings Saved</h1><p>.envに関わる項目はアプリ再起動後に反映されます。</p></div>
      <div class="actions">
        <a class="button secondary" href="/settings">Back to settings</a>
        <form method="post" action="/settings/restart"><button class="danger">Restart App and Apply .env</button></form>
      </div>`, "settings"));
  });

  app.post("/settings/restart", (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.send(page("Restarting", `<div class="page-head"><span class="eyebrow">Restart</span><h1>Restarting</h1><p>アプリを再起動しています。数秒後にもう一度アクセスしてください。</p></div>`, "settings"));
    setTimeout(() => process.exit(0), 500);
  });

  app.post("/settings/sync-discord-commands", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const results = await syncDiscordCommands();
      res.send(page("Discord Commands Synced", `
        <div class="page-head"><span class="eyebrow">Discord</span><h1>Commands Synced</h1><p>Guild commandは通常数秒で反映されます。</p></div>
        <pre>${escapeHtml(results.join("\n") || "No result")}</pre>
        <div class="actions"><a class="button secondary" href="/settings">Back to settings</a></div>`, "settings"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).send(page("Discord Command Sync Failed", `
        <div class="page-head"><span class="eyebrow">Discord</span><h1>Command Sync Failed</h1><p>Discordコマンドの同期に失敗しました。</p></div>
        <pre>${escapeHtml(message)}</pre>
        <div class="actions"><a class="button secondary" href="/settings">Back to settings</a></div>`, "settings"));
    }
  });

  app.get("/latest/main.md", async (_req, res) => {
    const generated = await getLatestGeneratedFile();
    if (!generated) {
      res.status(404).send("main.md is not generated.");
      return;
    }
    res.download(generated.file_path, "main.md");
  });

  app.get("/sessions/:id", async (req, res) => {
    const session = await getSession(req.params.id);
    if (!session) {
      res.status(404).send(page("Not Found", `<div class="page-head"><span class="eyebrow">404</span><h1>Session not found</h1></div>`));
      return;
    }
    const generated = await getGeneratedFile(session.id);
    const notes = await listNotes(session.id);
    const diagnostics = await getSessionDiagnostics(session.id);
    const transcripts = await listTranscripts(session.id);
    const canDownload = generated ? `<a class="button" href="/sessions/${encodeURIComponent(session.id)}/main.md">Download main.md</a>` : `<span class="button secondary" aria-disabled="true">main.md not generated</span>`;
    const discordStatus = generated?.sent_to_discord_at
      ? `Sent / Channel: ${generated.discord_channel_id || "-"} / Message: ${generated.discord_message_id || "-"} / At: ${generated.sent_to_discord_at}`
      : generated
        ? "Not sent or failed"
        : "Not generated";
    const noteList = notes.map((note) => `<li>${escapeHtml(note.content)}</li>`).join("");
    const transcriptRows = transcripts.map((transcript) => `
      <tr>
        <td>${escapeHtml(transcript.created_at)}</td>
        <td>${escapeHtml(transcript.user_id || "-")}</td>
        <td>${escapeHtml(transcript.duration_ms || "-")}</td>
        <td>${escapeHtml(transcript.text)}</td>
      </tr>`).join("");
    res.send(page(
      `Session ${session.id}`,
      `<div class="page-head">
        <span class="eyebrow">Session</span>
        <h1>${escapeHtml(session.app_name || session.id)}</h1>
        <p>${escapeHtml(session.id)}</p>
        <div class="actions"><a class="button secondary" href="/">Back</a>${canDownload}</div>
      </div>
      <section class="grid">
        ${metric("Session Status", session.status)}
        ${metric("Voice", diagnostics?.voice_connection_status || "-")}
        ${metric("Recording", diagnostics?.recording_status || "-")}
        ${metric("Transcripts", transcripts.length)}
      </section>
      <div class="split" style="margin-top:16px">
        <section class="layout">
          <section class="panel">
            <div class="panel-head"><div><h2>Recording Status</h2><p>音声が届いているか、どこで止まっているかを確認できます。</p></div>${badge(diagnostics?.receiver_status || "-")}</div>
            <div class="table-wrap"><table>
              <tr><th>Voice Connection</th><td>${badge(diagnostics?.voice_connection_status || "-")}</td></tr>
              <tr><th>Recording</th><td>${badge(diagnostics?.recording_status || "-")}</td></tr>
              <tr><th>Receiver</th><td>${badge(diagnostics?.receiver_status || "-")}</td></tr>
              <tr><th>Active Speakers</th><td>${escapeHtml(diagnostics?.active_speakers ?? 0)}</td></tr>
              <tr><th>Audio Chunks</th><td>${escapeHtml(diagnostics?.audio_chunk_count ?? 0)}</td></tr>
              <tr><th>Audio Bytes</th><td>${escapeHtml(diagnostics?.audio_bytes ?? 0)}</td></tr>
              <tr><th>Last Audio</th><td>${escapeHtml(diagnostics?.last_audio_at || "-")}</td></tr>
              <tr><th>Last Transcript</th><td>${escapeHtml(diagnostics?.last_transcript_at || "-")}</td></tr>
              <tr><th>Last Error</th><td>${escapeHtml(diagnostics?.last_error || "-")}</td></tr>
            </table></div>
          </section>
          <section class="panel">
            <div class="panel-head"><div><h2>Transcripts</h2><p>VCから作成された文字起こしです。</p></div></div>
            ${transcripts.length ? `<div class="table-wrap"><table><thead><tr><th>Created</th><th>User</th><th>Duration ms</th><th>Text</th></tr></thead><tbody>${transcriptRows}</tbody></table></div>` : emptyState("まだ文字起こしはありません。")}
          </section>
        </section>
        <aside class="layout">
          <section class="panel">
            <div class="panel-head"><div><h2>main.md</h2><p>${escapeHtml(discordStatus)}</p></div></div>
            <div class="actions">
              <form method="post" action="/sessions/${encodeURIComponent(session.id)}/regenerate"><button>Regenerate</button></form>
            </div>
            <form method="post" action="/sessions/${encodeURIComponent(session.id)}/send-to-discord">
              <label>Discord channel ID<input name="channel_id" value="${escapeHtml(session.output_channel_id || config.discordOutputChannelId || session.text_channel_id || "")}"></label>
              <div class="actions"><button class="secondary">Send to Discord</button></div>
            </form>
          </section>
          <section class="panel">
            <div class="panel-head"><div><h2>Notes</h2><p>手動メモと文字起こし由来のメモです。</p></div></div>
            ${notes.length ? `<ul class="help-list">${noteList}</ul>` : emptyState("No notes")}
          </section>
        </aside>
      </div>`
    ));
  });

  app.get("/sessions/:id/main.md", async (req, res) => {
    const generated = await getGeneratedFile(req.params.id);
    if (!generated) {
      res.status(404).send("main.md is not generated.");
      return;
    }
    res.download(generated.file_path, "main.md");
  });

  app.post("/sessions/:id/regenerate", async (req, res) => {
    const session = await getSession(req.params.id);
    if (!session) {
      res.status(404).send("Session not found.");
      return;
    }
    const filePath = await generateMainMd(session);
    await insertGeneratedFile(session.id, filePath);
    res.redirect(`/sessions/${encodeURIComponent(session.id)}`);
  });

  app.post("/sessions/:id/send-to-discord", async (req, res) => {
    const session = await getSession(req.params.id);
    if (!session) {
      res.status(404).send("Session not found.");
      return;
    }
    let generated = await getGeneratedFile(session.id);
    if (!generated) {
      const filePath = await generateMainMd(session);
      generated = await insertGeneratedFile(session.id, filePath);
    }
    await fs.stat(generated.file_path);
    const channelId = String(req.body.channel_id || session.output_channel_id || config.discordOutputChannelId || session.text_channel_id || "");
    await sendMainMdToDiscord({ client: discordClient, session, generatedFile: generated, channelId });
    res.redirect(`/sessions/${encodeURIComponent(session.id)}`);
  });

  await new Promise<void>((resolve) => {
    app.listen(config.webPort, config.webHost, () => {
      console.log(`Web dashboard listening on http://${config.webHost}:${config.webPort}`);
      resolve();
    });
  });
}
