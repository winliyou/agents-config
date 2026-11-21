import { run } from "./proc.ts";

export interface GitOptions {
  timeoutMs?: number;
}

export async function git(cwd: string, args: string[], options: GitOptions = {}): Promise<string> {
  const result = await run("git", args, { cwd, timeoutMs: options.timeoutMs ?? 180_000 });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 800)}`);
  }
  return result.stdout.trim();
}

export async function gitTry(cwd: string, args: string[], options: GitOptions = {}): Promise<{ ok: boolean; output: string }> {
  const result = await run("git", args, { cwd, timeoutMs: options.timeoutMs ?? 180_000 });
  return { ok: result.code === 0, output: (result.stdout + result.stderr).trim() };
}

export async function gitCommonDir(cwd: string): Promise<string> {
  return git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
}

export async function gitHead(cwd: string): Promise<string> {
  return git(cwd, ["rev-parse", "HEAD"]);
}

export async function gitDiffStat(cwd: string, baseRef: string): Promise<string> {
  const out = await gitTry(cwd, ["diff", "--stat", baseRef]);
  return out.output;
}

export async function gitDirty(cwd: string): Promise<string> {
  return git(cwd, ["status", "--porcelain"]);
}
