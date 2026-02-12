# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A bridge service that connects Feishu (Lark) Bot to the Claude Code Agent SDK. Users chat with Claude Code from Feishu (including mobile), with real-time streaming updates via interactive cards. Runs Claude in `bypassPermissions` mode since there's no terminal for interactive approval.

## Commands

```bash
npm run dev          # Development with tsx (hot reload)
npm run build        # TypeScript compile to dist/
npm start            # Run compiled output (dist/index.js)
```

No test framework is configured. No linter is configured.

## Architecture

The app is a TypeScript ESM project (`"type": "module"`, all imports use `.js` extensions). It connects to Feishu via WebSocket (long connection, no public IP needed) and calls Claude via the `@anthropic-ai/claude-agent-sdk`.

### Message Flow

```
Feishu WSClient → EventHandler (auth, parse, @mention filter) → MessageBridge → ClaudeExecutor → StreamProcessor → Feishu card updates
```

### Key Modules

- **`src/index.ts`** — Entrypoint. Creates Feishu WS client, fetches bot info for @mention detection, wires up the event dispatcher and bridge, handles graceful shutdown.
- **`src/config.ts`** — Loads all config from env vars (`.env` via dotenv). `Config` interface is the central type.
- **`src/feishu/event-handler.ts`** — Registers `im.message.receive_v1` on the Lark `EventDispatcher`. Handles auth checks, text/image parsing, @mention stripping, group chat filtering (only responds when @mentioned). Exports `IncomingMessage` type.
- **`src/bridge/message-bridge.ts`** — Core orchestrator. Routes commands (`/cd`, `/reset`, `/stop`, `/status`, `/send-file`, `/list-models`, `/set-model`, `/help`), manages running tasks per chat (one task at a time per `chatId`), executes Claude queries with streaming card updates, handles image input/output, enforces 30-minute timeout.
- **`src/claude/executor.ts`** — Wraps `query()` from the Agent SDK as an async generator yielding `SDKMessage`. Configures permissionMode, allowedTools, MCP settings, session resume.
- **`src/claude/stream-processor.ts`** — Transforms the raw SDK message stream into `CardState` objects for display. Tracks tool calls, response text, session ID, cost/duration. Also extracts image file paths from tool outputs.
- **`src/claude/session-manager.ts`** — In-memory sessions keyed by `chatId`. Each session has a working directory and Claude session ID. Sessions expire after 24 hours. Changing working directory resets the session.
- **`src/feishu/card-builder.ts`** — Builds Feishu interactive card JSON. Cards have color-coded headers (blue=thinking/running, green=complete, red=error), tool call lists, markdown response content, and stats (cost/duration). Content truncated at 50KB.
- **`src/feishu/message-sender.ts`** — Feishu API wrapper for sending/updating cards, uploading/downloading images, sending text, and sending files (txt, pdf, etc.).
- **`src/bridge/rate-limiter.ts`** — Throttles card updates to avoid Feishu API rate limits (default 1.5s interval). Keeps only the latest pending update.

### Session Isolation

Sessions are keyed by `chatId` (not `userId`), so each group chat and DM gets its own independent session, working directory, and conversation history.

## Important Constraints

### Security Model

The service runs Claude in **permission-controlled mode** with automatic approval. Claude can read, write, and execute commands, but this is controlled through the `CLAUDE_ALLOWED_TOOLS` configuration. This is necessary because there's no terminal for user confirmation in a chat bot context. Users control access via `AUTHORIZED_USER_IDS` and `CLAUDE_ALLOWED_TOOLS` env vars.

**Important**: The service should **not be run as root**. If running as root, the service uses `dontAsk` permission mode instead of `bypassPermissions` due to Claude Code CLI security restrictions.

### Group Chat Behavior

In group chats, the bot only responds when explicitly @mentioned. In direct messages, all messages are processed.

**Quote/Reply Support**: In group chats, users can:
1. Upload a file to the group (bot ignores it)
2. Quote/reply to that file message and @mention the bot with instructions
3. Bot downloads the quoted file and processes it along with the instruction

This allows natural workflows like:
- User A uploads `report.pdf` to group
- User B quotes the message, @mentions bot: "@bot please summarize this report"
- Bot downloads the quoted file and processes it

### Task Execution

- One task at a time per `chatId` (concurrent tasks across different chats are allowed)
- 30-minute timeout per task
- Tasks can be aborted with `/stop` command
- **Max Turns Handling**: When Claude reaches the max turn limit (default 150), the bot pauses and asks the user if they want to continue. User replies with "yes"/"y" or "no"/"n". If yes, execution continues with the same session.

### Image Support

- **Input:** Users can send images (PNG, JPEG, GIF, WEBP, BMP, SVG, TIFF) for Claude to analyze
- **Output:** Images generated by Claude (via Write, Bash, or MCP tools) are automatically uploaded to Feishu
- Max size: 10MB per image (Feishu limit)

### File Support

- **Input:** Users can send files (all types: txt, pdf, doc, xls, csv, json, zip, etc.) which are downloaded to the working directory
- **Output:** Files generated by Claude can be sent back to Feishu using `sendFileFromPath(chatId, filePath)`
- Supported formats: All file types (txt, pdf, doc, xls, mp4, opus, etc.)
- Max size: 30MB per file (Feishu limit)
- Required permission: `im:resource` (Read and upload images or other files)
- When users upload files, they are saved directly to the session's working directory with their original filename
- Claude can then read, edit, or process these files using standard tools (Read, Edit, Bash, etc.)

