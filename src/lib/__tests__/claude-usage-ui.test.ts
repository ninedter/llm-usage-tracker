import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ClaudeCard } from "@/components/providers/ClaudeCard";
import { ProviderUsageStrip } from "@/components/monitor/ProviderUsageStrip";
import { parseClaudeUsage } from "@/lib/providers/claude-usage";

const { usageHook } = vi.hoisted(() => ({ usageHook: vi.fn() }));
vi.mock("@/hooks/use-usage-data", () => ({
  useClaudeUsage: usageHook,
  useHealth: () => ({ data: { claude: { connected: true }, openai: { connected: false } } }),
  useOpenAIUsage: () => ({ data: null }),
}));

describe("Claude usage graphs", () => {
  it("shows Ultra's weekly and model graphs without a phantom session bar", () => {
    usageHook.mockReturnValue({ data: parseClaudeUsage({
      five_hour: null,
      seven_day: { utilization: 78 },
      limits: [{ kind: "weekly_scoped", percent: 42, scope: { model: { display_name: "Fable" } } }],
    }, "Ultra") });
    const card = renderToStaticMarkup(createElement(ClaudeCard, { enabled: true }));
    expect(card).toContain("Claude Ultra");
    expect(card).toContain("7-Day Window");
    expect(card).toContain("78.0%");
    expect(card).toContain("Fable");
    expect(card).not.toContain("5-Hour Window");
    expect(card).toContain("Weekly limits still apply");
    const strip = renderToStaticMarkup(createElement(ProviderUsageStrip));
    expect(strip).toContain("Claude Ultra");
    expect(strip).toContain("7d");
    expect(strip).toContain("78%");
    expect(strip).not.toContain("5h");
  });

  it.each(["Pro", "Max", "Ultra"])("shows the five-hour graph when it is reported on %s", (plan) => {
    usageHook.mockReturnValue({ data: parseClaudeUsage({
      five_hour: { utilization: 0 }, seven_day: { utilization: 78 },
    }, plan) });
    const card = renderToStaticMarkup(createElement(ClaudeCard, { enabled: true }));
    expect(card).toContain("5-Hour Window");
    expect(card).toContain("0.0%");
    expect(card).toContain("7-Day Window");
    if (plan === "Ultra") expect(card).toContain("temporary five-hour limit");
    expect(renderToStaticMarkup(createElement(ProviderUsageStrip))).toContain("5h");
  });

  it("renders an empty response without displaying fabricated usage", () => {
    usageHook.mockReturnValue({ data: parseClaudeUsage({}) });
    const card = renderToStaticMarkup(createElement(ClaudeCard, { enabled: true }));
    expect(card).toContain("No usage limits are currently reported");
    expect(card).not.toContain("0.0%");
    expect(renderToStaticMarkup(createElement(ProviderUsageStrip))).toBe("");
  });
});
