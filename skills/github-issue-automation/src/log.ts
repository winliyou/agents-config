import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./types.ts";

export function log(cfg: Config, message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  process.stdout.write(line);
  try {
    mkdirSync(cfg.stateDir, { recursive: true });
    appendFileSync(join(cfg.stateDir, "agent.log"), line);
  } catch {}
}
