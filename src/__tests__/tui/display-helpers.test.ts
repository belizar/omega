import { describe, it, expect } from "vitest";
import { shortenPath, toolBrief } from "../../tui/components/display-text.js";

const CWD = "/Users/b/Workspace/omega/master";
const HOME = "/Users/b";

describe("shortenPath", () => {
  it("relativiza al cwd", () => {
    expect(shortenPath(`${CWD}/src/read.ts`, CWD, HOME)).toBe("src/read.ts");
  });
  it("~ para el home", () => {
    expect(shortenPath(`${HOME}/notes.md`, CWD, HOME)).toBe("~/notes.md");
  });
  it("colapsa a padre/archivo un path largo lejano", () => {
    const p = `${HOME}/Workspace/medra/medra-functions/feat/MED-992-incident-SLA/packages/shared/thread-messages/persist-event.ts`;
    expect(shortenPath(p, CWD, HOME)).toBe("thread-messages/persist-event.ts");
  });
  it("deja cortos igual", () => {
    expect(shortenPath(`${CWD}/index.ts`, CWD, HOME)).toBe("index.ts");
  });
});

describe("toolBrief (label del spinner)", () => {
  it("bash: comando compacto y truncado", () => {
    const b = toolBrief("bash", { command: "npm run build && npm test -- --reporter verbose" });
    expect(b.startsWith("bash npm run build")).toBe(true);
    expect(b.length).toBeLessThanOrEqual(33);
  });
  it("web_fetch: solo el hostname", () => {
    expect(toolBrief("web_fetch", { url: "https://docs.anthropic.com/en/x" })).toBe("web_fetch docs.anthropic.com");
  });
  it("grep: el patrón", () => {
    expect(toolBrief("grep", { pattern: "TODO" })).toBe("grep TODO");
  });
  it("tool desconocida: el nombre pelado", () => {
    expect(toolBrief("mcp_something", {})).toBe("mcp_something");
  });
});
