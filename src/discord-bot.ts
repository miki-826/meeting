import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember
} from "discord.js";
import { entersState, getVoiceConnection, joinVoiceChannel, VoiceConnectionStatus, type VoiceConnection } from "@discordjs/voice";
import { config } from "./config.js";
import {
  addNote,
  createSession,
  getActiveSession,
  getGeneratedFile,
  getLatestGeneratedFile,
  getLatestSession,
  getSessionDiagnostics,
  getSession,
  insertGeneratedFile,
  listRecordingSessions,
  setSetting,
  getSetting,
  upsertSessionDiagnostics,
  updateReminderTimestamps,
  updateSessionStatus,
  type SessionRecord
} from "./db.js";
import { generateMainMd } from "./main-md.js";
import { sendMainMdToDiscord } from "./discord-delivery.js";
import { startVoiceCapture, stopVoiceCapture } from "./voice-recorder.js";

const reminderTimers = new Map<string, NodeJS.Timeout>();
const voiceConnections = new Map<string, VoiceConnection>();

export const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

function commandDefinitions() {
  return [
    new SlashCommandBuilder()
      .setName("start-dev")
      .setDescription("Start recording and transcription")
      .addStringOption((option) => option.setName("app").setDescription("Application name").setRequired(false))
      .addChannelOption((option) =>
        option
          .setName("output_channel")
          .setDescription("Channel to receive main.md")
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(false)
      ),
    new SlashCommandBuilder().setName("end-dev").setDescription("Stop session, generate main.md, and send it to Discord"),
    new SlashCommandBuilder()
      .setName("export-dev")
      .setDescription("Re-upload a generated main.md")
      .addStringOption((option) => option.setName("session_id").setDescription("Session ID").setRequired(false))
      .addChannelOption((option) =>
        option.setName("channel").setDescription("Destination channel").addChannelTypes(ChannelType.GuildText).setRequired(false)
      ),
    new SlashCommandBuilder().setName("status-dev").setDescription("Show active MeetingBot session status"),
    new SlashCommandBuilder()
      .setName("add-dev")
      .setDescription("Add a manual note to the active session")
      .addStringOption((option) => option.setName("content").setDescription("Note content").setRequired(true)),
    new SlashCommandBuilder()
      .setName("set-prompt")
      .setDescription("Update the active main.md prompt")
      .addStringOption((option) => option.setName("content").setDescription("Prompt text").setRequired(true)),
    new SlashCommandBuilder().setName("show-prompt").setDescription("Show the active main.md prompt"),
    new SlashCommandBuilder().setName("reset-dev").setDescription("Reset the active session")
  ].map((command) => command.toJSON());
}

export async function syncDiscordCommands(): Promise<string[]> {
  if (!config.discordToken) {
    console.warn("DISCORD_TOKEN is missing. Slash commands were not registered.");
    return ["DISCORD_TOKEN is missing."];
  }
  const applicationId = config.discordClientId || discordClient.application?.id || discordClient.user?.id;
  if (!applicationId) {
    console.warn("Discord application ID is missing. Slash commands were not registered.");
    return ["Discord application ID is missing. Start the bot or set DISCORD_CLIENT_ID."];
  }
  const rest = new REST({ version: "10" }).setToken(config.discordToken);
  const commands = commandDefinitions();
  const results: string[] = [];

  if (config.discordGuildId) {
    await rest.put(Routes.applicationGuildCommands(applicationId, config.discordGuildId), { body: commands });
    const message = `Registered slash commands for guild ${config.discordGuildId}.`;
    console.log(message);
    return [message];
  }

  const guildIds = [...discordClient.guilds.cache.keys()];
  if (guildIds.length === 0) {
    await rest.put(Routes.applicationCommands(applicationId), { body: commands });
    const message = "Registered global slash commands. Global commands may take time to appear.";
    console.log(message);
    return [message];
  }

  for (const guildId of guildIds) {
    await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body: commands });
    const message = `Registered slash commands for guild ${guildId}.`;
    console.log(message);
    results.push(message);
  }
  return results;
}

async function registerCommands(): Promise<void> {
  if (!config.discordToken) {
    console.warn("DISCORD_TOKEN is missing. Slash commands were not registered.");
    return;
  }
  await syncDiscordCommands();
}

