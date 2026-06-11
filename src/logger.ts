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

class Logger {
  #level: LogLevel;
  #logs: LogEntry[] = [];

  constructor(level: LogLevel = LogLevel.INFO) {
    this.#level = level;
  }

  #log(level: LogLevel, levelName: string, message: string, data?: unknown) {
    if (level >= this.#level) {
      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        level: levelName,
        message,
        data,
      };
      this.#logs.push(entry);
      console.log(`[${entry.timestamp}] ${levelName}: ${message}`, data ? data : "");
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
}

const logger = new Logger(LogLevel.INFO);

export { Logger, LogLevel, logger };
