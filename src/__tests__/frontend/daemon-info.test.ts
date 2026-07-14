import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  writeDaemonInfo,
  readDaemonInfo,
  clearDaemonInfo,
  isAlive,
  DaemonInfo,
} from "../../frontend/daemon/daemon-info.js";

describe("daemon-info", () => {
  let dir: string;
  let path: string;

  const sample: DaemonInfo = {
    pid: 12345,
    port: 4477,
    cwd: "/tmp/proj",
    bin: "/tmp/proj/dist/index.js",
    startedAt: 1_700_000_000_000,
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "omega-di-"));
    path = join(dir, "daemon.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("write → read hace roundtrip del registro", async () => {
    writeDaemonInfo(sample, path);
    expect(readDaemonInfo(path)).toEqual(sample);
    // Y quedó como JSON legible en disco.
    const raw = JSON.parse(await readFile(path, "utf-8"));
    expect(raw.pid).toBe(12345);
  });

  it("read de un archivo inexistente devuelve null (no tira)", () => {
    expect(readDaemonInfo(join(dir, "no-existe.json"))).toBeNull();
  });

  it("clear borra el registro y read vuelve a null", () => {
    writeDaemonInfo(sample, path);
    expect(existsSync(path)).toBe(true);
    clearDaemonInfo(path);
    expect(existsSync(path)).toBe(false);
    expect(readDaemonInfo(path)).toBeNull();
  });

  it("clear de algo que no existe es no-op (no tira)", () => {
    expect(() => clearDaemonInfo(join(dir, "no-existe.json"))).not.toThrow();
  });

  it("isAlive: true para nuestro propio pid, false para uno inventado", () => {
    expect(isAlive(process.pid)).toBe(true);
    // Un pid altísimo que casi seguro no existe.
    expect(isAlive(2 ** 30)).toBe(false);
  });
});
