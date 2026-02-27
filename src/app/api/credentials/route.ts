import { NextResponse } from "next/server";
import {
  getCredentials,
  saveCredentials,
  deleteCredentials,
  maskKey,
} from "@/lib/credentials";
import type { CredentialStore, ApiResponse } from "@/types";

type MaskedStore = {
  claude?: { sessionKey?: string; organizationId?: string };
};

export async function GET(): Promise<NextResponse<ApiResponse<MaskedStore>>> {
  const store = getCredentials();
  const masked: MaskedStore = {};

  if (store.claude) {
    masked.claude = {
      sessionKey: store.claude.sessionKey
        ? maskKey(store.claude.sessionKey)
        : undefined,
      organizationId: store.claude.organizationId,
    };
  }
  return NextResponse.json({ success: true, data: masked });
}

export async function POST(
  request: Request
): Promise<NextResponse<ApiResponse<null>>> {
  try {
    const body: CredentialStore = await request.json();
    const existing = getCredentials();

    // Merge with existing credentials
    const merged: CredentialStore = { ...existing };
    if (body.claude) merged.claude = { ...existing.claude, ...body.claude };

    saveCredentials(merged);
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      {
        success: false,
        error: { code: "SAVE_ERROR", message: "Failed to save credentials" },
      },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: Request
): Promise<NextResponse<ApiResponse<null>>> {
  try {
    const { provider } = await request.json();
    if (!["claude"].includes(provider)) {
      return NextResponse.json(
        {
          success: false,
          error: { code: "INVALID_PROVIDER", message: "Invalid provider" },
        },
        { status: 400 }
      );
    }
    deleteCredentials(provider);
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "DELETE_ERROR",
          message: "Failed to delete credentials",
        },
      },
      { status: 500 }
    );
  }
}
