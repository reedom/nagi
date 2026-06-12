import { existsSync } from 'node:fs';

// Load a dotenv file into process.env using Node's built-in parser (no
// dependency). Best-effort: a missing file is fine — under launchd the secrets
// come from the plist's EnvironmentVariables instead, and there is no .env.
// An existing-but-malformed file should fail loudly, so that error propagates.
export function loadDotenv(path = process.env['NAGI_ENV_FILE'] ?? '.env'): void {
  if (!existsSync(path)) return;
  process.loadEnvFile(path);
}
