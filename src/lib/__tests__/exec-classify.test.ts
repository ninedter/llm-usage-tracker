import { describe, it, expect } from "vitest";
import { extractExecCommand, classifyCommand } from "@/lib/exec-classify";

describe("extractExecCommand", () => {
  it("pulls the cmd out of a Codex exec_command input", () => {
    const input = `const r = await tools.exec_command({"cmd":"rg -n \\"foo bar\\" src"})`;
    expect(extractExecCommand(input)).toBe('rg -n "foo bar" src');
  });

  it("survives truncated content (no closing quote)", () => {
    const input = `const r = await tools.exec_command({"cmd":"rg -n \\"Phase 5|touch QC|rework`;
    expect(extractExecCommand(input)).toBe('rg -n "Phase 5|touch QC|rework');
  });

  it("returns null when there is no cmd key", () => {
    expect(extractExecCommand("tools.js({code: '1+1'})")).toBeNull();
    expect(extractExecCommand("")).toBeNull();
  });
});

describe("classifyCommand", () => {
  it.each([
    ["rg -n foo src", "explore"],
    ["cat package.json", "explore"],
    ["ls -la", "explore"],
    ["git log --oneline -5", "explore"],
    ["git diff HEAD~1", "explore"],
    ["sed -n '1,50p' file.ts", "explore"],
    ["curl -s http://localhost:3000/api/health", "explore"],
    ["/usr/bin/grep -r foo .", "explore"],
    ["cd /some/repo && rg -l pattern", "explore"],
    ["FOO=bar rg pattern", "explore"],
  ])("%s → explore", (cmd, expected) => {
    expect(classifyCommand(cmd)).toBe(expected);
  });

  it.each([
    ["rm -rf node_modules", "modify"],
    ["mv a.ts b.ts", "modify"],
    ["mkdir -p src/lib", "modify"],
    ["sed -i '' 's/a/b/' file.ts", "modify"],
    ["git commit -m 'x'", "modify"],
    ["git checkout -b feature", "modify"],
    ["cd /repo && rm old.txt", "modify"],
    ["touch marker", "modify"],
  ])("%s → modify", (cmd, expected) => {
    expect(classifyCommand(cmd)).toBe(expected);
  });

  it("refuses to classify ambiguous runners", () => {
    expect(classifyCommand("node script.js")).toBeNull();
    expect(classifyCommand("npm test")).toBeNull();
    expect(classifyCommand("python3 analyze.py")).toBeNull();
    expect(classifyCommand("docker compose up -d")).toBeNull();
    expect(classifyCommand("")).toBeNull();
  });

  it("classifies git by subcommand, skipping flags", () => {
    expect(classifyCommand("git --no-pager log")).toBe("explore");
    expect(classifyCommand("git push origin main")).toBe("modify");
    expect(classifyCommand("git bisect run ./t.sh")).toBeNull();
  });
});
