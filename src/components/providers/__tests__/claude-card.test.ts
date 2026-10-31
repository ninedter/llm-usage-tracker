import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseClaudeUsage } from "@/lib/providers/claude-parse";
import { ClaudeCard } from "../ClaudeCard";

const state = vi.hoisted(() => ({ data: {} as unknown }));
vi.mock("@/hooks/use-usage-data", () => ({
  useClaudeUsage: () => ({ data: state.data, error: null, isLoading: false }),
}));
// Vite's default JSX transform uses the classic React runtime.
vi.stubGlobal("React", React);
afterAll(() => vi.unstubAllGlobals());

describe("Claude usage card", () => {
  it("renders cloud balance, total and expiry separately from prepaid credits", () => {
    state.data = parseClaudeUsage({ iguana_necktie: {
      limit_dollars: 250, remaining_dollars: 93.073258,
      resets_at: "2026-11-05T07:59:00+00:00",
    } }, { prepaid: { amount: 0 } });
    const html = renderToStaticMarkup(React.createElement(ClaudeCard));
    expect(html).toContain("Cloud session credits");
    expect(html).toContain("Included credit");
    expect(html).toContain("$93.07 of $250.00 left");
    expect(html).toContain("November");
    expect(html).toContain("Prepaid balance");
  });

  it("renders weekly and model usage without a phantom five-hour bar", () => {
    state.data = parseClaudeUsage({
      five_hour: { utilization: 0, resets_at: null },
      seven_day: { utilization: 25 },
      limits: [{ percent: 10, scope: { model: { display_name: "Fable" } } }],
    });
    const html = renderToStaticMarkup(React.createElement(ClaudeCard));
    expect(html).not.toContain("5-Hour Window");
    expect(html).toContain("7-Day Window");
    expect(html).toContain("Fable");
  });

  it("renders a genuine zero-percent session that has a reset time", () => {
    state.data = parseClaudeUsage({
      five_hour: { utilization: 0, resets_at: "2026-11-01T00:00:00Z" },
    });
    expect(renderToStaticMarkup(React.createElement(ClaudeCard))).toContain("5-Hour Window");
  });

  it("honors weekly-only display while preserving upstream session metrics", () => {
    state.data = {
      ...parseClaudeUsage({ five_hour: { utilization: 1, resets_at: "2026-11-01T00:00:00Z" } }),
      hideSessionWindow: true,
    };
    const html = renderToStaticMarkup(React.createElement(ClaudeCard));
    expect(html).not.toContain("5-Hour Window");
    expect(html).toContain("7-Day Window");
  });
});
