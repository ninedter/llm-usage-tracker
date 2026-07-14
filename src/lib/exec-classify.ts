// Classify Codex `exec` shell commands as exploration or modification.
//
// Claude Code has distinct tools per intent (Read/Grep/Glob vs Edit/Write), so
// the explore-vs-modify insight is a simple tool_name bucket there. Codex runs
// one `exec` tool for everything, so the only honest signal is the command
// itself. We classify by the leading verb with a conservative wordlist —
// anything ambiguous (node, npm, python, docker …) counts as neither rather
// than polluting the ratio.

const EXPLORE_VERBS = new Set([
  "rg", "grep", "egrep", "fgrep", "cat", "ls", "find", "fd", "head", "tail",
  "tree", "wc", "stat", "du", "df", "file", "which", "whereis", "pwd", "ps",
  "env", "printenv", "less", "more", "diff", "cmp", "md5", "shasum", "sha256sum",
  "curl", "wget", "dig", "host", "nslookup", "lsof", "uname", "date", "id",
  "readlink", "basename", "dirname", "type", "man", "help", "jq", "column",
  "sort", "uniq", "cut", "awk", "strings", "hexdump", "xxd", "otool", "nm",
]);

const MODIFY_VERBS = new Set([
  "rm", "mv", "cp", "mkdir", "rmdir", "touch", "chmod", "chown", "chgrp",
  "ln", "tee", "truncate", "patch", "install", "rsync", "unzip", "tar",
  "gzip", "gunzip", "zip", "dd", "mkfifo", "mktemp",
]);

const GIT_EXPLORE = new Set([
  "status", "log", "diff", "show", "branch", "blame", "grep", "ls-files",
  "rev-parse", "rev-list", "describe", "remote", "shortlog", "reflog", "config",
]);

const GIT_MODIFY = new Set([
  "add", "commit", "push", "pull", "fetch", "checkout", "switch", "restore",
  "merge", "rebase", "reset", "stash", "apply", "cherry-pick", "revert",
  "clone", "init", "rm", "mv", "clean", "tag", "worktree",
]);

/**
 * Pull the shell command out of a Codex `custom_tool_call` exec input.
 *
 * The input is JS text like `const r = await tools.exec_command({"cmd":"rg -n
 * \"foo\" src"})`. Content may be truncated mid-string (we cap stored content),
 * so the closing quote is optional — classification only needs the head.
 */
export function extractExecCommand(input: string): string | null {
  const m = input.match(/"cmd"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (!m || !m[1]) return null;
  // Unescape via JSON; a truncated trailing backslash would break parsing.
  const raw = m[1].replace(/\\$/, "");
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

/**
 * "explore" | "modify" | null (= not classifiable) for one shell command.
 *
 * Handles `cd x && <cmd>` prefixes, absolute paths, sudo/env wrappers, and
 * git subcommands. `sed` is modify only with -i (in-place); otherwise it's a
 * stream read.
 */
export function classifyCommand(cmd: string): "explore" | "modify" | null {
  let s = cmd.trim();

  // Skip leading `cd <path> &&` / `;` segments — the intent is the command after.
  for (let i = 0; i < 3; i++) {
    const next = s.replace(/^cd\s+[^&|;]*(?:&&|;)\s*/, "");
    if (next === s) break;
    s = next;
  }

  const tokens = s.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  // Unwrap sudo / env-var prefixes (FOO=bar cmd …)
  let idx = 0;
  while (idx < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx]) || tokens[idx] === "sudo")) {
    idx++;
  }
  if (idx >= tokens.length) return null;

  const verb = tokens[idx].replace(/^\S*\//, ""); // basename for /usr/bin/rg

  if (verb === "git") {
    const sub = tokens.slice(idx + 1).find((t) => !t.startsWith("-"));
    if (sub && GIT_EXPLORE.has(sub)) return "explore";
    if (sub && GIT_MODIFY.has(sub)) return "modify";
    return null;
  }

  if (verb === "sed") {
    return tokens.slice(idx + 1).some((t) => t === "-i" || t.startsWith("-i")) ? "modify" : "explore";
  }

  if (EXPLORE_VERBS.has(verb)) return "explore";
  if (MODIFY_VERBS.has(verb)) return "modify";
  return null;
}
