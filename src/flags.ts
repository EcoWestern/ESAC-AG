/** Parsers for structured CLI request flags. */

export function parseMaxTokens(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`must be a positive whole number (got "${raw}")`);
  }
  return value;
}

export function parseThinkingTokens(raw: string): Record<string, unknown> {
  return { reasoning: { max_tokens: parseMaxTokens(raw) } };
}

export function parseExtraBody(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`must be a JSON object (got "${raw}")`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`must be a JSON object (got "${raw}")`);
  }
  return parsed as Record<string, unknown>;
}
