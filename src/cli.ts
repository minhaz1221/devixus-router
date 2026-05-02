#!/usr/bin/env node
import { cac } from "cac";
import chalk from "chalk";
import { startProxyServer } from "./proxy.js";
import { getUsageStats, getDefaultDbPath } from "./db.js";

type GlobalOptions = {
  db?: string;
};

const cli = cac("devixus-router");

cli
  .option("--db <path>", "Path to usage database JSON file")
  .help()
  .version("0.1.0");

cli
  .command("proxy", "Starts the local server")
  .option("--port <port>", "Port to listen on", {
    default: 3000
  })
  .action(async (opts: { port: string | number } & GlobalOptions) => {
    const port =
      typeof opts.port === "string" ? Number.parseInt(opts.port, 10) : opts.port;
    if (!Number.isFinite(port) || port <= 0) {
      // eslint-disable-next-line no-console
      console.error(chalk.redBright("Invalid --port value"));
      process.exitCode = 1;
      return;
    }

    // Global flags are merged into opts by cac
    void opts.db;

    await startProxyServer({ port });
  });

cli
  .command("stats", "Shows usage")
  .action(async (opts: GlobalOptions) => {
    const dbPath = opts.db ?? getDefaultDbPath();
    const s = await getUsageStats(dbPath);

    const haiku = s.by_routed_model["claude-haiku-4-5"]?.requests ?? 0;
    const sonnet = s.by_routed_model["claude-3-5-sonnet-20241022"]?.requests ?? 0;

    // eslint-disable-next-line no-console
    console.log(chalk.cyanBright("Usage stats"));
    // eslint-disable-next-line no-console
    console.log(chalk.gray(`DB: ${dbPath}`));

    // eslint-disable-next-line no-console
    console.table([
      { Metric: "Total Requests", Value: s.total_requests },
      { Metric: "Haiku Requests", Value: haiku },
      { Metric: "Sonnet Requests", Value: sonnet },
      { Metric: "Total Money Spent", Value: `$${s.total_cost_usd.toFixed(6)}` },
      { Metric: "Total Money Saved", Value: `$${s.total_saved_usd.toFixed(6)}` }
    ]);
  });

cli.parse();

