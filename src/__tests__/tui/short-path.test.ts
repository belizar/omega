import { describe, it, expect } from "vitest";
import { shortenPath } from "../../tui/components/display-text.js";

const CWD = "/Users/b/Workspace/omega/master";
const HOME = "/Users/b";

describe("shortenPath", () => {
  it("relativiza al cwd los paths de adentro", () => {
    expect(shortenPath(`${CWD}/src/tools/read.ts`, CWD, HOME)).toBe("src/tools/read.ts");
  });

  it("el cwd exacto es '.'", () => {
    expect(shortenPath(CWD, CWD, HOME)).toBe(".");
  });

  it("usa ~ para paths bajo el home (fuera del cwd)", () => {
    expect(shortenPath(`${HOME}/notes.md`, CWD, HOME)).toBe("~/notes.md");
    expect(shortenPath(HOME, CWD, HOME)).toBe("~");
  });

  it("colapsa a padre/archivo un path largo lejos del cwd (el caso reportado)", () => {
    const p = `${HOME}/Workspace/medra/medra-functions/feat/MED-992-incident-SLA/packages/shared/thread-messages/persist-event.ts`;
    expect(shortenPath(p, CWD, HOME)).toBe("thread-messages/persist-event.ts");
  });

  it("colapsa también un relativo-al-cwd largo", () => {
    const p = `${CWD}/packages/shared/thread-messages/persist-event.ts`;
    expect(shortenPath(p, CWD, HOME)).toBe("thread-messages/persist-event.ts");
  });

  it("deja igual los paths cortos", () => {
    expect(shortenPath(`${CWD}/index.ts`, CWD, HOME)).toBe("index.ts");
    expect(shortenPath(`${CWD}/a/b/c.ts`, CWD, HOME)).toBe("a/b/c.ts");
  });

  it("distingue archivos homónimos por su carpeta contenedora", () => {
    const a = `${HOME}/Workspace/medra/medra-functions/feat/x/packages/incident-sla-cron/index.ts`;
    const b = `${HOME}/Workspace/medra/medra-functions/feat/x/packages/shared/thread-messages/index.ts`;
    expect(shortenPath(a, CWD, HOME)).toBe("incident-sla-cron/index.ts");
    expect(shortenPath(b, CWD, HOME)).toBe("thread-messages/index.ts");
  });

  it("colapsa un absoluto largo fuera del home", () => {
    expect(shortenPath("/var/lib/something/deep/nested/path/file.ts", CWD, HOME)).toBe("path/file.ts");
  });
});
