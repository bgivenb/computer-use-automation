import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import { lstat, readFile, readlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type SecretRule = {
  name: string;
  pattern: RegExp;
  neverPlaceholder?: boolean;
};

const secretRules: readonly SecretRule[] = [
  {
    name: "private-key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
    neverPlaceholder: true,
  },
  { name: "openai-or-anthropic-key", pattern: /\b(?<secret>sk-[A-Za-z0-9_-]{20,})\b/g },
  { name: "github-token", pattern: /\b(?<secret>gh[pousr]_[A-Za-z0-9]{36,})\b/g },
  { name: "github-fine-grained-token", pattern: /\b(?<secret>github_pat_[A-Za-z0-9_]{50,})\b/g },
  { name: "aws-access-key", pattern: /\b(?<secret>(?:AKIA|ASIA)[A-Z0-9]{16})\b/g },
  { name: "google-api-key", pattern: /\b(?<secret>AIza[A-Za-z0-9_-]{35})\b/g },
  { name: "slack-token", pattern: /\b(?<secret>xox[baprs]-[A-Za-z0-9-]{20,})\b/g },
  { name: "stripe-live-key", pattern: /\b(?<secret>[sr]k_live_[A-Za-z0-9]{16,})\b/g },
  { name: "npm-token", pattern: /\b(?<secret>npm_[A-Za-z0-9]{36,})\b/g },
  {
    name: "jwt",
    pattern: /\b(?<secret>eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
  },
  {
    name: "authorization-bearer",
    pattern: /\bBearer\s+(?<secret>[A-Za-z0-9._~+/-]{20,})\b/gi,
  },
  {
    name: "credential-in-url",
    pattern:
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:\s/@]+:(?<secret>[^@\s]{8,})@/gi,
  },
  {
    name: "assigned-credential",
    pattern:
      /\b(?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\s*[:=]\s*["']?(?<secret>[A-Za-z0-9+/_=.!@#$%^&*~-]{16,})/gi,
  },
];

export type SecretFinding = {
  file: string;
  line: number;
  column: number;
  rule: string;
  preview: string;
};

export type SecretScanResult = {
  checkedFiles: number;
  skippedBinaryFiles: number;
  findings: SecretFinding[];
};

function candidateFromMatch(match: RegExpExecArray): string {
  const captured = match.groups?.secret;
  return captured === undefined ? match[0] : captured;
}

function isDocumentedPlaceholder(candidate: string): boolean {
  const normalized = candidate
    .trim()
    .replace(/^["']|["']$/g, "")
    .toLowerCase();
  if (/^(?:\.{3}|\*{3,}|x{3,}|changeme|none|null)$/.test(normalized)) {
    return true;
  }
  return /^(?:sk-)?(?:placeholder|example|dummy|fake|redacted|replace[-_]?me|not[-_]?a[-_]?real|your[-_]?)(?:[-_].*)?$/.test(
    normalized,
  );
}

function masked(candidate: string): string {
  return `[REDACTED:${candidate.length} chars]`;
}

export function findSecretsInText(file: string, content: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const seenLocations = new Set<string>();
  for (const [lineIndex, line] of content.split(/\r?\n/).entries()) {
    for (const rule of secretRules) {
      rule.pattern.lastIndex = 0;
      let match = rule.pattern.exec(line);
      while (match !== null) {
        const candidate = candidateFromMatch(match);
        if (rule.neverPlaceholder === true || !isDocumentedPlaceholder(candidate)) {
          const candidateOffset = match[0].indexOf(candidate);
          const column = match.index + Math.max(0, candidateOffset) + 1;
          const location = `${lineIndex + 1}:${column}:${candidate.length}`;
          if (!seenLocations.has(location)) {
            seenLocations.add(location);
            findings.push({
              file,
              line: lineIndex + 1,
              column,
              rule: rule.name,
              preview: masked(candidate),
            });
          }
        }
        if (match[0].length === 0) {
          rule.pattern.lastIndex += 1;
        }
        match = rule.pattern.exec(line);
      }
    }
  }
  return findings;
}

function containedPath(repoRoot: string, trackedPath: string): string | undefined {
  if (isAbsolute(trackedPath)) {
    return undefined;
  }
  const absolute = resolve(repoRoot, trackedPath);
  const fromRoot = relative(repoRoot, absolute);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    return undefined;
  }
  return absolute;
}

async function candidatePaths(repoRoot: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return stdout.split("\0").filter((path) => path.length > 0);
}

function isBinary(buffer: Buffer): boolean {
  return buffer.includes(0);
}

export async function scanCandidateFiles(repoRoot = process.cwd()): Promise<SecretScanResult> {
  const findings: SecretFinding[] = [];
  let checkedFiles = 0;
  let skippedBinaryFiles = 0;
  for (const trackedPath of await candidatePaths(repoRoot)) {
    const absolute = containedPath(repoRoot, trackedPath);
    if (absolute === undefined) {
      throw new Error(`git returned an unsafe tracked path: ${trackedPath}`);
    }
    let metadata: Stats;
    try {
      metadata = await lstat(absolute);
    } catch {
      // A tracked file deleted in the working tree has no current content to inspect.
      continue;
    }
    let buffer: Buffer;
    if (metadata.isSymbolicLink()) {
      buffer = Buffer.from(await readlink(absolute), "utf8");
    } else if (metadata.isFile()) {
      buffer = await readFile(absolute);
    } else {
      continue;
    }
    if (isBinary(buffer)) {
      skippedBinaryFiles += 1;
      continue;
    }
    checkedFiles += 1;
    findings.push(...findSecretsInText(trackedPath, buffer.toString("utf8")));
  }
  return { checkedFiles, skippedBinaryFiles, findings };
}

async function main(): Promise<void> {
  let result: SecretScanResult;
  try {
    result = await scanCandidateFiles();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Secret scan could not run: ${message}`);
    process.exitCode = 1;
    return;
  }
  if (result.findings.length > 0) {
    console.error(`Secret scan found ${result.findings.length} potential secret(s):`);
    for (const finding of result.findings) {
      console.error(
        `- ${finding.file}:${finding.line}:${finding.column} ${finding.rule} ${finding.preview}`,
      );
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `Secret scan passed: ${result.checkedFiles} tracked text file(s) checked, ${result.skippedBinaryFiles} binary file(s) skipped.`,
  );
}

const entryPath = process.argv[1];
if (entryPath !== undefined && fileURLToPath(import.meta.url) === resolve(entryPath)) {
  await main();
}