function resolveOutputChannelId(session: SessionRecord): string | null {
  return session.output_channel_id || config.discordOutputChannelId || session.text_channel_id;
}

function scheduleReminder(session: SessionRecord): void {
  if (reminderTimers.has(session.id)) return;
  const timer = setInterval(async () => {
    const channelId = session.reminder_channel_id;
    if (!channelId) return;
    const channel = await discordClient.channels.fetch(channelId).catch(() => null);
    if (channel?.isTextBased() && "send" in channel) {
      await channel.send("現在、文字起こしを継続中です。\n終了する場合は /end-dev を入力してください。").catch(console.error);
      await updateReminderTimestamps(session.id).catch(console.error);
    }
  }, config.reminderEveryMinutes * 60_000);
  reminderTimers.set(session.id, timer);
}

function clearReminder(sessionId: string): void {
  const timer = reminderTimers.get(sessionId);
  if (timer) clearInterval(timer);
  reminderTimers.delete(sessionId);
}

function monitorVoiceConnection(input: {
  connection: VoiceConnection;
  session: SessionRecord;
  guildId: string;
  channelId: string;
  adapterCreator: Parameters<typeof joinVoiceChannel>[0]["adapterCreator"];
}): void {
  let reconnecting = false;

  input.connection.on("error", (error) => {
    upsertSessionDiagnostics(input.session.id, {
      last_error: `voice connection error: ${error.message}`,
      voice_connection_status: input.connection.state.status
    }).catch(console.error);
  });

  input.connection.on("stateChange", async (_oldState, newState) => {
    if (newState.status !== VoiceConnectionStatus.Disconnected || reconnecting) return;
    reconnecting = true;
    await upsertSessionDiagnostics(input.session.id, {
      voice_connection_status: "disconnected",
      last_error: "voice disconnected; reconnecting"
    }).catch(console.error);

    try {
      await entersState(input.connection, VoiceConnectionStatus.Ready, 20_000);
      await upsertSessionDiagnostics(input.session.id, {
        voice_connection_status: "ready",
        last_error: null
      }).catch(console.error);
    } catch (error) {
      const active = await getActiveSession(input.guildId).catch(() => null);
      if (!active || active.id !== input.session.id || active.status !== "recording") return;

      try {
        input.connection.destroy();
      } catch {
        // The connection may already be destroyed during Discord voice recovery.
      }

      const replacement = joinVoiceChannel({
        channelId: input.channelId,
        guildId: input.guildId,
        adapterCreator: input.adapterCreator,
        selfDeaf: false,
        selfMute: true
      });
      voiceConnections.set(input.guildId, replacement);
      monitorVoiceConnection({ ...input, connection: replacement });
      await startVoiceCapture(replacement, input.session);

      const message = error instanceof Error ? error.message : String(error);
      await upsertSessionDiagnostics(input.session.id, {
        voice_connection_status: replacement.state.status,
        last_error: `voice rejoined after disconnect: ${message}`
      }).catch(console.error);
    } finally {
      reconnecting = false;
    }
  });
}

async function resumeRecordingSessions(): Promise<void> {
  const sessions = await listRecordingSessions();
  for (const session of sessions) {
    if (!session.guild_id || !session.voice_channel_id || voiceConnections.has(session.guild_id)) continue;
    const guild = await discordClient.guilds.fetch(session.guild_id).catch(() => null);
    if (!guild) continue;
    const channel = await guild.channels.fetch(session.voice_channel_id).catch(() => null);
    if (channel?.type !== ChannelType.GuildVoice && channel?.type !== ChannelType.GuildStageVoice) {
      await upsertSessionDiagnostics(session.id, {
        voice_connection_status: "not_joined",
        recording_status: "recording",
        last_error: "resume failed: saved voice channel was not found"
      }).catch(console.error);
      continue;
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: session.guild_id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true
    });
    voiceConnections.set(session.guild_id, connection);
    monitorVoiceConnection({
      connection,
      session,
      guildId: session.guild_id,
      channelId: channel.id,
      adapterCreator: channel.guild.voiceAdapterCreator
    });
    await startVoiceCapture(connection, session);
    scheduleReminder(session);
    await addNote(session.id, "Recorder resumed after bot restart.");
  }
}

