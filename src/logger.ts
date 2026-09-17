/**
 * Structured, level-filtered logging for Kevin.
 *
 * Every line carries a timestamp, a level, the scope that emitted it, and
 * key=value fields. Secrets (Slack tokens, cookies, API keys) are redacted and
 * long values truncated so a debug run can be pasted somewhere safely.
 *
 * `LOG_LEVEL` selects verbosity (error < warn < info < debug < trace) and
 * `LOG_FORMAT=json` switches to one JSON object per line for log shippers.
 */

export const LOG_LEVELS = ["error", "warn", "info", "debug", "trace"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogFields = Record<string, unknown>;
export type LogFormat = "text" | "json";

const RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
const MAX_FIELD_CHARS = Number(process.env.LOG_MAX_FIELD) > 0 ? Number(process.env.LOG_MAX_FIELD) : 500;
const MAX_DEPTH = 4;
const MAX_ITEMS = 20;

/** Field names whose value is never printed, however it is spelled. */
const SECRET_KEY = /(^|_)(token|cookie|secret|password|passwd|credential|authorization|auth|apikey|key|xoxc|xoxd)(_|$)/;
/** camelCase, kebab-case, and header-style names all reduce to snake_case words. */
const normalizeKey = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();
/** Secret-shaped values that can turn up inside otherwise harmless strings. */
const SECRET_VALUE = /(xox[abcdeprs]-[A-Za-z0-9-]{8,}|xapp-[A-Za-z0-9-]{8,}|Bearer\s+[A-Za-z0-9._~+/-]{8,}=*|sk-[A-Za-z0-9._-]{12,}|(?<=d=)[A-Za-z0-9%._-]{16,})/g;

export const REDACTED = "[redacted]";

const parseLevel = (value: string | undefined, fallback: LogLevel): LogLevel => {
  const candidate = value?.trim().toLowerCase();
  return LOG_LEVELS.includes(candidate as LogLevel) ? (candidate as LogLevel) : fallback;
};

const parseFormat = (value: string | undefined, fallback: LogFormat): LogFormat => {
  const candidate = value?.trim().toLowerCase();
  return candidate === "json" || candidate === "text" ? candidate : fallback;
};

let currentLevel: LogLevel = parseLevel(process.env.LOG_LEVEL, "info");
let currentFormat: LogFormat = parseFormat(process.env.LOG_FORMAT, "text");

/** Applies a configured level; an unknown value leaves the current one in place. */
export const setLogLevel = (value: string | undefined) => (currentLevel = parseLevel(value, currentLevel));
export const getLogLevel = () => currentLevel;
export const setLogFormat = (value: string | undefined) => (currentFormat = parseFormat(value, currentFormat));
export const getLogFormat = () => currentFormat;
export const isLevelEnabled = (level: LogLevel) => RANK[level] <= RANK[currentLevel];

/** Shortens a value for logging without hiding that it was shortened. */
export const preview = (value: unknown, max = 200) => {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return text.length > max ? `${text.slice(0, max)}…(+${text.length - max})` : text;
};

const redactString = (value: string) => value.replace(SECRET_VALUE, REDACTED);

const truncate = (value: string) => (value.length > MAX_FIELD_CHARS ? `${value.slice(0, MAX_FIELD_CHARS)}…(+${value.length - MAX_FIELD_CHARS} chars)` : value);

/** Recursively strips secrets, bounds size, and makes values JSON-safe. */
export const sanitize = (value: unknown, key?: string, depth = 0): unknown => {
  if (key && SECRET_KEY.test(normalizeKey(key)) && value !== undefined && value !== null) return REDACTED;
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return truncate(redactString(value));
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return undefined;
  if (value instanceof Error) return describeError(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Map) return sanitize(Object.fromEntries(value), key, depth);
  if (value instanceof Set) return sanitize([...value], key, depth);
  if (depth >= MAX_DEPTH) return preview(safeJson(value), 120);
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((item) => sanitize(item, undefined, depth + 1));
    return value.length > MAX_ITEMS ? [...items, `…(+${value.length - MAX_ITEMS} more)`] : items;
  }
  if (typeof value === "object") {
    const out: LogFields = {};
    for (const [name, item] of Object.entries(value)) {
      const clean = sanitize(item, name, depth + 1);
      if (clean !== undefined) out[name] = clean;
    }
    return out;
  }
  return String(value);
};

