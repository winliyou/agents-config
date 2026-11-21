import type { Config } from "./types.ts";

export function hasMarker(text: string | null | undefined, marker: string): boolean {
  if (!text) return false;
  return text.includes(marker);
}

export function isTrusted(
  login: string | undefined,
  association: string | undefined,
  userType: string | undefined,
  cfg: Config,
): boolean {
  if (!login) return false;
  if (cfg.ignoredLogins.includes(login)) return false;
  if (cfg.trustedLogins.includes(login)) return true;
  if (userType === "Bot") return false;
  return cfg.trustedAssociations.includes((association ?? "").toUpperCase());
}

export function stripCodeFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
}

function negated(plain: string, index: number, matchText: string, negations: string[]): boolean {
  const windowStart = Math.max(0, index - 12);
  const windowText = (plain.slice(windowStart, index) + matchText).toLowerCase();
  for (const token of negations) {
    if (windowText.includes(token.toLowerCase())) return true;
  }
  return false;
}

export function isDirective(text: string | null | undefined, cfg: Config): boolean {
  if (!text) return false;
  const plain = stripCodeFences(text);
  if (!plain.trim()) return false;
  for (const pattern of cfg.directives.patterns) {
    let re: RegExp;
    try {
      re = new RegExp(pattern, "giu");
    } catch {
      continue;
    }
    let match: RegExpExecArray | null;
    while ((match = re.exec(plain)) !== null) {
      if (!negated(plain, match.index, match[0], cfg.directives.negations)) return true;
      if (match.index === re.lastIndex) re.lastIndex += 1;
    }
  }
  return false;
}

export function slugify(text: string, max = 32): string {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/[\u4e00-\u9fa5]/g, "");
  return (base || "task").slice(0, max).replace(/-+$/g, "");
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n…（已截断）";
}

export function normalizeBody(body: string | null | undefined): string {
  if (!body) return "（无正文）";
  const trimmed = body.trim();
  if (!trimmed) return "（无正文）";
  return trimmed.replace(/\r\n/g, "\n");
}
