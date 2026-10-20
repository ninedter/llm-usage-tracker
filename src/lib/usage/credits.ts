import { formatCredits, formatMoney } from "@/lib/format";
import type { ClaudeUsageData, OpenAIUsageData } from "@/types";

/**
 * One-line add-on credit summary for compact views (the Monitor strip).
 * Prepaid balance wins because it's real money already on the account;
 * capped extra usage shows headroom; uncapped extra usage can only show spend.
 */
export function claudeCreditSummary(d: ClaudeUsageData): string | null {
  if (d.prepaidBalance) {
    return `${formatMoney(d.prepaidBalance.amount, d.prepaidBalance.currency)} left`;
  }
  const x = d.extraUsage;
  if (x?.enabled && x.monthlyLimit != null && x.remaining != null) {
    return `${formatMoney(x.remaining, x.currency)} left`;
  }
  if (x?.enabled) {
    return `${formatMoney(x.used, x.currency)} spent`;
  }
  return null;
}

/** One-line OpenAI credit summary; balances are credits, not money. */
export function openaiCreditSummary(d: OpenAIUsageData): string | null {
  const c = d.credits;
  if (c?.unlimited) return "Unlimited";
  // A balance figure only counts while the account actually has credits
  if (c?.hasCredits) {
    return c.balance != null ? `${formatCredits(c.balance)} credits` : "Credits available";
  }
  if (d.creditsDepleted) return "Credits depleted";
  return null;
}
