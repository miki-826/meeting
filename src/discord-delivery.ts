import fs from "node:fs/promises";
import { AttachmentBuilder, Client, PermissionFlagsBits, type Message } from "discord.js";
import { dashboardUrl } from "./config.js";
import { markGeneratedFileSent, type GeneratedFileRecord, type SessionRecord } from "./db.js";

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export type DiscordSendResult = {
  ok: boolean;
  attached: boolean;
  channelId?: string;
  messageId?: string;
  error?: string;
};

function completionContent(session: SessionRecord, url: string): string {
  const lines = [
    "main.md を生成しました。",
    "添付ファイルから確認できます。",
    "",
    session.app_name ? `アプリ名: ${session.app_name}` : "",
    "ファイル: main.md",
    "",
    `Web管理画面: ${url}`
  ].filter(Boolean);
  return lines.join("\n");
}

function fallbackContent(session: SessionRecord, url: string, reason?: string): string {
  const suffix = reason ? `\n\n理由: ${reason}` : "";
  return [
    "main.md は生成されましたが、Discordへの添付送信に失敗しました。",
    "Web管理画面からダウンロードしてください。",
    "",
    `Web管理画面: ${url}${suffix}`
  ].join("\n");
}

async function resolveTextChannel(client: Client, channelId: string) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !("send" in channel)) return null;
  return channel;
}

function missingPermissionReason(channel: unknown, client: Client): string | null {
  if (!client.user) return "Bot user is not ready.";
  const candidate = channel as {
    permissionsFor?: (user: typeof client.user) => { has: (flag: bigint) => boolean } | null;
  };
  const permissions = candidate.permissionsFor?.(client.user);
  if (!permissions) return null;
  const checks = [
    [PermissionFlagsBits.ViewChannel, "View Channel"],
    [PermissionFlagsBits.SendMessages, "Send Messages"],
    [PermissionFlagsBits.AttachFiles, "Attach Files"]
  ] as const;
  const missing = checks.filter(([flag]) => !permissions.has(flag)).map(([, label]) => label);
  return missing.length ? `Missing permissions: ${missing.join(", ")}` : null;
}

async function sendWithRetry(send: () => Promise<Message>, attempts = 3): Promise<Message> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await send();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function sendMainMdToDiscord(input: {
  client: Client;
  session: SessionRecord;
  generatedFile: GeneratedFileRecord;
  channelId: string;
  fallbackChannelId?: string;
}): Promise<DiscordSendResult> {
  const url = dashboardUrl(input.session.id);
  const stat = await fs.stat(input.generatedFile.file_path).catch(() => null);
  if (!stat) {
    return { ok: false, attached: false, error: "main.md file does not exist." };
  }

  const primary = await resolveTextChannel(input.client, input.channelId);
  const channel = primary ?? (input.fallbackChannelId ? await resolveTextChannel(input.client, input.fallbackChannelId) : null);
  if (!channel) {
    return { ok: false, attached: false, error: "Discord output channel was not found." };
  }

  if (stat.size > MAX_ATTACHMENT_BYTES) {
    const message = await sendWithRetry(() => channel.send(fallbackContent(input.session, url, "main.md is larger than 10MB.")));
    return { ok: false, attached: false, channelId: message.channelId, messageId: message.id, error: "main.md is larger than 10MB." };
  }

  const permissionReason = missingPermissionReason(channel, input.client);
  if (permissionReason) {
    const message = await sendWithRetry(() => channel.send(fallbackContent(input.session, url, permissionReason)));
    return { ok: false, attached: false, channelId: message.channelId, messageId: message.id, error: permissionReason };
  }

  try {
    const attachment = new AttachmentBuilder(input.generatedFile.file_path, { name: "main.md" });
    const message = await sendWithRetry(() =>
      channel.send({
        content: completionContent(input.session, url),
        files: [attachment]
      })
    );
    await markGeneratedFileSent(input.generatedFile.id, message.channelId, message.id);
    return { ok: true, attached: true, channelId: message.channelId, messageId: message.id };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const fallbackMessage = await channel.send(fallbackContent(input.session, url, reason)).catch(() => null);
    return {
      ok: false,
      attached: false,
      channelId: fallbackMessage?.channelId,
      messageId: fallbackMessage?.id,
      error: reason
    };
  }
}
