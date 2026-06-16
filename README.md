# MeetingBot

MeetingBot is a Raspberry Pi hosted Discord bot that joins a voice channel, records meeting audio, transcribes it, and generates a `main.md` spec that can be downloaded from the web dashboard or sent back to Discord.

The app is designed for AI hackathon planning sessions where spoken ideas need to become a structured implementation brief.

## Features

- Discord slash commands for meeting sessions
- Voice channel audio receive and continuous transcription until `/end-dev`
- OpenAI transcription with Japanese language hints
- Audio normalization through ffmpeg before transcription
- SQLite-backed sessions, notes, transcripts, generated files, and status diagnostics
- Web dashboard for sessions, settings, prompts, command help, and `main.md` downloads
- Web-editable `.env` settings for Discord, OpenAI, runtime, storage, and Raspberry Pi deploy values
- Guild command sync from the web dashboard
- Voice reconnect and recording resume support after bot restarts
- systemd service template for Raspberry Pi

## Requirements

- Raspberry Pi 5 recommended
- Node.js 22 LTS
- ffmpeg
- sqlite3
- Discord Bot Token
- OpenAI API Key

## Environment Variables

Copy `.env.example` to `.env` and fill in the secrets.

```env
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
DISCORD_OUTPUT_CHANNEL_ID=

OPENAI_API_KEY=
TRANSCRIBE_MODEL=gpt-4o-transcribe
TRANSCRIBE_LANGUAGE=ja
MIN_TRANSCRIBE_SECONDS=2
NORMALIZE_AUDIO=true
SUMMARY_MODEL=gpt-4.1-mini
MAIN_MD_MODEL=gpt-4.1

WEB_HOST=0.0.0.0
WEB_PORT=3000
WEB_ADMIN_PASSWORD=change_me

CHUNK_SECONDS=60
SUMMARY_EVERY_CHUNKS=5
REMINDER_EVERY_MINUTES=10
REMINDER_CHANNEL_MODE=start_channel
MAX_SESSION_MINUTES=180

DATA_DIR=./data
DELETE_AUDIO_AFTER_SESSION_END=true
KEEP_TRANSCRIPTS=true
KEEP_SUMMARIES=true

PI_HOST=miki1586.local
PI_USER=pi
PI_PORT=22
PI_APP_DIR=/opt/talk2main-pi
PI_SERVICE_NAME=talk2main
INITIALIZE_PI=false
```

## Local Setup

```bash
npm install
npm run build
npm start
```

The app uses the `sqlite3` CLI, so install sqlite3 locally if you want to run the dashboard on Windows or macOS.

## Deploy to Raspberry Pi

```bash
npm run deploy:pi
```

The deployment script expects SSH access to the Pi and installs/updates the app under `PI_APP_DIR`.

## Web Dashboard

Default URL:

```text
http://miki1586.local:3000
```

Dashboard pages:

- `/` - session dashboard
- `/settings` - admin settings, API keys, runtime settings, and prompts
- `/help` - command and setup guide
- `/latest/main.md` - latest generated spec download

The initial admin password is `WEB_ADMIN_PASSWORD`. Change it before exposing the dashboard to other users on the LAN.

## Discord Commands

| Command | Description |
|---|---|
| `/start-dev app:<name> output_channel:<channel>` | Start recording and transcription |
| `/end-dev` | Stop recording, generate `main.md`, and upload it to Discord |
| `/status-dev` | Show session and audio diagnostics |
| `/add-dev content:<text>` | Add a manual note |
| `/set-prompt content:<text>` | Update the `main.md` prompt |
| `/show-prompt` | Show the active `main.md` prompt |
| `/export-dev session_id:<id> channel:<channel>` | Re-upload a generated `main.md` |
| `/reset-dev` | Reset the active session |

## Audio And Transcription

MeetingBot receives Discord VC audio with `selfDeaf: false` and keeps transcription active until `/end-dev`.

Audio is chunked, saved as WAV, normalized with ffmpeg, and then sent to OpenAI. The default settings favor transcription quality:

- `TRANSCRIBE_MODEL=gpt-4o-transcribe`
- `TRANSCRIBE_LANGUAGE=ja`
- `MIN_TRANSCRIBE_SECONDS=2`
- `NORMALIZE_AUDIO=true`

If transcription is slow, reduce quality by switching to `gpt-4o-mini-transcribe`.

## Status Diagnostics

The session detail page shows:

- voice connection status
- recording status
- receiver status
- active speakers
- audio chunk count
- transcript count
- last audio timestamp
- last transcript timestamp
- last error

This is intended to make it clear whether a problem is caused by Discord voice connection, audio receive, transcription, SQLite, or delivery to Discord.

## Discord Permissions

The bot needs:

- View Channels
- Send Messages
- Attach Files
- Read Message History
- Connect
- Speak
- Use Voice Activity
- `applications.commands`

## Security Notes

- Never commit `.env`
- Keep `OPENAI_API_KEY` server-side
- Keep `DISCORD_TOKEN` server-side
- The dashboard is intended for LAN use
- Do not expose the dashboard directly to the internet without authentication and network hardening
- Generated `main.md`, audio, and transcripts can contain private meeting content

## License

MIT
