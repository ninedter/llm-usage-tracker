# LLM Usage Tracker

A native macOS desktop application for monitoring AI usage quotas and tracking Claude Code agent activity in real-time.

![Electron](https://img.shields.io/badge/Electron-35-47848F?logo=electron&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-WAL-003B57?logo=sqlite&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![macOS](https://img.shields.io/badge/macOS-arm64-000000?logo=apple&logoColor=white)

## Features

### Usage Monitoring
- **Claude API quota tracking** — 5-hour and 7-day usage windows with progress bars
- **Per-model breakdown** — See usage split across Sonnet, Opus, Haiku, etc.
- **Auto-refresh** — Configurable polling interval for live quota updates
- **Encrypted credential storage** — API keys are stored securely with AES-256

### Agent Monitor
- **Real-time agent tracking** — See all Claude Code sessions and their agents as they work
- **3-tab interface** — Activity feed, Agents view, and Sessions view
- **Live status indicators** — Working (green pulse), Idle (amber), Completed, Failed
- **Subagent detection** — Automatically detects and displays spawned subagents with their types
- **Tool call timeline** — See what tools each agent is using in real-time
- **Session lifecycle** — Full tracking from session start to completion
- **Event history** — Searchable, filterable event log with color-coded types
- **Font size control** — Adjustable monitor text size (small/medium/large)
- **Clear data** — One-click reset of all monitor data

### Claude Code Hooks Integration
Automatically captures agent activity via Claude Code hooks — all 7 event types:
- `SessionStart` / `SessionEnd` — Session lifecycle
- `PreToolUse` / `PostToolUse` — Tool call tracking
- `Stop` — Agent idle detection
- `SubagentStop` — Subagent completion
- `Notification` — Context compaction and other notifications

### Desktop App
- **Native macOS app** — Packaged as `.dmg` for easy installation
- **System tray** — Quick access from the menu bar
- **Window management** — Hide to tray on close, restore on click
- **Single instance** — Prevents duplicate app windows
- **Dark theme** — Sleek dark UI throughout

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Electron Shell                     │
│  ┌───────────────────────────────────────────────┐  │
│  │           Next.js Standalone Server            │  │
│  │  ┌─────────┐  ┌──────────┐  ┌─────────────┐  │  │
│  │  │ API     │  │ SSE      │  │ React UI    │  │  │
│  │  │ Routes  │  │ Broadcast│  │ (Tailwind)  │  │  │
│  │  └────┬────┘  └────┬─────┘  └──────┬──────┘  │  │
│  │       │             │               │          │  │
│  │  ┌────┴─────────────┴───────────────┴──────┐  │  │
│  │  │              SQLite (WAL)                │  │  │
│  │  │  sessions │ agents │ events │ tokens     │  │  │
│  │  └─────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
         ▲
         │ HTTP POST (hook events)
         │
┌────────┴────────┐
│  Claude Code     │
│  Hook Script     │
│  (bash)          │
└─────────────────┘
```

## Getting Started

### Prerequisites
- **Node.js** 20+
- **npm** 9+
- **macOS** (arm64 or x64)

### Installation

```bash
# Clone the repository
git clone <repo-url>
cd llm-usage-tracker

# Install dependencies
npm install

# Rebuild native modules for Electron
npx electron-rebuild -f -w better-sqlite3
```

### Development

```bash
# Run in development mode (Next.js + Electron with hot reload)
npm run electron:dev

# Or build and preview
npm run electron:preview
```

### Building for Distribution

```bash
# Full build → compile → package as macOS .dmg
npm run electron:build
```

Output will be in `dist-electron/`:
- `LLM Usage Tracker-x.x.x-arm64.dmg` — macOS installer
- `LLM Usage Tracker-x.x.x-arm64-mac.zip` — Portable zip

### Setting Up Agent Monitoring

1. Start the LLM Usage Tracker app
2. Install the Claude Code hooks:

```bash
# Copy the hook script
cp hooks/agent-monitor-hook.sh ~/.local/bin/agent-monitor-hook.sh
chmod +x ~/.local/bin/agent-monitor-hook.sh
```

3. Register hooks in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/.local/bin/agent-monitor-hook.sh" }] }],
    "PostToolUse": [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/.local/bin/agent-monitor-hook.sh" }] }],
    "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/.local/bin/agent-monitor-hook.sh" }] }],
    "SubagentStop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/.local/bin/agent-monitor-hook.sh" }] }],
    "SessionStart": [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/.local/bin/agent-monitor-hook.sh" }] }],
    "SessionEnd": [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/.local/bin/agent-monitor-hook.sh" }] }],
    "Notification": [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/.local/bin/agent-monitor-hook.sh" }] }]
  }
}
```

4. The hook script automatically discovers the app's port — no manual configuration needed.

## Project Structure

```
llm-usage-tracker/
├── electron/               # Electron main process
│   ├── main.ts             # App lifecycle, server management
│   ├── tray.ts             # System tray
│   └── preload.ts          # Preload script
├── hooks/                  # Claude Code hook scripts
│   └── agent-monitor-hook.sh
├── src/
│   ├── app/                # Next.js App Router
│   │   ├── api/            # API routes
│   │   │   ├── monitor/    # Agent monitor endpoints
│   │   │   ├── credentials/
│   │   │   ├── usage/
│   │   │   └── organizations/
│   │   ├── page.tsx        # Main dashboard
│   │   ├── settings/       # Settings page
│   │   └── monitor/        # Monitor page
│   ├── components/
│   │   ├── dashboard/      # Usage cards, progress bars
│   │   ├── monitor/        # Agent cards, monitor panel
│   │   ├── settings/       # Credential forms
│   │   └── ui/             # Shared UI components
│   ├── hooks/              # React hooks
│   │   ├── use-agent-monitor.ts
│   │   ├── use-monitor-settings.ts
│   │   └── use-usage-data.ts
│   ├── lib/
│   │   ├── db.ts           # SQLite database layer
│   │   ├── ws.ts           # SSE broadcast
│   │   ├── credentials.ts  # Encrypted storage
│   │   └── providers/      # API clients
│   └── types/
│       └── index.ts        # TypeScript definitions
├── build/                  # App icons
├── public/                 # Static assets
└── package.json
```

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/monitor/stats` | GET | Dashboard statistics |
| `/api/monitor/agents` | GET | List all agents |
| `/api/monitor/agents` | POST | Register a new agent |
| `/api/monitor/agents/:id` | GET/PUT | Get/update agent |
| `/api/monitor/events` | POST | Ingest hook events |
| `/api/monitor/events/:agentId` | GET | Get agent events |
| `/api/monitor/sessions` | GET | List sessions |
| `/api/monitor/stream` | GET | SSE real-time updates |
| `/api/monitor/clear` | DELETE | Clear all data |
| `/api/credentials` | GET/POST | Manage API keys |
| `/api/usage/claude` | GET | Claude API usage |
| `/api/health` | GET | Health check |

## Tech Stack

- **Electron 35** — Desktop shell
- **Next.js 16** — Full-stack React framework (standalone output)
- **React 19** — UI library
- **Tailwind CSS 4** — Styling
- **SQLite** (better-sqlite3) — Local database with WAL mode
- **SWR** — Data fetching with caching
- **SSE** — Server-Sent Events for real-time updates
- **TypeScript 5** — Type safety throughout

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Next.js dev server |
| `npm run build` | Build Next.js (standalone) |
| `npm run electron:dev` | Dev mode with hot reload |
| `npm run electron:preview` | Build and launch Electron |
| `npm run electron:build` | Package as macOS .dmg |
| `npm run electron:compile` | Compile Electron TypeScript |
| `npm run electron:clean` | Clean build output |

## License

MIT
