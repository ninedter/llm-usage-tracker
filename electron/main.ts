import {
  app,
  BrowserWindow,
  shell,
  Menu,
  nativeTheme,
  dialog,
} from "electron";
import { join } from "path";
import { createServer } from "net";
import { spawn, execFileSync, type ChildProcess } from "child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
  unlinkSync,
} from "fs";
import { randomBytes } from "crypto";
import { createTray } from "./tray";

const IS_DEV = process.env.NODE_ENV === "development";
const APP_NAME = "LLM Usage Tracker";

// The always-on Docker tracker (docker-compose publishes 3789). When it is
// healthy, the app attaches to it instead of running its own server, so there
// is exactly ONE database — the container's named volume. The embedded server
// (with its own userData DB) exists only as a fallback for when Docker is down.
const DOCKER_PORT = parseInt(process.env.DOCKER_MONITOR_PORT || "3789", 10);

type ServerMode = "docker" | "embedded" | "dev";

let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;
let serverPort = 3000;
let serverMode: ServerMode = "embedded";
let dockerFallbackTried = false;

/** Shared quitting state — exported so tray.ts can set it too */
export let isQuitting = false;
export function setQuitting(value: boolean): void {
  isQuitting = value;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Find a free TCP port */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("Could not get port")));
      }
    });
    srv.on("error", reject);
  });
}

