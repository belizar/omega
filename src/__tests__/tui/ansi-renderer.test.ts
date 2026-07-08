import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AnsiRenderer } from "../../tui/markdown/ansi-renderer.js";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const vis = (s: string) => [...stripAnsi(s)].length; // contenido de test sin wide chars

describe("AnsiRenderer.table — ancho para no romper en printAbove", () => {
  const origCols = process.stdout.columns;

  beforeEach(() => {
    // Ancho de terminal fijo para el test.
    Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process.stdout, "columns", { value: origCols, configurable: true });
  });

  // La tabla del bug: 3 columnas, celdas largas que antes se re-partían.
  const headers = ["Aspecto", "#831", "#845"];
  const rows = [
    ["Parámetro de filtro", "`p_commercial_flow_keys UUID[]`", "`p_commercial_flows TEXT[]`"],
    ["Cómo filtra", "`dcf.commercial_flow_key = ANY(...)` vía JOIN a `dim_commercial_flow`", "`t.current_commercial_flow` directo"],
    ["Columna de salida `current_commercial_flow TEXT`", "No agrega", "Agrega"],
    ["Email service", "Lo toca (agrega `commercialFlowKeys`)", "No lo toca"],
  ];
  const aligns = ["left", "left", "left"] as const;

  it("respeta columns - reserved: ninguna línea excede el ancho que printAbove permite", () => {
    const reserved = 22; // screenPadding(20) + indent(2)
    const out = new AnsiRenderer(reserved).table(headers, rows, [...aligns]);
    const max = 100 - reserved; // 78
    for (const linteral of out.split("\n")) {
      expect(vis(linteral)).toBeLessThanOrEqual(max);
    }
  });

  it("todas las líneas tienen el mismo ancho visible (bordes alineados)", () => {
    const out = new AnsiRenderer(22).table(headers, rows, [...aligns]);
    const lines = out.split("\n");
    const w = vis(lines[0]);
    for (const linteral of lines) expect(vis(linteral)).toBe(w);
  });

  it("con reserved chico usa más ancho (el margen se respeta de verdad)", () => {
    const wide = new AnsiRenderer(4).table(headers, rows, [...aligns]);
    const narrow = new AnsiRenderer(22).table(headers, rows, [...aligns]);
    expect(vis(wide.split("\n")[0])).toBeGreaterThan(vis(narrow.split("\n")[0]));
    // Y con margen chico entra en columns-4 = 96.
    for (const linteral of wide.split("\n")) expect(vis(linteral)).toBeLessThanOrEqual(96);
  });
});
