import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";

enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  data?: unknown;
}

type LoggerOptions = {
  level?: LogLevel;
  logFile?: string;
  // Si es false (default), los logs NO van a la consola para no
  // contaminar el REPL. Se activa con LOG_CONSOLE=true para depurar.
  toConsole?: boolean;
};

class Logger {
  #level: LogLevel;
  #logs: LogEntry[] = [];
  #logFile?: string;
  #toConsole: boolean;
  #dirReady = false;

  constructor(options: LoggerOptions = {}) {
    this.#level = options.level ?? LogLevel.INFO;
    this.#logFile = options.logFile;
    this.#toConsole = options.toConsole ?? false;
  }

  #log(level: LogLevel, levelName: string, message: string, data?: unknown) {
    if (level < this.#level) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: levelName,
      message,
      data,
    };
    this.#logs.push(entry);

    const formatted = `[${entry.timestamp}] ${levelName}: ${message}${data !== undefined ? " " + JSON.stringify(data) : ""}`;

    if (this.#toConsole) {
      console.log(formatted);
    }
    if (this.#logFile) {
      this.#writeToFile(formatted);
    }
  }

  #writeToFile(line: string) {
    try {
      if (!this.#dirReady) {
        mkdirSync(dirname(this.#logFile!), { recursive: true });
        this.#dirReady = true;
      }
      appendFileSync(this.#logFile!, line + "\n", "utf-8");
    } catch {
      // Fallar silenciosamente: un error de logging no debe romper la app
    }
  }

  debug(message: string, data?: unknown) {
    this.#log(LogLevel.DEBUG, "DEBUG", message, data);
  }

  info(message: string, data?: unknown) {
    this.#log(LogLevel.INFO, "INFO", message, data);
  }

  warn(message: string, data?: unknown) {
    this.#log(LogLevel.WARN, "WARN", message, data);
  }

  error(message: string, data?: unknown) {
    this.#log(LogLevel.ERROR, "ERROR", message, data);
  }

  getLogs(): LogEntry[] {
    return this.#logs;
  }

  clearLogs() {
    this.#logs = [];
  }

  setLogFile(path: string): void {
    this.#logFile = path;
    this.#dirReady = false;
  }

  setConsole(enabled: boolean): void {
    this.#toConsole = enabled;
  }

  getStats(): {
    total: number;
    byLevel: Record<string, number>;
    oldestLog?: Date;
    newestLog?: Date;
  } {
    const byLevel: Record<string, number> = {
      DEBUG: 0,
      INFO: 0,
      WARN: 0,
      ERROR: 0,
    };

    for (const log of this.#logs) {
      byLevel[log.level]++;
    }

    return {
      total: this.#logs.length,
      byLevel,
      oldestLog: this.#logs[0] ? new Date(this.#logs[0].timestamp) : undefined,
      newestLog: this.#logs[this.#logs.length - 1]
        ? new Date(this.#logs[this.#logs.length - 1].timestamp)
        : undefined,
    };
  }
}

const logger = new Logger({
  level: LogLevel.INFO,
  toConsole: process.env.LOG_CONSOLE === "true",
});

export { Logger, logger, LogLevel };
