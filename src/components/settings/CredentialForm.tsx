"use client";

import { useState } from "react";
import type { CredentialStore, ProviderId } from "@/types";
import { PROVIDER_INFO } from "@/lib/constants";

interface CredentialFormProps {
  provider: ProviderId;
  onSave: (creds: CredentialStore) => Promise<void>;
  onDelete: (provider: ProviderId) => Promise<void>;
  existingMasked?: Record<string, string | undefined>;
}

const FIELD_CONFIG: Partial<
  Record<
    ProviderId,
    Array<{
      key: string;
      label: string;
      placeholder: string;
      help: string;
      type?: string;
    }>
  >
> = {
  claude: [
    {
      key: "sessionKey",
      label: "Session Key",
      placeholder: "sk-ant-sid02-...",
      help: 'From claude.ai browser cookies. Open DevTools > Application > Cookies > "sessionKey". The Organization ID will be fetched automatically.',
    },
  ],
};

export function CredentialForm({
  provider,
  onSave,
  onDelete,
  existingMasked,
}: CredentialFormProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [orgFetching, setOrgFetching] = useState(false);
  const [message, setMessage] = useState<{
    type: "success" | "error" | "info";
    text: string;
  } | null>(null);

  const info = PROVIDER_INFO[provider];
  const fields = FIELD_CONFIG[provider] ?? [];
  const hasExisting =
    existingMasked && Object.values(existingMasked).some(Boolean);

  async function handleSave() {
    setSaving(true);
    setMessage(null);

    try {
      let credsToSave: Record<string, string> = { ...values };

      // For Claude: auto-fetch organization ID from session key
      if (provider === "claude" && values.sessionKey?.trim()) {
        setOrgFetching(true);
        setMessage({ type: "info", text: "Fetching Organization ID..." });

        const res = await fetch("/api/organizations/claude", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionKey: values.sessionKey.trim() }),
        });
        const json = await res.json();

        if (!json.success) {
          throw new Error(json.error?.message ?? "Failed to fetch organizations");
        }

        const orgs = json.data as Array<{ uuid: string; name: string }>;
        // Use the first organization (most users have one)
        credsToSave = {
          sessionKey: values.sessionKey.trim(),
          organizationId: orgs[0].uuid,
        };

        setOrgFetching(false);
        setMessage({
          type: "info",
          text: `Found organization: ${orgs[0].name}. Saving...`,
        });
      }

      const creds: CredentialStore = {
        [provider]: credsToSave,
      };
      await onSave(creds);
      setMessage({ type: "success", text: provider === "claude"
        ? `Credentials saved. Organization: ${credsToSave.organizationId}`
        : "Credentials saved."
      });
      setValues({});
    } catch (e) {
      setOrgFetching(false);
      setMessage({
        type: "error",
        text: e instanceof Error ? e.message : "Failed to save",
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setSaving(true);
    setMessage(null);
    try {
      await onDelete(provider);
      setMessage({ type: "success", text: "Credentials removed." });
    } catch (e) {
      setMessage({
        type: "error",
        text: e instanceof Error ? e.message : "Failed to delete",
      });
    } finally {
      setSaving(false);
    }
  }

  const isWorking = saving || orgFetching;

  return (
    <div className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <div className="h-1" style={{ backgroundColor: info.color }} />
      <div className="p-5">
        <h3 className="mb-4 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          {info.displayName}
        </h3>

        <div className="space-y-4">
          {fields.map((field) => (
            <div key={field.key}>
              <label className="mb-1 block text-xs font-medium text-zinc-700 dark:text-zinc-300">
                {field.label}
                {existingMasked?.[field.key] && (
                  <span className="ml-2 text-zinc-400">
                    (current: {existingMasked[field.key]})
                  </span>
                )}
              </label>
              <input
                type={field.type || "password"}
                placeholder={field.placeholder}
                value={values[field.key] || ""}
                onChange={(e) =>
                  setValues({ ...values, [field.key]: e.target.value })
                }
                className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-zinc-400 focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder-zinc-500 dark:focus:border-zinc-500 dark:focus:ring-zinc-500"
              />
              <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
                {field.help}
              </p>
            </div>
          ))}

          {/* Show existing org ID for Claude */}
          {provider === "claude" && existingMasked?.organizationId && (
            <div className="rounded-lg border border-zinc-100 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-800/50">
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Organization ID (auto-detected)
              </p>
              <p className="mt-0.5 text-sm font-mono text-zinc-700 dark:text-zinc-300">
                {existingMasked.organizationId}
              </p>
            </div>
          )}
        </div>

        {message && (
          <div
            className={`mt-4 rounded-lg p-2 text-xs ${
              message.type === "success"
                ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400"
                : message.type === "info"
                  ? "bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400"
                  : "bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400"
            }`}
          >
            {message.text}
          </div>
        )}

        <div className="mt-4 flex gap-2">
          <button
            onClick={handleSave}
            disabled={
              isWorking || !Object.values(values).some((v) => v.trim())
            }
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {orgFetching
              ? "Fetching org..."
              : saving
                ? "Saving..."
                : "Save"}
          </button>
          {hasExisting && (
            <button
              onClick={handleDelete}
              disabled={isWorking}
              className="rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-900/50 dark:text-red-400 dark:hover:bg-red-900/20"
            >
              Remove
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
