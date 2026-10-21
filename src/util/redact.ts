const STATIC_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]"],
  [/\bsk-[A-Za-z0-9_-]{6,}\b/g, "sk-[REDACTED]"],
  [/\bgh[pousr]_[A-Za-z0-9]{10,}\b/g, "gh[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{10,}\b/g, "github_pat_[REDACTED]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "xox[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "AKIA[REDACTED]"],
  [/(Authorization\s*:\s*Bearer\s+)[^\s"',}]+/gi, "$1[REDACTED]"],
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, "$1[REDACTED]"],
  [
    /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd)\s*[:=]\s*["']?)[^\s"',}\]]{6,}/gi,
    "$1[REDACTED]",
  ],
];

let sensitiveEnvValues: string[] | null = null;

function getSensitiveEnvValues(): string[] {
  if (sensitiveEnvValues) return sensitiveEnvValues;
  const values: string[] = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || value.length < 8) continue;
    if (!/(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH)/i.test(key)) continue;
    if (/^(?:true|false|1|0|yes|no)$/i.test(value)) continue;
    values.push(value);
  }
  values.sort((a, b) => b.length - a.length);
  sensitiveEnvValues = values.slice(0, 100);
  return sensitiveEnvValues;
}

export function redactText(input: string): string {
  let text = input;
  for (const value of getSensitiveEnvValues()) {
    if (text.includes(value)) text = text.split(value).join("[REDACTED]");
  }
  for (const [pattern, replacement] of STATIC_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

export function truncateText(input: string, maxChars: number): { text: string; truncated: boolean } {
  if (input.length <= maxChars) return { text: input, truncated: false };
  return {
    text: `${input.slice(0, Math.max(0, maxChars))}\n...[truncated ${input.length - maxChars} chars]`,
    truncated: true,
  };
}

export function safeText(input: string, maxChars: number): string {
  return truncateText(redactText(input), maxChars).text;
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth limit]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redactValue(item, depth + 1));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = redactValue(item, depth + 1);
    }
    return result;
  }
  return value;
}

export function safeJson(value: unknown, maxChars = 2000): string {
  try {
    return safeText(JSON.stringify(value), maxChars);
  } catch {
    return "[unserializable]";
  }
}
