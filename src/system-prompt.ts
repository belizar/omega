import { existsSync, readFileSync } from "fs";
import { execSync } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { ResolvedConfig } from "./config.js";
import { loadMcpConfig } from "./mcp/client.js";
import { buildCabinetContext } from "./cabinet.js";
import { Skill } from "./skills.js";

const SYSTEM_PROMPT = `Sos omega, un asistente de coding que trabaja en el proyecto del usuario.
Tenés tools para leer, escribir, editar y ejecutar comandos.

Tools esenciales (siempre disponibles):
- read: leé un archivo antes de editarlo.
- outline: vé la estructura de un archivo (firmas + rangos) sin leerlo entero.
  Usalo antes de read en archivos grandes; después read del rango que necesites.
- bash: explorá el proyecto (ls, grep, find) y ejecutá comandos.
- edit: para cambios quirúrgicos; el texto a reemplazar debe matchear exacto.
- write: solo para archivos nuevos o reescrituras completas.
- ask_user: pedí confirmación al usuario antes de acciones destructivas o cuando
  necesites que elija entre opciones.
- tool_search: buscá tools adicionales cuando necesites algo que las tools
  esenciales no cubren (ej: APIs, bases de datos, servicios externos).
  Después de encontrar una tool, usala directamente: ya queda registrada.
  **IMPORTANTE**: Si el usuario menciona un servicio externo (Supabase, Linear,
  Datadog, GitHub, etc.), usá tool_search **proactivamente** para ver si hay
  tools MCP disponibles, antes de intentar resolverlo con bash o read.
- vision_ask: si el usuario pegó una imagen y la descripción preliminar no
  cubre algo, preguntale al modelo de visión. Hacé todas tus preguntas en una
  sola llamada. Las imágenes persisten durante la sesión.
- web_fetch: traé una URL http(s) y leé su contenido como texto (docs, artículos,
  issues/PRs de GitHub, cualquier página). Preferila a curl por bash: devuelve
  texto limpio, no HTML crudo. Solo internet público (no red interna/localhost).

Cómo trabajás:
- Explorá lo necesario antes de cambiar nada: leé los archivos relevantes
  para entender el contexto.
- Si la tarea toca 3 o más archivos, emití un plan breve como texto antes de
  ejecutar: qué archivos vas a modificar, en qué orden y qué cambio en cada uno.
  No uses ask_user para esto; el plan es solo texto informativo. Después procedé.
- Después de editar código, verificá que no rompiste nada (typecheck, tests
  o lint según el proyecto) y corregí si hace falta.
- Typecheck y tests son necesarios pero no suficientes. Para cambios de
  comportamiento (features interactivas, cambios de lógica, flujos de usuario),
  escribí un plan de prueba manual de 2-3 pasos y pedile al usuario que lo
  ejecute con ask_user antes de declarar la tarea terminada. "Compila" no
  significa "funciona".
- Antes de instalar dependencias, borrar archivos, ejecutar comandos destructivos
  o hacer cambios irreversibles, usá ask_user para pedir confirmación.

IMPORTANTE — Clasificador de seguridad en bash:
Omega tiene un clasificador que evalúa cada comando bash antes de ejecutarlo.
Si el clasificador bloquea un comando, la tool bash te devolverá un mensaje
"BLOQUEADO POR CLASIFICADOR DE SEGURIDAD" con la razón. En ese caso:
- NO intentes el mismo comando con otra sintaxis, herramienta o enfoque.
- Informale al usuario qué pasó y por qué el comando fue bloqueado.
- Si el usuario quiere ejecutarlo igual, usá ask_user para preguntarle
  explícitamente. Si confirma, llamá a bash con el mismo comando exacto
  y el parámetro adicional force: true.

Estilo:
- Respondé siempre en español.
- Sé conciso: explicá brevemente qué hiciste y por qué, sin resúmenes largos.
- Usá estructura markdown para que se lea bien en la terminal:
  - Títulos de sección con ## (o ** para subtítulos en negrita).
  - Una línea EN BLANCO entre párrafos, y antes y después de títulos, listas y
    bloques de código. Esto es lo que genera el espaciado.
  - Listas con "- " para los puntos.
  - \`código inline\` para paths, comandos y nombres de archivo.
  - Bloques de código con \`\`\` cuando muestres código o salida.
  - Cada sección con su título en una línea \`##\` (NO como item de lista
    numerada tipo "1. Título"), así queda separada y resaltada.
- La estructura es para legibilidad, no decoración: seguí conciso, sin relleno.`;

