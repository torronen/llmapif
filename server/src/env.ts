import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

type RuntimeConfigValue = string | number | boolean | null | undefined;
type RuntimeConfig = Record<string, RuntimeConfigValue>;

const runtimeConfigCandidates = [
  process.env.LLMAPIF_CONFIG_FILE,
  '/app/config/llmapif.json',
  '/etc/llmapif/config.json',
].filter((candidate): candidate is string => Boolean(candidate));

function applyRuntimeConfig(config: RuntimeConfig): void {
  for (const [key, value] of Object.entries(config)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || value === null || value === undefined) {
      continue;
    }
    if (process.env[key] !== undefined) {
      continue;
    }
    process.env[key] = String(value);
  }
}

for (const configPath of runtimeConfigCandidates) {
  if (!fs.existsSync(configPath)) {
    continue;
  }

  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as RuntimeConfig;
  applyRuntimeConfig(parsed);
  break;
}
