const DEFAULT_SENSITIVE_KEYS = [
  "authorization",
  "cookie",
  "set-cookie",
  "password",
  "passwd",
  "secret",
  "token",
  "access-token",
  "refresh-token",
  "api-key",
  "ssn",
  "social-security-number",
  "email",
  "member-id",
  "member-number",
  "account-number",
  "routing-number",
] as const;

export type SensitiveValue = string | number | boolean;

export type RedactionOptions = {
  sensitiveKeys?: readonly string[];
  sensitiveValues?: Readonly<Record<string, SensitiveValue>>;
};

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function redactionToken(label: string): string {
  const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48) || "value";
  return `[REDACTED:${safeLabel}]`;
}

function sensitiveKeySet(options: RedactionOptions): ReadonlySet<string> {
  return new Set(
    [...DEFAULT_SENSITIVE_KEYS, ...(options.sensitiveKeys ?? [])].map((key) => normalizeKey(key)),
  );
}

function replaceSensitiveValues(text: string, options: RedactionOptions): string {
  const entries = Object.entries(options.sensitiveValues ?? {})
    .map(([label, value]) => [label, String(value)] as const)
    .filter(([, value]) => value.length >= 3)
    .sort((left, right) => right[1].length - left[1].length);

  return entries.reduce(
    (redacted, [label, value]) => redacted.split(value).join(redactionToken(label)),
    text,
  );
}

/** Redacts common credential and PII shapes after applying exact invocation-specific values. */
export function redactText(text: string, options: RedactionOptions = {}): string {
  return replaceSensitiveValues(text, options)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, "Bearer [REDACTED:token]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED:token]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED:email]")
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[REDACTED:ssn]")
    .replace(/\b(?:\d[ -]?){15}\d\b/g, "[REDACTED:card]")
    .replace(
      /(\b(?:password|passwd|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|secret)\b\s*[:=]\s*)[^\s,;&]+/gi,
      "$1[REDACTED:secret]",
    )
    .replace(
      /(\b(?:member|account|routing)(?:[-_ ]+(?:id|number|no))?\s*[:=#]\s*)[A-Za-z0-9-]{4,}/gi,
      "$1[REDACTED:identifier]",
    );
}

function redactUnknown(
  value: unknown,
  options: RedactionOptions,
  keys: ReadonlySet<string>,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") {
    return redactText(value, options);
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return redactionToken("circular");
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const output = value.map((item) => redactUnknown(item, options, keys, seen));
    seen.delete(value);
    return output;
  }

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = keys.has(normalizeKey(key))
      ? redactionToken(key)
      : redactUnknown(child, options, keys, seen);
  }
  seen.delete(value);
  return output;
}

/** Returns a deep redacted copy and never mutates the source value. */
export function redactValue(value: unknown, options: RedactionOptions = {}): unknown {
  return redactUnknown(value, options, sensitiveKeySet(options), new WeakSet());
}

export function toRedactedJson(value: unknown, options: RedactionOptions = {}): string {
  return JSON.stringify(redactValue(value, options));
}
