import { describe, it, expect } from "vitest";
import { WebFetchTool, htmlToText } from "../../tools/web-fetch.js";

describe("htmlToText", () => {
  it("saca tags y deja el texto", () => {
    expect(htmlToText("<p>Hola <b>mundo</b></p>")).toBe("Hola mundo");
  });

  it("descarta script/style/head", () => {
    const html = "<head><title>t</title></head><body><style>.x{}</style><script>evil()</script><p>visible</p></body>";
    const out = htmlToText(html);
    expect(out).toContain("visible");
    expect(out).not.toContain("evil");
    expect(out).not.toContain(".x{}");
  });

  it("mapea bloques a saltos de línea", () => {
    expect(htmlToText("<h1>Título</h1><p>uno</p><p>dos</p>")).toBe("Título\nuno\ndos");
  });

  it("convierte <li> en bullets", () => {
    expect(htmlToText("<ul><li>a</li><li>b</li></ul>")).toContain("- a");
  });

  it("decodifica entidades nombradas y numéricas", () => {
    expect(htmlToText("<p>a &amp; b &lt;c&gt; &#233; &#x41;</p>")).toBe("a & b <c> é A");
  });

  it("colapsa espacios y saltos de más", () => {
    expect(htmlToText("<p>a    b</p>\n\n\n\n<p>c</p>")).toBe("a b\n\nc");
  });
});

describe("WebFetchTool — validación y guarda SSRF (sin red)", () => {
  const tool = new WebFetchTool();

  it("rechaza URLs inválidas", async () => {
    expect(await tool.execute({ url: "no soy una url" })).toContain("URL inválida");
  });

  it("rechaza esquemas que no son http(s)", async () => {
    expect(await tool.execute({ url: "ftp://ejemplo.com/x" })).toContain("solo se permiten URLs http(s)");
    expect(await tool.execute({ url: "file:///etc/passwd" })).toContain("solo se permiten URLs http(s)");
  });

  it("bloquea localhost", async () => {
    const out = await tool.execute({ url: "http://localhost:8080/admin" });
    expect(out).toContain("bloqueado");
    expect(out).toContain("localhost");
  });

  it("bloquea la metadata de la nube (169.254.169.254)", async () => {
    const out = await tool.execute({ url: "http://169.254.169.254/latest/meta-data/" });
    expect(out).toContain("bloqueado");
  });

  it("bloquea rangos privados (10/8, 172.16/12, 192.168/16, 127/8)", async () => {
    for (const ip of ["10.0.0.5", "172.16.9.1", "192.168.1.1", "127.0.0.1"]) {
      const out = await tool.execute({ url: `http://${ip}/` });
      expect(out, ip).toContain("bloqueado");
    }
  });

  it("bloquea loopback IPv6", async () => {
    const out = await tool.execute({ url: "http://[::1]:9000/" });
    expect(out).toContain("bloqueado");
  });
});
