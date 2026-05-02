import { JSONFilePreset } from "lowdb/node";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Low } from "lowdb";
import type { DbSchema, UsageEntry } from "./types.js";

export function getDefaultDbPath(): string {
  return path.join(homedir(), ".devixus-router", "db.json");
}

export async function openDb(dbPath = getDefaultDbPath()): Promise<Low<DbSchema>> {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  return await JSONFilePreset<DbSchema>(dbPath, { usage: [] });
}

export type ModelPricing = {
  input_per_mtok: number;
  output_per_mtok: number;
};

export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  // Defaults based on current Anthropic pricing tables for Haiku 4.5 and Sonnet tiers.
  // Unknown models fall back to Sonnet-like rates below.
  "claude-haiku-4-5": { input_per_mtok: 1, output_per_mtok: 5 },
  "claude-3-5-sonnet-20241022": { input_per_mtok: 3, output_per_mtok: 15 }
};

export function estimateCostUsd(
  model: string,
  input_tokens: number,
  output_tokens: number
): number {
  const p = DEFAULT_PRICING[model] ?? DEFAULT_PRICING["claude-3-5-sonnet-20241022"];
  const input = (Math.max(0, input_tokens) / 1_000_000) * p.input_per_mtok;
  const output = (Math.max(0, output_tokens) / 1_000_000) * p.output_per_mtok;
  return input + output;
}

export async function addUsage(entry: UsageEntry, dbPath?: string): Promise<void> {
  const db = await openDb(dbPath);
  db.data.usage.push(entry);
  await db.write();
}

export type UsageStats = {
  total_requests: number;
  total_cost_usd: number;
  total_would_be_sonnet_cost_usd: number;
  total_saved_usd: number;
  by_routed_model: Record<
    string,
    {
      requests: number;
      cost_usd: number;
    }
  >;
};

export async function getUsageStats(dbPath?: string): Promise<UsageStats> {
  const db = await openDb(dbPath);
  const usage = db.data.usage;

  const stats: UsageStats = {
    total_requests: usage.length,
    total_cost_usd: 0,
    total_would_be_sonnet_cost_usd: 0,
    total_saved_usd: 0,
    by_routed_model: {}
  };

  for (const u of usage) {
    stats.total_cost_usd += u.estimated_cost;
    stats.total_would_be_sonnet_cost_usd += estimateCostUsd(
      "claude-3-5-sonnet-20241022",
      u.input_tokens,
      u.output_tokens
    );

    const m = (stats.by_routed_model[u.routed_model] ??= {
      requests: 0,
      cost_usd: 0
    });

    m.requests += 1;
    m.cost_usd += u.estimated_cost;
  }

  stats.total_saved_usd = Math.max(0, stats.total_would_be_sonnet_cost_usd - stats.total_cost_usd);
  return stats;
}

