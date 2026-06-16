import { initDb } from "./db.js";
import { startDiscordBot } from "./discord-bot.js";
import { startWebServer } from "./web.js";

async function main(): Promise<void> {
  await initDb();
  await startWebServer();
  await startDiscordBot();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
