/**
 * Injected into the embedded Next.js server via `node --require` (see
 * startServer in main.ts). The embedded server must never outlive Electron:
 * an orphaned server keeps the stale port file plausible, and once its
 * stdio peers are gone every log write EPIPEs — Next's keep-alive
 * uncaughtException handler then console.errors the EPIPE, which EPIPEs
 * again, wedging the process in a 100%-CPU exception storm that accepts
 * TCP but never answers HTTP (observed 2026-07-14, PID 29032).
 *
 * stdin is a pipe from Electron (main.ts spawns with stdio[0]="pipe"):
 * EOF or error means the parent is gone — this works even when Electron is
 * SIGKILLed (the documented pkill -9 restart step) and can run no cleanup.
 */
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));

// Belt-and-braces: if the stdin signal is ever lost, notice the reparenting
// to init/launchd. Only Electron injects this file, so PPID 1 is never a
// legitimate steady state (unlike in Docker, which doesn't load this).
const ppidPoll = setInterval(() => {
  if (process.ppid === 1) process.exit(0);
}, 5000);
ppidPoll.unref();

// Even while the parent lives (or in the window before exit): logging must
// never take the server down or wedge it. Swallow stream errors so an EPIPE
// can't become an uncaughtException.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

export {};
