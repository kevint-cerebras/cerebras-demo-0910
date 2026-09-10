import { readFileSync } from "node:fs";
import { parse } from "dotenv";

export function configuration() {
  let file: Record<string, string> = {};
  try {
    file = parse(readFileSync(".env"));
  } catch {
    /* Environment-only configuration is supported. */
  }
  const key = file.CEREBRAS_API_KEY || process.env.CEREBRAS_API_KEY || "";
  const model = file.CEREBRAS_MODEL || process.env.CEREBRAS_MODEL || "";
  const baseURL = (
    file.CEREBRAS_BASE_URL ||
    process.env.CEREBRAS_BASE_URL ||
    "https://api.cerebras.ai/v1"
  ).replace(/\/$/, "");
  return {
    key,
    model,
    baseURL,
    mode: key && model ? ("cerebras" as const) : ("local" as const),
    incomplete: Boolean(key) !== Boolean(model),
  };
}
