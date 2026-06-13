function truncate(text: string, maxLines = 200): string {
  const lines = text.split("\n");

  // 1. Si ya es chico, no tocamos nada
  if (lines.length <= maxLines) return text;

  // 2. Cuántas líneas guardamos de cada punta
  const keep = Math.floor(maxLines / 2);

  // 3. Las primeras `keep` y las últimas `keep`
  const head = lines.slice(0, keep);
  const tail = lines.slice(-keep);

  // 4. Cuántas quedaron afuera
  const omitted = lines.length - keep * 2;

  // 5. El cartel del medio
  const marker = `\n… [${omitted} líneas omitidas. Usá un comando más específico o read con offset/limit para ver más] …\n`;

  // 6. Rearmamos: head + cartel + tail
  return [...head, marker, ...tail].join("\n");
}

export { truncate };
