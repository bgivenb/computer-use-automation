import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { findSecretsInText, scanCandidateFiles } from "../../src/evidence/secret-scan.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("secret scanning", () => {
  it("allows documented placeholders", () => {
    const content = [
      "OPENAI_API_KEY=...",
      "AUTH_TOKEN=<your-token>",
      `CLIENT_SECRET=${"sk-" + "example-not-a-real-key-000000"}`,
      "PASSWORD=[REDACTED]",
    ].join("\n");

    expect(findSecretsInText(".env.example", content)).toEqual([]);
  });

  it("reports a likely provider key without echoing it", () => {
    const secret = `sk-${"A1b2".repeat(8)}`;
    const findings = findSecretsInText("leak.txt", `OPENAI_API_KEY=${secret}`);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("openai-or-anthropic-key");
    expect(JSON.stringify(findings)).not.toContain(secret);
  });

  it("checks current tracked and untracked non-ignored files", async () => {
    const root = await mkdtemp(join(tmpdir(), "cua-secrets-"));
    temporaryRoots.push(root);
    await execFileAsync("git", ["init", "--quiet"], { cwd: root });
    await writeFile(join(root, "tracked.txt"), "safe before staging\n", "utf8");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: root });
    const secret = `ghp_${"aB3c".repeat(10)}`;
    await writeFile(join(root, "tracked.txt"), `${secret}\n`, "utf8");
    await writeFile(join(root, "untracked.txt"), `sk-${"z9Y8".repeat(8)}\n`, "utf8");

    const result = await scanCandidateFiles(root);
    expect(result.checkedFiles).toBe(2);
    expect(result.findings.map(({ file }) => file).sort()).toEqual([
      "tracked.txt",
      "untracked.txt",
    ]);
    expect(result.findings.every(({ preview }) => /^\[REDACTED:\d+ chars\]$/.test(preview))).toBe(
      true,
    );
  });
});