async function handleStart(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId || !interaction.channelId) {
    await interaction.reply({ content: "サーバー内のテキストチャンネルで実行してください。", ephemeral: true });
    return;
  }
  const active = await getActiveSession(interaction.guildId);
  if (active) {
    await interaction.reply({ content: `すでにセッションが進行中です: ${active.id}`, ephemeral: true });
    return;
  }
  const member = interaction.member as GuildMember | null;
  const voiceChannel = member?.voice.channel;
  if (!voiceChannel) {
    await interaction.reply({ content: "先にDiscord VCへ参加してから /start-dev を実行してください。", ephemeral: true });
    return;
  }

  const outputChannel = interaction.options.getChannel("output_channel", false);
  const outputChannelId = outputChannel?.type === ChannelType.GuildText ? outputChannel.id : null;
  const reminderChannelId = config.reminderChannelMode === "output_channel" ? outputChannelId || interaction.channelId : interaction.channelId;
  const appName = interaction.options.getString("app", false);

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: interaction.guildId,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true
  });
  voiceConnections.set(interaction.guildId, connection);

  const session = await createSession({
    guildId: interaction.guildId,
    textChannelId: interaction.channelId,
    voiceChannelId: voiceChannel.id,
    outputChannelId,
    reminderChannelId,
    appName
  });
  await addNote(session.id, `Session started in voice channel ${voiceChannel.name}.`);
  monitorVoiceConnection({
    connection,
    session,
    guildId: interaction.guildId,
    channelId: voiceChannel.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator
  });
  await startVoiceCapture(connection, session);
  scheduleReminder(session);

  const destinationText = outputChannelId ? `<#${outputChannelId}>` : "このチャンネル";
  await interaction.reply(
    [
      "録音と文字起こしを開始しました。",
      "このVCの会話は main.md 生成のために処理されます。",
      "",
      "終了する場合は /end-dev を入力してください。",
      `生成された main.md は ${destinationText} に送信されます。`,
      "",
      `Session ID: ${session.id}`
    ].join("\n")
  );
}

async function handleEnd(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "サーバー内で実行してください。", ephemeral: true });
    return;
  }
  const session = await getActiveSession(interaction.guildId);
  if (!session) {
    await interaction.reply({ content: "進行中のセッションがありません。", ephemeral: true });
    return;
  }

  await interaction.reply("録音と文字起こしを終了します。\n未処理の音声チャンクを処理し、main.md を生成します。");
  await updateSessionStatus(session.id, "processing");
  clearReminder(session.id);
  await stopVoiceCapture(session.id);
  voiceConnections.get(interaction.guildId)?.destroy();
  getVoiceConnection(interaction.guildId)?.destroy();

  const refreshed = (await getSession(session.id)) ?? session;
  const filePath = await generateMainMd(refreshed);
  const generatedFile = await insertGeneratedFile(session.id, filePath);
  const channelId = resolveOutputChannelId(session) ?? interaction.channelId;
  const sendResult = await sendMainMdToDiscord({
    client: discordClient,
    session,
    generatedFile,
    channelId,
    fallbackChannelId: interaction.channelId
  });
  await updateSessionStatus(session.id, "completed");

  if (sendResult.ok) {
    await interaction.followUp("main.md を生成しました。\n添付ファイルから確認できます。");
  } else {
    await interaction.followUp(
      [
        "main.md は生成されましたが、Discordへの添付送信に失敗しました。",
        "Web管理画面からダウンロードしてください。",
        sendResult.error ? `理由: ${sendResult.error}` : ""
      ].filter(Boolean).join("\n")
    );
  }
}

