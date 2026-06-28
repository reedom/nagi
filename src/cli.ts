#!/usr/bin/env node
import { createNagi } from './create-nagi.js';
import { reviewRepo, research, investigateTicket } from './workflows/index.js';
import { logger } from './logger.js';

// Fail-fast (6A): any unhandled fault exits non-zero so launchd KeepAlive
// restarts a clean process rather than limping on.
process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', { reason: String(reason) });
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});

const configPath = process.env['NAGI_CONFIG'] ?? './nagi.config.json';
createNagi({ config: configPath, workflows: [reviewRepo, research, investigateTicket] })
  .start()
  .catch((err) => {
    logger.error('startup failed', { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
