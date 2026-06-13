import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Logger, LogLevel } from "../logger.js";

describe("Logger", () => {
  let logger: Logger;
  let consoleSpy: any;

  beforeEach(() => {
    // toConsole: true para poder verificar la salida a consola
    logger = new Logger({ level: LogLevel.DEBUG, toConsole: true });
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("should log debug messages", () => {
    logger.debug("Debug message");
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("DEBUG: Debug message"),
    );
  });

  it("should log info messages", () => {
    logger.info("Info message");
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("INFO: Info message"),
    );
  });

  it("should log warn messages", () => {
    logger.warn("Warning message");
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("WARN: Warning message"),
    );
  });

  it("should log error messages", () => {
    logger.error("Error message");
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("ERROR: Error message"),
    );
  });

  it("should NOT log to console by default (REPL stays clean)", () => {
    const silent = new Logger({ level: LogLevel.DEBUG });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    silent.info("Should not reach console");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("should include data in log output", () => {
    const data = { key: "value" };
    logger.info("Message with data", data);
    expect(consoleSpy).toHaveBeenCalled();
  });

  it("should store logs in memory", () => {
    logger.info("First message");
    logger.warn("Second message");
    const logs = logger.getLogs();
    expect(logs).toHaveLength(2);
    expect(logs[0].message).toBe("First message");
    expect(logs[1].message).toBe("Second message");
  });

  it("should clear logs", () => {
    logger.info("Message");
    expect(logger.getLogs()).toHaveLength(1);
    logger.clearLogs();
    expect(logger.getLogs()).toHaveLength(0);
  });

  it("should respect log level filtering", () => {
    const infoLogger = new Logger({ level: LogLevel.INFO, toConsole: true });
    const consoleSpy2 = vi.spyOn(console, "log").mockImplementation(() => {});
    infoLogger.debug("Debug message");
    expect(consoleSpy2).not.toHaveBeenCalled();
    consoleSpy2.mockRestore();
  });

  it("should include timestamp in logs", () => {
    logger.info("Timestamped message");
    const logs = logger.getLogs();
    expect(logs[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("should write logs to a file when configured", () => {
    const path = join(tmpdir(), `omega-test-${process.pid}.log`);
    if (existsSync(path)) rmSync(path);
    try {
      const fileLogger = new Logger({ level: LogLevel.INFO, logFile: path });
      fileLogger.info("Persisted line", { n: 1 });
      fileLogger.error("Another line");

      const contents = readFileSync(path, "utf-8");
      expect(contents).toContain("INFO: Persisted line");
      expect(contents).toContain('{"n":1}');
      expect(contents).toContain("ERROR: Another line");
      // dos llamadas => dos lineas
      expect(contents.trim().split("\n")).toHaveLength(2);
    } finally {
      if (existsSync(path)) rmSync(path);
    }
  });
});
