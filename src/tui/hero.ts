import { existsSync } from "fs";
import { bold, dim, green } from "./theme.js";
import { listMcpServers } from "../mcp/client.js";

interface HeroInfo {
  profile: string;
  model: string;
  visionModel: string | null;
  toolCount: number;
  mcpCount: number;
  projectName: string;
  hasAgentMd: boolean;
}

function logo(): string {
  // ASCII art del nombre "omega" — ~35 columnas, centrado en el espacio visible
  const art = [
    "  ___                            ",
    " /___\\_ __ ___   ___  __ _  __ _ ",
    "//  // '_ ` _ \\ / _ \\/ _` |/ _` |",
    "/ \\_//| | | | | |  __/ (_| | (_| |",
    "\\___/ |_| |_| |_|\\___|\\__, |\\__,_|",
    "                      |___/       ",
  ];

  const padLeft = 5; // margen izquierdo leve para separar del borde de terminal
  const indent  = " ".repeat(padLeft);

  const tag  = dim("tu asistente de coding en la terminal");
  const hint = dim("/help  ·  /setup");

  // Centrado relativo al arte (~35 cols)
  const artW = 35;

  const centre = (text: string, width: number): string => {
    const visible = text.replace(/\x1b\[[0-9;]*m/g, "").length;
    const left = Math.max(0, Math.floor((width - visible) / 2));
    return " ".repeat(left) + text;
  };

  const out: string[] = [""]; // línea en blanco arriba
  for (const line of art) {
    out.push(indent + line);
  }
  out.push("");
  out.push(indent + centre(tag, artW));
  out.push("");
  out.push(indent + centre(hint, artW));
  out.push("");
  return out.join("\n");
}

function infoBlock(info: HeroInfo): string {
  const lines: string[] = [];

  lines.push("");
  lines.push(`  ${bold("perfil")}    ${green(info.profile)}`);
  lines.push(`  ${bold("modelo")}    ${info.model}`);

  if (info.visionModel) {
    lines.push(`  ${bold("visión")}    ${info.visionModel}`);
  } else {
    lines.push(`  ${bold("visión")}    ${dim("no configurada")} ${dim("(/model vision <modelo>)")}`);
  }

  lines.push(`  ${bold("tools")}     ${info.toolCount} locales`);

  if (info.mcpCount > 0) {
    lines.push(`            + ${info.mcpCount} MCPs ${dim("(/mcp para ver)")}`);
  } else {
    lines.push(`            ${dim("sin MCPs configurados")} ${dim("(/mcp add ...)")}`);
  }

  if (info.hasAgentMd) {
    lines.push("");
    lines.push(`  ${dim("AGENT.md detectado — Omega conoce tu proyecto.")}`);
  }

  return lines.join("\n");
}

export function printHero(info: HeroInfo): void {
  console.log(logo());
  console.log(infoBlock(info));
  console.log(""); // blank line antes del prompt
}

/** Recolecta la info necesaria para el hero desde el estado actual. */
export function collectHeroInfo(config: {
  profile: string;
  model: string;
  visionModel: string | null;
  toolCount: number;
}): HeroInfo {
  const mcpServers = listMcpServers(process.cwd());
  const hasAgentMd = existsSync("AGENT.md");

  return {
    profile: config.profile,
    model: config.model,
    visionModel: config.visionModel,
    toolCount: config.toolCount,
    mcpCount: mcpServers.length,
    projectName: process.cwd().split("/").pop() ?? "proyecto",
    hasAgentMd,
  };
}