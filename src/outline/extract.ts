import { readFileSync, readdirSync } from "fs";
import { extname, join } from "path";
import ts from "typescript";

// ── Helpers ──────────────────────────────────────────────────────────

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function scriptKindFor(ext: string): ts.ScriptKind | null {
  if (ext === ".tsx") return ts.ScriptKind.TSX;
  if (ext === ".ts") return ts.ScriptKind.TS;
  if (ext === ".jsx") return ts.ScriptKind.JSX;
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return ts.ScriptKind.JS;
  return null;
}

function modifierString(node: ts.Node): string {
  const modifiers = (node as any).modifiers as
    | readonly ts.ModifierLike[]
    | undefined;
  if (!modifiers) return "";
  let out = "";
  for (const mod of modifiers) {
    switch (mod.kind) {
      case ts.SyntaxKind.ExportKeyword:
        out += "export ";
        break;
      case ts.SyntaxKind.DefaultKeyword:
        out += "default ";
        break;
      case ts.SyntaxKind.AsyncKeyword:
        out += "async ";
        break;
      case ts.SyntaxKind.StaticKeyword:
        out += "static ";
        break;
      case ts.SyntaxKind.PrivateKeyword:
        out += "private ";
        break;
      case ts.SyntaxKind.ProtectedKeyword:
        out += "protected ";
        break;
      case ts.SyntaxKind.PublicKeyword:
        out += "public ";
        break;
      case ts.SyntaxKind.ReadonlyKeyword:
        out += "readonly ";
        break;
      case ts.SyntaxKind.AbstractKeyword:
        out += "abstract ";
        break;
      case ts.SyntaxKind.DeclareKeyword:
        out += "declare ";
        break;
    }
  }
  return out;
}

function renderSignature(
  node:
    | ts.FunctionDeclaration
    | ts.MethodDeclaration
    | ts.ConstructorDeclaration
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration,
  sf: ts.SourceFile,
): string {
  let name: string;
  if (ts.isConstructorDeclaration(node)) {
    name = "constructor";
  } else if (ts.isGetAccessorDeclaration(node)) {
    name = `get ${oneLine(node.name.getText(sf))}`;
  } else if (ts.isSetAccessorDeclaration(node)) {
    name = `set ${oneLine(node.name.getText(sf))}`;
  } else {
    name = oneLine(node.name?.getText(sf) ?? "(anonymous)");
  }

  const params = node.parameters
    .map((p) => {
      const pName = oneLine(p.name.getText(sf));
      const pType = p.type ? `: ${oneLine(p.type.getText(sf))}` : "";
      return `${pName}${pType}`;
    })
    .join(", ");

  // Return type: getters no tienen return type explícito (el type es el tipo
  // de retorno inferido), setters no tienen. Para el resto: node.type.
  let returnType = "";
  if (
    !ts.isGetAccessorDeclaration(node) &&
    !ts.isSetAccessorDeclaration(node) &&
    node.type
  ) {
    returnType = `: ${oneLine(node.type.getText(sf))}`;
  }

  return `${name}(${params})${returnType}`;
}

// ── Statement rendering ──────────────────────────────────────────────

function renderStatement(
  stmt: ts.Statement,
  sf: ts.SourceFile,
  indent: number,
  rangeOf: (n: ts.Node) => string,
): string | null {
  const prefix = " ".repeat(indent);
  const mods = modifierString(stmt);

  if (ts.isClassDeclaration(stmt)) {
    const name = stmt.name?.getText(sf) ?? "(anonymous)";
    const lines: string[] = [
      `${prefix}${mods}class ${name} ${rangeOf(stmt)}`,
    ];
    for (const member of stmt.members) {
      const memberLine = renderMember(member, sf, indent + 2, rangeOf);
      if (memberLine) lines.push(memberLine);
    }
    return lines.join("\n");
  }

  if (ts.isFunctionDeclaration(stmt)) {
    return `${prefix}${mods}${renderSignature(stmt, sf)} ${rangeOf(stmt)}`;
  }

  if (ts.isInterfaceDeclaration(stmt)) {
    return `${prefix}${mods}interface ${stmt.name.getText(sf)} ${rangeOf(stmt)}`;
  }

  if (ts.isTypeAliasDeclaration(stmt)) {
    return `${prefix}${mods}type ${stmt.name.getText(sf)} ${rangeOf(stmt)}`;
  }

  if (ts.isEnumDeclaration(stmt)) {
    return `${prefix}${mods}enum ${stmt.name.getText(sf)} ${rangeOf(stmt)}`;
  }

  if (ts.isVariableStatement(stmt)) {
    const decls = stmt.declarationList.declarations.map((d) => {
      const dName = oneLine(d.name.getText(sf));
      const dType = d.type ? `: ${oneLine(d.type.getText(sf))}` : "";
      return `${dName}${dType}`;
    });
    const kw = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0
      ? "const"
      : (stmt.declarationList.flags & ts.NodeFlags.Let) !== 0
      ? "let"
      : "var";
    return `${prefix}${mods}${kw} ${decls.join(", ")} ${rangeOf(stmt)}`;
  }

  return null; // otros: ignorar
}

