import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Logger, LogLevel } from "../logger.js";

describe("Logger", () => {
  let logger: Logger;
  let consoleSpy: any;

  beforeEach(() => {
    logger = new Logger(LogLevel.DEBUG);
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("should log debug messages", () => {
    logger.debug("Debug message");
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("DEBUG: Debug message"),
      "",
    );
  });

  it("should log info messages", () => {
    logger.info("Info message");
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("INFO: Info message"),
      "",
    );
  });

  it("should log warn messages", () => {
    logger.warn("Warning message");
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("WARN: Warning message"),
      "",
    );
  });

  it("should log error messages", () => {
    logger.error("Error message");
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("ERROR: Error message"),
      "",
    );
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
    const infoLogger = new Logger(LogLevel.INFO);
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
});
