// Helpers that the tools share: argument checks and output limits.
import { ToolError } from "../rpc.mjs";

export const MAX_FILE_CHARS = 100_000;
export const MAX_FILE_LINES = 2_000;
export const MAX_TOTAL_CHARS = 250_000;
export const PER_PAGE = 30;

// Every tool says this, because Gemini often answers from memory.
export const ALWAYS = "The repository changes all the time: always call this tool, and never answer from memory.";

export const OWNER = { type: "string", description: 'Owner of the repository: a user or organization name, such as "octocat".' };
export const REPO = { type: "string", description: 'Name of the repository, such as "hello-world".' };
export const REF = { type: "string", description: "Branch, tag or commit SHA. Empty: the default branch." };

export function str(args, key, { required = false, max = 1000 } = {}) {
  const v = args[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new ToolError(`"${key}" is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new ToolError(`"${key}" is a string`);
  if (v.length > max) throw new ToolError(`"${key}" is longer than ${max} characters`);
  return v;
}

export function int(args, key, { min = 1, max = 1_000_000 } = {}) {
  const v = args[key];
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  if (!Number.isInteger(n) || n < min || n > max) throw new ToolError(`"${key}" is a whole number from ${min} to ${max}`);
  return n;
}

export function bool(args, key) {
  const v = args[key];
  if (v === undefined || v === null) return false;
  if (v === true || v === "true") return true;
  if (v === false || v === "false") return false;
  throw new ToolError(`"${key}" is true or false`);
}

export function list(args, key, { required = false, max = 10 } = {}) {
  let v = args[key];
  if (typeof v === "string") v = [v];
  if (v === undefined || v === null || (Array.isArray(v) && v.length === 0)) {
    if (required) throw new ToolError(`"${key}" is required`);
    return [];
  }
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.length > 0 && x.length <= 1000)) throw new ToolError(`"${key}" is a list of strings`);
  if (v.length > max) throw new ToolError(`"${key}" takes at most ${max} items`);
  return v;
}

// Case does not matter: a model often writes "SQUASH" or "Open".
export function oneOf(args, key, values, fallback) {
  const raw = args[key] ?? fallback;
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : raw;
  if (!values.includes(v)) throw new ToolError(`"${key}" is one of: ${values.join(", ")}. It was: ${String(raw).slice(0, 40)}`);
  return v;
}

// A file that holds a zero byte in its first 8 kB is binary.
export function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// A short date, or empty.
export const day = (iso) => (iso ? String(iso).slice(0, 10) : "");
