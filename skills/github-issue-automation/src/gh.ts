import { run } from "./proc.ts";

export interface GhResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export async function gh(args: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<GhResult> {
  const result = await run("gh", args, { cwd: options.cwd, timeoutMs: options.timeoutMs ?? 120_000 });
  return { stdout: result.stdout, stderr: result.stderr, code: result.code };
}

export async function ghText(args: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<string> {
  const result = await gh(args, options);
  if (result.code !== 0) {
    throw new Error(`gh ${args[0]} failed (exit ${result.code}): ${result.stderr.trim().slice(0, 800)}`);
  }
  return result.stdout.trim();
}

export async function ghApiJson<T = unknown>(path: string, query: string[] = [], paginate = false): Promise<T[]> {
  const args = paginate ? ["api", "--paginate", "--slurp", path, ...query] : ["api", path, ...query];
  const result = await gh(args, { timeoutMs: paginate ? 120_000 : 30_000 });
  if (result.code !== 0) {
    throw new Error(`gh api ${path} failed (exit ${result.code}): ${result.stderr.trim().slice(0, 800)}`);
  }
  const text = result.stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) return [parsed as T];
  if (paginate) return parsed.flatMap((page) => (Array.isArray(page) ? (page as T[]) : [page as T]));
  return parsed as T[];
}

export async function ghApiObject<T = unknown>(path: string): Promise<T> {
  const result = await gh(["api", path], { timeoutMs: 60_000 });
  if (result.code !== 0) {
    throw new Error(`gh api ${path} failed (exit ${result.code}): ${result.stderr.trim().slice(0, 800)}`);
  }
  return JSON.parse(result.stdout) as T;
}

export async function ghRateRemaining(): Promise<number> {
  try {
    const result = await gh(["api", "rate_limit", "--jq", ".rate.remaining"], { timeoutMs: 20_000 });
    if (result.code !== 0) return -1;
    const value = Number(result.stdout.trim());
    return Number.isFinite(value) ? value : -1;
  } catch {
    return -1;
  }
}
