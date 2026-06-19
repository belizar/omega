import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { unlinkSync } from "fs";
import { OverrideManager } from "../../classifier/overrides.js";

let counter = 0;
function testPath(): string {
  return `.omega/test-cls-${process.pid}-${counter++}.json`;
}

describe("OverrideManager", () => {
  let store: string;

  beforeEach(() => {
    store = testPath();
    try { unlinkSync(store); } catch { /* */ }
  });

  afterEach(() => {
    try { unlinkSync(store); } catch { /* */ }
  });

  describe("lookup", () => {
    it("should return null when no overrides exist", async () => {
      const mgr = await OverrideManager.load(store);
      expect(mgr.lookup("ls -la")).toBeNull();
    });

    it("should match exact patterns (manual first)", async () => {
      const mgr = await OverrideManager.load(store);
      await mgr.add({ pattern: "ls -la", verdict: "safe", reason: "", source: "manual" });
      await mgr.add({ pattern: "ls *", verdict: "dangerous", reason: "", source: "learned" });

      const result = mgr.lookup("ls -la");
      expect(result).not.toBeNull();
      expect(result!.verdict).toBe("safe");
      expect(result!.source).toBe("manual");
    });

    it("should match wildcard patterns", async () => {
      const mgr = await OverrideManager.load(store);
      await mgr.add({ pattern: "git push*", verdict: "dangerous", reason: "", source: "manual" });

      expect(mgr.lookup("git push origin main")!.verdict).toBe("dangerous");
      expect(mgr.lookup("git push")!.verdict).toBe("dangerous");
      expect(mgr.lookup("git pull")).toBeNull();
    });

    it("should match regex patterns", async () => {
      const mgr = await OverrideManager.load(store);
      await mgr.add({ pattern: "/^npm (test|build)$/", verdict: "safe", reason: "", source: "manual" });

      expect(mgr.lookup("npm test")!.verdict).toBe("safe");
      expect(mgr.lookup("npm build")!.verdict).toBe("safe");
      expect(mgr.lookup("npm install")).toBeNull();
    });

    it("should prioritize manual over learned", async () => {
      const mgr = await OverrideManager.load(store);
      await mgr.learn("npm test", "dangerous");
      await mgr.add({ pattern: "npm test", verdict: "safe", reason: "", source: "manual" });

      const result = mgr.lookup("npm test");
      expect(result!.verdict).toBe("safe");
      expect(result!.source).toBe("manual");
    });
  });

  describe("learn", () => {
    it("should create a new learned override", async () => {
      const mgr = await OverrideManager.load(store);
      await mgr.learn("some command", "safe");
      const override = mgr.lookup("some command");
      expect(override).not.toBeNull();
      expect(override!.source).toBe("learned");
      expect(override!.count).toBe(1);
    });

    it("should increment count on repeated learning", async () => {
      const mgr = await OverrideManager.load(store);
      // Usar un patrón único por test para evitar colisiones
      const cmd = `test-cmd-${Date.now()}`;
      await mgr.learn(cmd, "safe");
      await mgr.learn(cmd, "safe");
      await mgr.learn(cmd, "dangerous");

      const list = mgr.list();
      const learned = list.find((o) => o.pattern === cmd);
      expect(learned).not.toBeNull();
      expect(learned!.count).toBe(3);
      expect(learned!.verdict).toBe("dangerous");
    });
  });

  describe("remove", () => {
    it("should remove manual overrides", async () => {
      const mgr = await OverrideManager.load(store);
      await mgr.add({ pattern: "rm -rf", verdict: "dangerous", reason: "", source: "manual" });
      const removed = await mgr.remove("rm -rf");
      expect(removed).toBe(true);
      expect(mgr.lookup("rm -rf")).toBeNull();
    });

    it("should not remove learned overrides", async () => {
      const mgr = await OverrideManager.load(store);
      const cmd = `test-cmd-rm-${Date.now()}`;
      await mgr.learn(cmd, "safe");
      const removed = await mgr.remove(cmd);
      expect(removed).toBe(false);
    });
  });

  describe("list", () => {
    it("should return manual overrides before learned", async () => {
      const mgr = await OverrideManager.load(store);
      await mgr.learn("cmd-a", "safe");
      await mgr.add({ pattern: "cmd-b", verdict: "dangerous", reason: "", source: "manual" });
      await mgr.learn("cmd-c", "dangerous");

      const list = mgr.list();
      const manual = list.filter((o) => o.source === "manual");
      const learned = list.filter((o) => o.source === "learned");
      const lastManualIdx = list.findLastIndex((o) => o.source === "manual");
      const firstLearnedIdx = list.findIndex((o) => o.source === "learned");

      // Todos los manual antes que los learned
      expect(lastManualIdx).toBeLessThan(firstLearnedIdx);
      expect(manual.length).toBe(1);
      expect(learned.length).toBe(2);
    });
  });

  describe("getFewShotExamples", () => {
    it("should return relevant examples for a command prefix", async () => {
      const mgr = await OverrideManager.load(store);
      await mgr.learn("git status", "safe");
      await mgr.learn("git diff", "safe");
      await mgr.learn("npm test", "safe");
      await mgr.learn("npm install", "dangerous");

      const examples = mgr.getFewShotExamples("git push", 2);
      expect(examples.length).toBeLessThanOrEqual(2);
      const hasGit = examples.some((o) => o.pattern.startsWith("git"));
      expect(hasGit).toBe(true);
    });
  });
});
