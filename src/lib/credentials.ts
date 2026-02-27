import { readFileSync, writeFileSync, existsSync } from "fs";
import { randomBytes } from "crypto";
import { join } from "path";
import { encrypt, decrypt } from "./crypto";
import type { CredentialStore } from "@/types";

const DATA_DIR = process.env.LLM_DATA_DIR || process.cwd();
const CRED_FILE = join(DATA_DIR, "credentials.enc.json");
const ENV_FILE = join(DATA_DIR, ".env.local");

function getEncryptionKey(): string {
  let key = process.env.ENCRYPTION_KEY;
  if (key) return key;

  // Auto-generate on first run
  key = randomBytes(32).toString("hex");
  const envContent = existsSync(ENV_FILE)
    ? readFileSync(ENV_FILE, "utf8")
    : "";
  if (!envContent.includes("ENCRYPTION_KEY=")) {
    writeFileSync(ENV_FILE, envContent + `\nENCRYPTION_KEY=${key}\n`);
  }
  process.env.ENCRYPTION_KEY = key;
  return key;
}

export function getCredentials(): CredentialStore {
  if (!existsSync(CRED_FILE)) return {};

  try {
    const raw = readFileSync(CRED_FILE, "utf8");
    const decrypted = decrypt(raw, getEncryptionKey());
    return JSON.parse(decrypted);
  } catch {
    return {};
  }
}

export function saveCredentials(store: CredentialStore): void {
  const json = JSON.stringify(store);
  const encrypted = encrypt(json, getEncryptionKey());
  writeFileSync(CRED_FILE, encrypted);
}

export function deleteCredentials(provider: keyof CredentialStore): void {
  const store = getCredentials();
  delete store[provider];
  saveCredentials(store);
}

export function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return key.slice(0, 6) + "..." + key.slice(-4);
}