async function handleExport(interaction: ChatInputCommandInteraction): Promise<void> {
  const explicitSessionId = interaction.options.getString("session_id", false);
  const channel = interaction.options.getChannel("channel", false);
  const generatedFile = explicitSessionId ? await getGeneratedFile(explicitSessionId) : await getLatestGeneratedFile();
  if (!generatedFile) {
    await interaction.reply({ content: "main.md がまだ生成されていません。\n先に /end-dev を実行してください。", ephemeral: true });
    return;
  }
  const session = await getSession(generatedFile.session_id);
  if (!session) {
    await interaction.reply({ content: "対象セッションが見つかりません。", ephemeral: true });
    return;
  }
  const channelId = channel?.type === ChannelType.GuildText ? channel.id : interaction.channelId;
  const result = await sendMainMdToDiscord({
    client: discordClient,
    session,
    generatedFile,
    channelId,
    fallbackChannelId: interaction.channelId
  });
  await interaction.reply(result.ok ? "main.md を再送信しました。" : `main.md の再送信に失敗しました。\n${result.error ?? ""}`);
}

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = interaction.guildId ? await getActiveSession(interaction.guildId) : await getLatestSession();
  if (!session) {
    await interaction.reply({ content: "進行中のセッションはありません。", ephemeral: true });
    return;
  }
  const diagnostics = await getSessionDiagnostics(session.id);
  await interaction.reply(
    [
      `Status: ${session.status}`,
      `Session ID: ${session.id}`,
      `App: ${session.app_name || "-"}`,
      `Output Channel: ${session.output_channel_id ? `<#${session.output_channel_id}>` : "default"}`,
      `Voice Connection: ${diagnostics?.voice_connection_status || "-"}`,
      `Recording: ${diagnostics?.recording_status || "-"}`,
      `Receiver: ${diagnostics?.receiver_status || "-"}`,
      `Active Speakers: ${diagnostics?.active_speakers ?? 0}`,
      `Audio Chunks: ${diagnostics?.audio_chunk_count ?? 0}`,
      `Transcripts: ${diagnostics?.transcript_count ?? 0}`,
      `Last Audio: ${diagnostics?.last_audio_at || "-"}`,
      `Last Transcript: ${diagnostics?.last_transcript_at || "-"}`,
      `Last Error: ${diagnostics?.last_error || "-"}`
    ].join("\n")
  );
}

async function handleAdd(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "サーバー内で実行してください。", ephemeral: true });
    return;
  }
  const session = await getActiveSession(interaction.guildId);
  if (!session) {
    await interaction.reply({ content: "進行中のセッションがありません。", ephemeral: true });
    return;
  }
  await addNote(session.id, interaction.options.getString("content", true));
  await interaction.reply({ content: "メモを追加しました。", ephemeral: true });
}

async function handlePrompt(interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.commandName === "set-prompt") {
    await setSetting("main_prompt", interaction.options.getString("content", true));
    await interaction.reply({ content: "プロンプトを更新しました。", ephemeral: true });
    return;
  }
  const prompt = await getSetting("main_prompt");
  await interaction.reply({ content: prompt || "プロンプトは未設定です。", ephemeral: true });
}

async function handleReset(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "サーバー内で実行してください。", ephemeral: true });
    return;
  }
  const session = await getActiveSession(interaction.guildId);
  if (!session) {
    await interaction.reply({ content: "進行中のセッションはありません。", ephemeral: true });
    return;
  }
  clearReminder(session.id);
  await stopVoiceCapture(session.id);
  voiceConnections.get(interaction.guildId)?.destroy();
  getVoiceConnection(interaction.guildId)?.destroy();
  await updateSessionStatus(session.id, "reset");
  await interaction.reply("現在のセッションをリセットしました。");
}

export async function startDiscordBot(): Promise<void> {
  discordClient.once(Events.ClientReady, (client) => {
    console.log(`Discord bot logged in as ${client.user.tag}.`);
    registerCommands().catch(console.error);
    resumeRecordingSessions().catch(console.error);
  });
  discordClient.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      if (interaction.commandName === "start-dev") await handleStart(interaction);
      if (interaction.commandName === "end-dev") await handleEnd(interaction);
      if (interaction.commandName === "export-dev") await handleExport(interaction);
      if (interaction.commandName === "status-dev") await handleStatus(interaction);
      if (interaction.commandName === "add-dev") await handleAdd(interaction);
      if (interaction.commandName === "set-prompt" || interaction.commandName === "show-prompt") await handlePrompt(interaction);
      if (interaction.commandName === "reset-dev") await handleReset(interaction);
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : String(error);
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: `エラーが発生しました: ${message}`, ephemeral: true }).catch(console.error);
      } else {
        await interaction.reply({ content: `エラーが発生しました: ${message}`, ephemeral: true }).catch(console.error);
      }
    }
  });

  if (!config.discordToken) {
    console.warn("DISCORD_TOKEN is missing. Discord bot will not start.");
    return;
  }
  await discordClient.login(config.discordToken);
}