/** Wait until the server responds on /api/health */
async function waitForServer(
  port: number,
  timeoutMs = 30_000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch {
      // server not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Server did not start within ${timeoutMs}ms`);
}

/** Ensure userData directory exists and return it */
function ensureDataDir(): string {
  const dir = app.getPath("userData");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** Well-known file the Claude Code hook reads to find the embedded server */
function portFilePath(): string {
  return join(ensureDataDir(), "server-port");
}

/** Is the Docker tracker up and serving? Short timeout — this gates startup. */
async function dockerServerHealthy(timeoutMs = 1500): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(`http://127.0.0.1:${DOCKER_PORT}/api/health`, {
      signal: ctl.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Locate a system Node.js binary for the embedded server.
 *
 * The server is spawned with SYSTEM node — never Electron's runtime
 * (utilityProcess) — so better-sqlite3 stays built for the system-node ABI
 * that vitest and `next dev` also use. One ABI everywhere ends the
 * rebuild-per-runtime dance that kept breaking either the app or the tests.
 */
function findSystemNode(): string | null {
  const candidates: string[] = [];
  try {
    const probe =
      process.platform === "win32"
        ? execFileSync("where", ["node"], { encoding: "utf8", timeout: 5000 })
        : execFileSync("/bin/zsh", ["-lc", "command -v node"], {
            encoding: "utf8",
            timeout: 5000,
          });
    const found = probe.split("\n")[0].trim();
    if (found) candidates.push(found);
  } catch {
    // no login-shell node; fall through to well-known paths
  }
  candidates.push("/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node");
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

/** Load or generate the encryption key in the userData directory */
function getOrCreateEncryptionKey(dataDir: string): string {
  const envFile = join(dataDir, ".env.local");

  // Check if key already in env
  if (process.env.ENCRYPTION_KEY) {
    return process.env.ENCRYPTION_KEY;
  }

  // Try reading from file
  if (existsSync(envFile)) {
    const content = readFileSync(envFile, "utf8");
    const match = content.match(/ENCRYPTION_KEY=([^\s]+)/);
    if (match) return match[1];
  }

  // Generate new key
  const key = randomBytes(32).toString("hex");
  const existing = existsSync(envFile)
    ? readFileSync(envFile, "utf8")
    : "";
  writeFileSync(envFile, existing + `\nENCRYPTION_KEY=${key}\n`);
  return key;
}

// ── Server ───────────────────────────────────────────────────────────────────

async function startServer(): Promise<number> {
  if (IS_DEV) {
    // In dev mode, assume `next dev` is already running
    const devPort = parseInt(process.env.ELECTRON_DEV_PORT || "3000", 10);
    return devPort;
  }

  const port = await getFreePort();
  const dataDir = ensureDataDir();
  const encryptionKey = getOrCreateEncryptionKey(dataDir);

  // The standalone server entry point
  // With asar disabled, files are directly in Resources/app/
  const appPath = app.getAppPath();
  const basePath = appPath;

  const serverPath = join(basePath, ".next", "standalone", "server.js");

  if (!existsSync(serverPath)) {
    throw new Error(
      `Standalone server not found at ${serverPath}. Run "npm run build" first.`
    );
  }

  // Ensure the native better-sqlite3 module is available in standalone node_modules
  // In packaged builds, the top-level node_modules is unpacked but standalone has its own
  const standaloneNativeModule = join(basePath, ".next", "standalone", "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
  const topLevelNativeModule = join(basePath, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
  if (!existsSync(standaloneNativeModule) && existsSync(topLevelNativeModule)) {
    const targetDir = join(basePath, ".next", "standalone", "node_modules", "better-sqlite3", "build", "Release");
    mkdirSync(targetDir, { recursive: true });
    copyFileSync(topLevelNativeModule, standaloneNativeModule);
    console.log("[main] Copied better-sqlite3 native module to standalone");
  }

  // Turbopack hashes external module names (e.g. better-sqlite3-90e2652d1716b047).
  // Create a wrapper module directory so the hashed name resolves to the real module.
  const standaloneModules = join(basePath, ".next", "standalone", "node_modules");
  const realSqlite = join(standaloneModules, "better-sqlite3");
  if (existsSync(realSqlite)) {
    try {
      const chunkDir = join(basePath, ".next", "standalone", ".next", "server", "chunks");
      if (existsSync(chunkDir)) {
        const chunkFiles = readdirSync(chunkDir).filter((f: string) => f.endsWith(".js"));
        for (const chunkFile of chunkFiles) {
          const content = readFileSync(join(chunkDir, chunkFile), "utf8");
          const match = content.match(/require\("(better-sqlite3-[a-f0-9]+)"\)/);
          if (match) {
            const hashedName = match[1];
            const wrapperDir = join(standaloneModules, hashedName);
            if (!existsSync(wrapperDir)) {
              mkdirSync(wrapperDir, { recursive: true });
              // Create a package.json that points to an index.js
              writeFileSync(join(wrapperDir, "package.json"), JSON.stringify({ name: hashedName, main: "index.js" }));
              // Create index.js that re-exports the real better-sqlite3
              writeFileSync(join(wrapperDir, "index.js"), `module.exports = require("better-sqlite3");`);
              console.log(`[main] Created wrapper module: ${hashedName} -> better-sqlite3`);
            }
            break;
          }
        }
      }
    } catch (err) {
      console.error("[main] Failed to create turbopack module wrapper:", err);
    }
  }

  const env = {
    ...process.env,
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    LLM_DATA_DIR: dataDir,
    ENCRYPTION_KEY: encryptionKey,
    NODE_ENV: "production" as const,
  };

  const nodeBin = findSystemNode();
  if (!nodeBin) {
    throw new Error(
      "No system Node.js found for the embedded server. Either start the Docker tracker (docker compose up -d) or install Node.js."
    );
  }
  console.log(`[main] Spawning embedded server with ${nodeBin}`);

  serverProcess = spawn(nodeBin, [serverPath], {
    env,
    cwd: join(basePath, ".next", "standalone"),
    stdio: ["ignore", "pipe", "pipe"],
  });

  serverProcess.stdout?.on("data", (data: Buffer) => {
    console.log(`[server] ${data.toString().trim()}`);
  });

  serverProcess.stderr?.on("data", (data: Buffer) => {
    console.error(`[server] ${data.toString().trim()}`);
  });

  serverProcess.on("exit", (code) => {
    console.log(`[server] exited with code ${code}`);
    serverProcess = null;
  });

  await waitForServer(port);
  return port;
}

function killServer(): void {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
}

// ── Window ───────────────────────────────────────────────────────────────────

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 600,
    title: APP_NAME,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#18181b" : "#ffffff",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);

  // If the Docker tracker goes away mid-session (container stopped), fall back
  // to the embedded server once instead of leaving a dead window. Fires on the
  // next navigation/reload against the unreachable origin.
  mainWindow.webContents.on(
    "did-fail-load",
    async (_event, errorCode, errorDescription, _url, isMainFrame) => {
      if (!isMainFrame || errorCode === -3 /* ERR_ABORTED: benign */) return;
      if (serverMode !== "docker" || dockerFallbackTried) return;
      dockerFallbackTried = true;
      console.warn(
        `[main] Docker tracker unreachable (${errorDescription}) — falling back to embedded server`
      );
      try {
        serverMode = "embedded";
        serverPort = await startServer();
        writeFileSync(portFilePath(), String(serverPort), "utf8");
        mainWindow?.loadURL(`http://127.0.0.1:${serverPort}`);
      } catch (err) {
        dialog.showErrorBox(
          `${APP_NAME} lost its server`,
          `The Docker tracker stopped and the embedded fallback failed:\n${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  );

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // macOS: hide instead of close (reopen from tray)
  mainWindow.on("close", (e) => {
    if (process.platform === "darwin" && !isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ── App lifecycle ────────────────────────────────────────────────────────────

// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.on("ready", async () => {
    // Set macOS dock menu
    if (process.platform === "darwin") {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: APP_NAME,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              {
                label: "Quit",
                accelerator: "CmdOrCtrl+Q",
                click: () => {
                  isQuitting = true;
                  app.quit();
                },
              },
            ],
          },
          {
            label: "Edit",
            submenu: [
              { role: "undo" },
              { role: "redo" },
              { type: "separator" },
              { role: "cut" },
              { role: "copy" },
              { role: "paste" },
              { role: "selectAll" },
            ],
          },
          {
            label: "View",
            submenu: [
              { role: "reload" },
              { role: "forceReload" },
              { role: "toggleDevTools" },
              { type: "separator" },
              { role: "resetZoom" },
              { role: "zoomIn" },
              { role: "zoomOut" },
              { type: "separator" },
              { role: "togglefullscreen" },
            ],
          },
          {
            label: "Window",
            submenu: [
              { role: "minimize" },
              { role: "zoom" },
              { type: "separator" },
              { role: "front" },
            ],
          },
        ])
      );
    }

    try {
      if (!IS_DEV && (await dockerServerHealthy())) {
        // Thin-client mode: attach to the always-on Docker tracker. One
        // server, one database (the container's named volume) — the Electron
        // and Docker instances can no longer diverge.
        serverMode = "docker";
        serverPort = DOCKER_PORT;
        // No embedded server → no port file, so the Claude Code hook posts
        // only to :3789 instead of double-posting into a second database.
        try {
          if (existsSync(portFilePath())) unlinkSync(portFilePath());
        } catch {
          // stale file is harmless — the hook port-scans before posting
        }
        console.log(
          `[main] Docker tracker healthy on :${DOCKER_PORT} — thin-client mode (canonical DB)`
        );
      } else {
        serverMode = IS_DEV ? "dev" : "embedded";
        serverPort = await startServer();
        console.log(`[main] ${serverMode} server running on port ${serverPort}`);

        // Write the port to a well-known file so hooks can discover it
        writeFileSync(portFilePath(), String(serverPort), "utf8");
        console.log(`[main] Port written to ${portFilePath()}`);
      }
    } catch (err) {
      console.error("[main] Failed to start server:", err);
      dialog.showErrorBox(
        `${APP_NAME} could not start`,
        `${err instanceof Error ? err.message : String(err)}`
      );
      app.quit();
      return;
    }

    createWindow();
    createTray(mainWindow!, APP_NAME);
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      isQuitting = true;
      app.quit();
    }
  });

  app.on("activate", () => {
    if (mainWindow) {
      mainWindow.show();
    } else {
      createWindow();
    }
  });

  app.on("before-quit", () => {
    isQuitting = true;
    killServer();
  });
}
