import { readFileSync } from "node:fs";
import { parse } from "dotenv";

export function configuration() {
  let file: Record<string, string> = {};
  try {
    file = parse(readFileSync(".env"));
  } catch {
    /* Environment-only configuration is supported. */
  }
  const requestedProvider = (
    process.env.INFERENCE_PROVIDER || file.INFERENCE_PROVIDER || "cerebras"
  ).toLowerCase();
  if (!['cerebras', 'fireworks'].includes(requestedProvider))
    throw new Error('INFERENCE_PROVIDER must be cerebras or fireworks.');
  const provider = requestedProvider as 'cerebras' | 'fireworks';
  const key =
    provider === 'fireworks'
      ? file.FIREWORKS_API_KEY || process.env.FIREWORKS_API_KEY || ''
      : file.CEREBRAS_API_KEY || process.env.CEREBRAS_API_KEY || '';
  const model =
    provider === 'fireworks'
      ? file.FIREWORKS_MODEL || process.env.FIREWORKS_MODEL || 'accounts/fireworks/models/qwen3p8-27b'
      : file.CEREBRAS_MODEL || process.env.CEREBRAS_MODEL || 'qwen-3.8-27b';
  const baseURL = (
    provider === 'fireworks'
      ? file.FIREWORKS_BASE_URL || process.env.FIREWORKS_BASE_URL || 'https://api.fireworks.ai/inference/v1'
      : file.CEREBRAS_BASE_URL || process.env.CEREBRAS_BASE_URL || 'https://api.cerebras.ai/v1'
  ).replace(/\/$/, '');
  return {
    key,
    model,
    baseURL,
    provider,
    mode: key && model ? provider : ('local' as const),
    incomplete: Boolean(key) !== Boolean(model),
  };
}
