"use client";

import useSWR, { mutate } from "swr";
import type { ApiResponse, CredentialStore } from "@/types";

type MaskedStore = {
  claude?: { sessionKey?: string; organizationId?: string };
};

async function fetcher(url: string): Promise<MaskedStore> {
  const res = await fetch(url);
  const json: ApiResponse<MaskedStore> = await res.json();
  if (!json.success) throw new Error(json.error?.message ?? "Fetch failed");
  return json.data as MaskedStore;
}

export function useCredentials() {
  const { data, error, isLoading } = useSWR("/api/credentials", fetcher);

  async function saveCredentials(store: CredentialStore) {
    const res = await fetch("/api/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(store),
    });
    const json: ApiResponse<null> = await res.json();
    if (!json.success) throw new Error(json.error?.message);
    // Revalidate credentials and health checks
    mutate("/api/credentials");
    mutate("/api/health");
  }

  async function deleteProvider(provider: keyof CredentialStore) {
    const res = await fetch("/api/credentials", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider }),
    });
    const json: ApiResponse<null> = await res.json();
    if (!json.success) throw new Error(json.error?.message);
    mutate("/api/credentials");
    mutate("/api/health");
  }

  return {
    credentials: data,
    isLoading,
    error,
    saveCredentials,
    deleteProvider,
  };
}
