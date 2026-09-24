import type { LogLevel } from "./config.js";

/** Numeric severity ordering used for log filtering. */
const priorities: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Receives one structured log entry. */
export type LogWriter = (entry: Record<string, unknown>) => void;

/** Structured logger with plain failure reporting. */
export interface Logger {
  (entryLevel: LogLevel, event: string, fields?: Record<string, unknown>): void;
  failure(event: string, fields: Record<string, unknown>, error: unknown): void;
}

/** Creates one envelope shared by startup and configured logging. */
function entry(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return { time: new Date().toISOString(), level, event, ...fields };
}

/** Formats failures without copying stacks or other Error properties. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Writes an unconfigured startup failure using the standard log envelope. */
export function writeStartupError(error: unknown): void {
  defaultWriter(entry("error", "startup_failed", { error: errorText(error) }));
}

/** Creates a callable logger and attaches its failure-reporting operation. */
export function createLogger(
  level: LogLevel,
  write: LogWriter = defaultWriter,
): Logger {
  const threshold = priorities[level];
  const log = (
    severity: LogLevel,
    event: string,
    fields: Record<string, unknown> = {},
  ): void => {
    if (priorities[severity] >= threshold)
      write(entry(severity, event, fields));
  };
  return Object.assign(log, {
    failure(
      event: string,
      fields: Record<string, unknown>,
      error: unknown,
    ): void {
      log("error", event, { ...fields, error: errorText(error) });
    },
  });
}

/** Writes one JSON record per line to stderr. */
function defaultWriter(value: Record<string, unknown>): void {
  process.stderr.write(JSON.stringify(value) + "\n");
}
