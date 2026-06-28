#!/usr/bin/env node
import {
  createNagi,
  logger
} from "./chunk-QTKKOG33.js";
import {
  investigateTicket,
  researchEntry,
  reviewRepoEntry
} from "./chunk-S345XOLX.js";

// src/cli.ts
process.on("unhandledRejection", (reason) => {
  logger.error("unhandledRejection", { reason: String(reason) });
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  logger.error("uncaughtException", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
var configPath = process.env["NAGI_CONFIG"] ?? "./nagi.config.json";
createNagi({ config: configPath, workflows: [reviewRepoEntry, researchEntry, investigateTicket] }).start().catch((err) => {
  logger.error("startup failed", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
