#!/usr/bin/env node
import {
  createNagi,
  loadDotenv,
  logger
} from "./chunk-RWI4MSJR.js";
import {
  investigateTicket,
  researchEntry,
  reviewRepoEntry,
  surfaceEntry
} from "./chunk-S345XOLX.js";
import "./chunk-MXPDRPU6.js";
import "./chunk-ZO2TLVOL.js";

// src/cli.ts
loadDotenv();
process.on("unhandledRejection", (reason) => {
  logger.error("unhandledRejection", { reason: String(reason) });
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  logger.error("uncaughtException", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
var configPath = process.env["NAGI_CONFIG"] ?? "./nagi.config.json";
createNagi({ config: configPath, workflows: [reviewRepoEntry, researchEntry, surfaceEntry, investigateTicket] }).start().catch((err) => {
  logger.error("startup failed", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
