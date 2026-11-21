import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ghApiObject } from "./gh.ts";
import { run } from "./proc.ts";
import type { Config, RepoMeta, RepoRef } from "./types.ts";

export function parseRemote(url: string): { owner: string; name: string } | null {
  const cleaned = url.trim();
  const match = cleaned.match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (!match) return null;
  return { owner: match[1], name: match[2].replace(/\.git$/i, "") };
}

export async function discoverRepos(cfg: Config): Promise<RepoRef[]> {
  const found = new Map<string, RepoRef>();
  for (const root of cfg.roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(root, entry.name);
      if (!existsSync(join(path, ".git"))) continue;
      const remote = await run("git", ["-C", path, "remote", "get-url", "origin"], { timeoutMs: 20_000 });
      if (remote.code !== 0) continue;
      const parsed = parseRemote(remote.stdout);
      if (!parsed) continue;
      const slug = `${parsed.owner}/${parsed.name}`;
      if (cfg.excludeRepos.includes(slug)) continue;
      if (!found.has(slug)) found.set(slug, { slug, owner: parsed.owner, name: parsed.name, path });
    }
  }
  for (const extra of cfg.extraRepos) {
    if (!existsSync(extra.path)) continue;
    if (cfg.excludeRepos.includes(extra.slug)) continue;
    const [owner, name] = extra.slug.split("/");
    if (!owner || !name) continue;
    if (!found.has(extra.slug)) found.set(extra.slug, { slug: extra.slug, owner, name, path: extra.path });
  }
  return [...found.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function refreshRepoMeta(repo: RepoRef, cached: RepoMeta | null): Promise<RepoMeta> {
  if (cached && Date.now() - Date.parse(cached.refreshedAt) < 6 * 60 * 60 * 1000) return cached;
  const data = await ghApiObject<{ has_issues?: boolean; default_branch?: string; private?: boolean }>(
    `repos/${repo.slug}`,
  );
  return {
    hasIssuesEnabled: data.has_issues !== false,
    defaultBranch: data.default_branch || "main",
    isPrivate: data.private === true,
    refreshedAt: new Date().toISOString(),
  };
}
