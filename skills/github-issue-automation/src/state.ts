import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config, RepoState, State } from "./types.ts";

export function statePath(cfg: Config): string {
  return join(cfg.stateDir, "state.json");
}

function emptyState(now = new Date().toISOString()): State {
  return { version: 1, installedAt: now, repos: {} };
}

export function loadState(cfg: Config): State {
  const path = statePath(cfg);
  if (!existsSync(path)) {
    const state = emptyState();
    saveState(cfg, state);
    return state;
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as State;
  if (parsed.version !== 1) throw new Error(`unsupported state version ${String(parsed.version)}`);
  return parsed;
}

export function saveState(cfg: Config, state: State): void {
  mkdirSync(cfg.stateDir, { recursive: true });
  const path = statePath(cfg);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

export function repoState(state: State, slug: string, baseline = new Date()): RepoState {
  let repo = state.repos[slug];
  if (!repo) {
    repo = {
      baselineAt: baseline.toISOString(),
      lastScanAt: null,
      meta: null,
      items: {},
      queue: [],
      handled: [],
    };
    state.repos[slug] = repo;
  }
  return repo;
}

export function pruneRepoState(repo: RepoState, maxHandled = 500, maxQueue = 30): void {
  if (repo.handled.length > maxHandled) repo.handled = repo.handled.slice(-maxHandled);
  if (repo.queue.length > maxQueue) repo.queue = repo.queue.slice(-maxQueue);
  const itemEntries = Object.entries(repo.items);
  if (itemEntries.length > 800) {
    itemEntries
      .sort((a, b) => (a[1].lastHandledAt ?? "").localeCompare(b[1].lastHandledAt ?? ""))
      .slice(0, itemEntries.length - 800)
      .forEach(([key]) => delete repo.items[key]);
  }
}

export function acquireLock(cfg: Config): boolean {
  mkdirSync(cfg.stateDir, { recursive: true });
  const path = join(cfg.stateDir, "lock.json");
  if (existsSync(path)) {
    try {
      const lock = JSON.parse(readFileSync(path, "utf8")) as { pid?: number; startedAt?: string };
      const started = lock.startedAt ? Date.parse(lock.startedAt) : 0;
      const alive = typeof lock.pid === "number" && isAlive(lock.pid);
      const stale = !started || Date.now() - started > 4 * 60 * 60 * 1000;
      if (alive && !stale) return false;
    } catch {}
  }
  writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
  return true;
}

export function releaseLock(cfg: Config): void {
  const path = join(cfg.stateDir, "lock.json");
  try {
    const lock = JSON.parse(readFileSync(path, "utf8")) as { pid?: number };
    if (lock.pid === process.pid) writeFileSync(path, "");
  } catch {}
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}