const safeJson = (value: unknown) => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[unserializable]";
  }
};

/** Flattens an error (and its causes) into loggable fields. */
export const describeError = (error: unknown): LogFields => {
  if (!(error instanceof Error)) return { error: truncate(redactString(String(error))) };
  const fields: LogFields = { error: truncate(redactString(error.message)), errorType: error.name };
  const code = (error as NodeJS.ErrnoException).code;
  if (code) fields.errorCode = code;
  if (error.stack) fields.stack = truncate(redactString(error.stack));
  if (error.cause !== undefined) fields.cause = preview(redactString(error.cause instanceof Error ? error.cause.message : safeJson(error.cause)), 200);
  return fields;
};

/** Starts a stopwatch; the returned function reports elapsed milliseconds. */
export const timer = () => {
  const started = Date.now();
  return () => Date.now() - started;
};

const formatValue = (value: unknown) => {
  if (typeof value === "string") return /[\s"=]/.test(value) ? JSON.stringify(value) : value;
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return safeJson(value);
};

const formatText = (level: LogLevel, scope: string, message: string, fields: LogFields) => {
  const pairs = Object.entries(fields)
    .filter(([name]) => name !== "stack")
    .map(([name, value]) => `${name}=${formatValue(value)}`);
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${pairs.length ? ` ${pairs.join(" ")}` : ""}`;
  return typeof fields.stack === "string" ? `${line}\n${fields.stack}` : line;
};

const emit = (level: LogLevel, scope: string, message: string, fields: LogFields) => {
  if (!isLevelEnabled(level)) return;
  const clean = sanitize(fields) as LogFields;
  const line = currentFormat === "json"
    ? safeJson({ time: new Date().toISOString(), level, scope, message, ...clean })
    : formatText(level, scope, message, clean);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

export class Logger {
  constructor(readonly scope: string, private readonly base: LogFields = {}) {}

  /** A logger for a nested component, keeping this logger's bound fields. */
  child(scope: string, fields: LogFields = {}) {
    return new Logger(`${this.scope}.${scope}`, { ...this.base, ...fields });
  }

  /** The same scope with extra fields attached to every line (e.g. a channel). */
  with(fields: LogFields) {
    return new Logger(this.scope, { ...this.base, ...fields });
  }

  enabled(level: LogLevel) {
    return isLevelEnabled(level);
  }

  log(level: LogLevel, message: string, fields: LogFields = {}) {
    emit(level, this.scope, message, { ...this.base, ...fields });
  }

  error(message: string, fields: LogFields = {}) {
    this.log("error", message, fields);
  }

  warn(message: string, fields: LogFields = {}) {
    this.log("warn", message, fields);
  }

  info(message: string, fields: LogFields = {}) {
    this.log("info", message, fields);
  }

  debug(message: string, fields: LogFields = {}) {
    this.log("debug", message, fields);
  }

  trace(message: string, fields: LogFields = {}) {
    this.log("trace", message, fields);
  }

  /** Logs the failure of `error` with full error detail. */
  failure(message: string, error: unknown, fields: LogFields = {}) {
    this.log("error", message, { ...fields, ...describeError(error) });
  }

  /**
   * Times an async operation, logging its duration on success and the error on
   * failure. `describe` adds fields derived from the result (sizes, IDs).
   */
  async track<T>(message: string, run: () => Promise<T>, fields: LogFields = {}, describe?: (result: T) => LogFields): Promise<T> {
    const elapsed = timer();
    this.trace(`${message} started`, fields);
    try {
      const result = await run();
      this.debug(message, { ...fields, ...(describe?.(result) ?? {}), ms: elapsed() });
      return result;
    } catch (error) {
      this.failure(`${message} failed`, error, { ...fields, ms: elapsed() });
      throw error;
    }
  }
}

export const createLogger = (scope: string, fields: LogFields = {}) => new Logger(scope, fields);
export const logger = createLogger("kevin");