function renderMember(
  member: ts.ClassElement,
  sf: ts.SourceFile,
  indent: number,
  rangeOf: (n: ts.Node) => string,
): string | null {
  const prefix = " ".repeat(indent);
  const mods = modifierString(member);

  if (
    ts.isMethodDeclaration(member) ||
    ts.isConstructorDeclaration(member) ||
    ts.isGetAccessorDeclaration(member) ||
    ts.isSetAccessorDeclaration(member)
  ) {
    return `${prefix}${mods}${renderSignature(member, sf)} ${rangeOf(member)}`;
  }

  if (ts.isPropertyDeclaration(member)) {
    const name = oneLine(member.name.getText(sf));
    if (member.type) {
      return `${prefix}${mods}${name}: ${oneLine(member.type.getText(sf))} ${rangeOf(member)}`;
    }
    return `${prefix}${mods}${name} ${rangeOf(member)}`;
  }

  return null;
}

// ── Public API ───────────────────────────────────────────────────────

export function outlineFile(path: string, content: string): string {
  const ext = extname(path);
  const kind = scriptKindFor(ext);
  if (kind === null) {
    return `outline: ${path} no es un archivo TS/JS (solo .ts, .tsx, .js, .jsx, .mjs, .cjs)`;
  }

  const sf = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    kind,
  );

  const lineOf = (pos: number) =>
    sf.getLineAndCharacterOfPosition(pos).line + 1;
  const rangeOf = (node: ts.Node) =>
    `[${lineOf(node.getStart(sf))}-${lineOf(node.getEnd())}]`;

  const totalLines = content.split("\n").length;
  const lines: string[] = [`${path} · ${totalLines} líneas`];

  let i = 0;

  // Agrupar imports consecutivos del tope
  const importModules: string[] = [];
  let importStart = 0;
  let importEnd = 0;

  for (; i < sf.statements.length; i++) {
    const stmt = sf.statements[i];
    if (ts.isImportDeclaration(stmt)) {
      if (importModules.length === 0) {
        importStart = lineOf(stmt.getStart(sf));
      }
      importEnd = lineOf(stmt.getEnd());
      importModules.push((stmt.moduleSpecifier as ts.StringLiteral).text);
    } else {
      break;
    }
  }

  if (importModules.length > 0) {
    lines.push(
      `  imports: ${importModules.join(", ")}   [${importStart}-${importEnd}]`,
    );
  }

  // Resto de statements
  for (; i < sf.statements.length; i++) {
    const line = renderStatement(sf.statements[i], sf, 2, rangeOf);
    if (line) lines.push(line);
  }

  return lines.join("\n");
}

export function outlineDir(dirPath: string): string {
  const entries = readdirSync(dirPath, { withFileTypes: true });
  const tsFiles: string[] = [];
  const subdirs: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      subdirs.push(entry.name);
    } else if (entry.isFile() && scriptKindFor(extname(entry.name)) !== null) {
      tsFiles.push(entry.name);
    }
  }

  tsFiles.sort();
  subdirs.sort();

  const lines: string[] = [`${dirPath} · ${tsFiles.length} archivos`];

  for (const file of tsFiles) {
    const fullPath = join(dirPath, file);
    const content = readFileSync(fullPath, "utf-8");
    const kind = scriptKindFor(extname(file))!;

    const sf = ts.createSourceFile(
      fullPath,
      content,
      ts.ScriptTarget.Latest,
      true,
      kind,
    );

    const exports: string[] = [];
    for (const stmt of sf.statements) {
      const mods = (stmt as any).modifiers as
        | readonly ts.ModifierLike[]
        | undefined;
      if (!mods) continue;
      const isExport = mods.some(
        (m) => m.kind === ts.SyntaxKind.ExportKeyword,
      );
      if (!isExport) continue;

      if (ts.isClassDeclaration(stmt) && stmt.name) {
        exports.push(`class ${stmt.name.getText(sf)}`);
      } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        exports.push(`function ${stmt.name.getText(sf)}`);
      } else if (ts.isInterfaceDeclaration(stmt)) {
        exports.push(`interface ${stmt.name.getText(sf)}`);
      } else if (ts.isTypeAliasDeclaration(stmt)) {
        exports.push(`type ${stmt.name.getText(sf)}`);
      } else if (ts.isEnumDeclaration(stmt)) {
        exports.push(`enum ${stmt.name.getText(sf)}`);
      } else if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          exports.push(`const ${decl.name.getText(sf)}`);
        }
      }
    }

    const exportStr =
      exports.length > 0 ? `    ${exports.join(", ")}` : "";
    lines.push(`  ${file}${exportStr}`);
  }

  const subdirStr =
    subdirs.length > 0
      ? `(subdirs: ${subdirs.join(", ")})`
      : "(sin subdirs)";
  lines.push(`  ${subdirStr}`);

  return lines.join("\n");
}