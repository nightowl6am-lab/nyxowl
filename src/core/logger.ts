export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  component: string;
  msg: string;
  meta?: Record<string, unknown>;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class Logger {
  private readonly component: string;
  private readonly minLevel: LogLevel;

  constructor(component: string, minLevel?: LogLevel) {
    this.component = component;
    const envLevel = process.env["NYXOWL_LOG_LEVEL"] as LogLevel | undefined;
    this.minLevel =
      minLevel ?? (envLevel && envLevel in LEVEL_PRIORITY ? envLevel : "info");
  }

  public debug(msg: string, meta?: Record<string, unknown>): void {
    this.write("debug", msg, meta);
  }

  public info(msg: string, meta?: Record<string, unknown>): void {
    this.write("info", msg, meta);
  }

  public warn(msg: string, meta?: Record<string, unknown>): void {
    this.write("warn", msg, meta);
  }

  public error(msg: string, meta?: Record<string, unknown>): void {
    this.write("error", msg, meta);
  }

  private write(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.minLevel]) {
      return;
    }
    if (process.env["NYXOWL_SILENT"] === "1") {
      return;
    }
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      component: this.component,
      msg,
      ...(meta !== undefined ? { meta } : {}),
    };
    // Stdout carries MCP protocol only; all logs MUST go to stderr (§6).
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  }
}

export function createLogger(component: string, minLevel?: LogLevel): Logger {
  return new Logger(component, minLevel);
}
