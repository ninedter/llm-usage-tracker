import type { ResetCredit } from "@/types";

interface ResetCreditsProps {
  available: number;
  credits: ResetCredit[];
  noun: string;
}

export function ResetCredits({ available, credits, noun }: ResetCreditsProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
        <svg
          className={`h-3.5 w-3.5 ${available > 0 ? "text-emerald-500" : "text-zinc-400 dark:text-zinc-600"}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
          />
        </svg>
        <span>
          <span className="font-semibold text-zinc-800 dark:text-zinc-200">
            {available}
          </span>{" "}
          {noun}{available === 1 ? "" : "s"} available
        </span>
      </div>

      {credits.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {credits.map((credit) => (
            <div
              key={credit.id}
              title={credit.detail}
              className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-700/60 dark:bg-zinc-800/40"
            >
              <p className="truncate text-xs font-medium text-zinc-500 dark:text-zinc-400">
                {credit.title}
              </p>
              <p className="mt-0.5 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                {credit.expiresAt
                  ? `Expires ${formatExpiryDate(credit.expiresAt)}`
                  : "No expiry"}
              </p>
              {credit.expiresAt && (
                <p className="text-xs text-zinc-400 dark:text-zinc-500">
                  {formatExpiryRelative(credit.expiresAt)}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatExpiryDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

function formatExpiryRelative(iso: string): string {
  try {
    const diffMs = new Date(iso).getTime() - Date.now();
    if (diffMs <= 0) return "expired";
    const days = Math.floor(diffMs / 86400000);
    const hours = Math.floor((diffMs % 86400000) / 3600000);
    if (days > 0) return `in ${days}d`;
    if (hours > 0) return `in ${hours}h`;
    return "within the hour";
  } catch {
    return "";
  }
}

