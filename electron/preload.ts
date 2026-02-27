// Minimal preload script for security.
// contextIsolation is enabled and nodeIntegration is disabled.
// The renderer communicates with the Next.js server via HTTP — no IPC bridge needed.

import { contextBridge } from "electron";

// Expose a minimal API to the renderer if needed in the future
contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
});