### Card Updates

- Content truncated at 50KB to fit Feishu card limits
- Updates throttled to 1.5s intervals to avoid rate limits
- Color-coded status: blue (thinking/running), green (complete), red (error)

### MCP Servers

MCP servers are loaded from Claude Code's standard config files:
- Global: `~/.claude/settings.json`
- Per-project: `<working-directory>/.claude/settings.json`

The bot loads MCP servers based on the working directory set via `/cd`.

### Model Management

Users can dynamically select which Claude model to use for their session:

**List available models:**
```
/list-models
```

Shows all available models with descriptions and marks the current model:
- claude-opus-4-6 (Most capable model)
- claude-sonnet-4-5 (Balanced performance, recommended)
- claude-haiku-3-5 (Fastest, good for simple tasks)
- Plus older versions (3.5 Sonnet, 3.5 Haiku, 3 Opus)

**Set model for current session:**
```
/set-model claude-haiku-3-5
```

Each chat session can use a different model. Model selection persists across messages within the same session.

**Reset to default:**
```
/set-model default
```

Model priority: Session model > Config model (`CLAUDE_MODEL` env var) > SDK default (claude-sonnet-4-5)

## Configuration

All config is via environment variables in `.env` (see `.env.example`). Required: `FEISHU_APP_ID`, `FEISHU_APP_SECRET`. The Feishu app must have bot capability, WebSocket event mode, and `im.message.receive_v1` event subscription.

## File Transfer

### Receiving Files from Users

When users upload files to the bot:

1. **Direct upload**: Files sent directly to the bot (DM or @mention with attachment)
2. **Quoted upload**: In group chats, users can upload a file, then quote/reply to it with @mention and instructions
3. **Automatic download**: Files are automatically downloaded to the session's working directory
4. **Preserves filename**: Original filename is preserved
5. **Ready for processing**: Claude can immediately use Read, Edit, or other tools on the downloaded file
6. **Notification**: Claude receives a message with file location and user instructions

Example workflows:

**Direct upload** (DM or group with @mention):
- User uploads `data.csv` and @mentions bot: "analyze this data"
- File is downloaded to `/path/to/working-directory/data.csv`
- Claude receives: `📎 analyze this data [data.csv]`

**Quoted upload** (group chat):
- User A uploads `report.pdf` to group (bot ignores)
- User B quotes the message and @mentions bot: "@bot summarize this"
- File is downloaded to `/path/to/working-directory/report.pdf`
- Claude receives: `🔗📎 @bot summarize this [report.pdf]`

### Sending Files to Users

When users request files (e.g., "send me the file", "can I download that?"), you can send files back to Feishu:

1. **Check file exists and size**: Files must exist and be under 30MB
2. **Use sendFileFromPath**: `await this.sender.sendFileFromPath(chatId, filePath)`
3. **Send confirmation**: Optionally send a text message confirming the file was sent

The `/send-file` command supports both files and folders:
- **Files**: Sent directly if under 30MB
- **Folders**: Automatically compressed to `.tar.gz` format. If compressed size exceeds 30MB, an error is raised.

Common scenarios:
- User asks for a generated report/document
- User wants to download a created file
- User requests a project folder or directory
- User requests a log file or configuration file

The file will be uploaded to Feishu and sent as a downloadable attachment in the chat.

## Troubleshooting

### "Claude Code process exited with code 1"

**Symptom**: Service fails to execute Claude queries with error:
```
Error: Claude Code process exited with code 1
```

**Root Cause**: Claude Code CLI has a security check that prevents using `--dangerously-skip-permissions` when running with root/sudo privileges.

**When This Happens**:
1. Service is running as root user
2. Environment variables are set in `.bashrc` but not in `.env`

**Solution 1: Run as Non-Root User (Recommended)**

The service should not be run as root. Create a dedicated user:

```bash
# Create service user
useradd -r -s /bin/bash -d /home/claudebot claudebot

# Transfer ownership
chown -R claudebot:claudebot /data0/pd/feishu-claudecode

# Run as that user
su - claudebot
cd /data0/pd/feishu-claudecode
npm run dev
```

**Solution 2: Fix Environment Variables**

Environment variables in `~/.bashrc` are **not** inherited by Node.js child processes. They must be in `.env`:

```bash
# In /data0/pd/feishu-claudecode/.env (not ~/.bashrc)
ANTHROPIC_AUTH_TOKEN=sk-your-token-here
ANTHROPIC_BASE_URL=https://api.anthropic.com
```

**Why `.bashrc` doesn't work**:
- `.bashrc` is only loaded for interactive shells (when you open a terminal)
- Node.js spawns the Claude CLI as a non-interactive child process
- Non-interactive processes don't load `.bashrc`
- The `.env` file is loaded by dotenv and inherited by all child processes

**Implementation Note**: When running as root, the service automatically falls back to `dontAsk` permission mode (in `src/claude/executor.ts`) instead of `bypassPermissions` to avoid the security check.