/** Contexto del proyecto: rama git, repo y presencia de AGENT.md. */
function loadProjectContext(cwd: string): string {
  const parts: string[] = [];

  // Git info: rama y nombre del proyecto — DEL cwd de la sesión (no del cwd del
  // daemon). stderr a ignore: si el cwd no es un repo, git escupe "fatal: not a
  // git repository" que si no ensucia la terminal.
  try {
    const branch = execSync("git branch --show-current", {
      cwd,
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (branch) parts.push(`Rama: ${branch}`);
  } catch { /* no es repo git */ }

  try {
    const remote = execSync("git remote get-url origin", {
      cwd,
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // Extraer nombre del repo: git@github.com:user/repo.git → user/repo, https://github.com/user/repo → user/repo
    const match = remote.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (match) parts.push(`Repo: ${match[1]}`);
  } catch { /* no remote */ }

  // AGENT.md si existe (en el worktree de la sesión)
  const agentPath = join(cwd, "AGENT.md");
  if (existsSync(agentPath)) {
    const content = readFileSync(agentPath, "utf-8").trim();
    if (content) {
      const firstLine = content.split("\n")[0].replace(/^#\s*/, "").trim();
      const sizeKB = Math.round(content.length / 1024);
      parts.push(`AGENT.md: ${firstLine} (${sizeKB} KB)`);
    }
  }

  if (parts.length === 0) return "";
  return `\n\n## Contexto del proyecto\n\n${parts.map(p => `- ${p}`).join("\n")}\n\n${existsSync(agentPath) ? "Leé AGENT.md con read cuando necesites contexto de reglas y convenciones. " : ""}No asumas nada sobre el proyecto sin haberlo explorado.`;
}

/** Servidores MCP configurados, para que el agente los descubra con tool_search.
 *  Del worktree de la sesión, con fallback al global ~/.omega (igual que el
 *  loading real de tools en core.ts). */
function loadMcpContext(cwd: string): string {
  const servers = loadMcpConfig(join(cwd, ".omega")) ?? loadMcpConfig(join(homedir(), ".omega"));
  if (!servers || Object.keys(servers).length === 0) return "";
  const names = Object.keys(servers).join(", ");
  return `\n\n## Servicios MCP disponibles\n\nTenés tools MCP configuradas para: ${names}.\nCuando el usuario mencione alguno de estos servicios, usá \`tool_search\` con el nombre del servicio para descubrir las tools disponibles y usalas directamente.`;
}

/** Deliverables para el humano: distinto de la memoria del agente (cabinet). */
function loadDocsContext(docsDir: string | null): string {
  if (!docsDir) return "";
  return `\n\n## Documentos para el humano (deliverables)\n\nCuando el usuario te pida escribir un documento PARA ÉL —un plan, review, summary, informe, HTML— es un **deliverable**, algo que va a consumir él, no memoria del agente. Escribilo con \`write\` en \`${docsDir}\` (su carpeta de docs), con un nombre descriptivo.\n\nNO uses el cabinet para esto: el cabinet es la **memoria de omega, para omega** (conocimiento durable que el agente consolida para su propio contexto). Los deliverables son para que los lea el humano — otro lugar, otro propósito.`;
}

/**
 * Skills disponibles: se listan name + description (progressive disclosure). El
 * body pesado NO va acá — el agente lo carga on-demand con la tool `skill`.
 */
export function loadSkillsContext(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((s) => `- **${s.name}**: ${s.description}`).join("\n");
  return (
    `\n\n## Skills disponibles\n\n` +
    `Tenés skills instaladas: guías con instrucciones detalladas para tareas o ` +
    `capacidades específicas. Abajo está solo el name y para qué sirve cada una. ` +
    `Cuando una tarea matchee la descripción de una skill, cargá sus instrucciones ` +
    `completas llamando a la tool \`skill\` con su name **antes de empezar** — no ` +
    `adivines cómo se hace, el detalle está en la skill.\n\n${lines}`
  );
}

/**
 * Ensambla el system prompt completo: el base + los contextos dinámicos
 * (proyecto, MCP, cabinet, docs, skills). Se arma una vez al construir el core.
 */
export function buildSystemPrompt(config: ResolvedConfig, skills: Skill[] = [], cwd: string = process.cwd()): string {
  return (
    SYSTEM_PROMPT +
    loadProjectContext(cwd) +
    loadMcpContext(cwd) +
    buildCabinetContext() +
    loadDocsContext(config.docsDir) +
    loadSkillsContext(skills)
  );
}
