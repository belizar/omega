import { CliArgs } from "../cli-args.js";
import { CoreServices } from "../core.js";
import { HeadlessMode } from "./headless-mode.js";
import { TuiMode } from "./tui-mode.js";

/**
 * Una composición del core con un frontend concreto: sabe montar su frontend y
 * correr su propio loop. Agregar un frontend nuevo (GitHub, Slack, HTTP) = una
 * clase más que implementa esto, elegida por `createMode` — sin tocar main().
 */
export interface FrontendMode {
  run(): Promise<void>;
}

/**
 * Factory de frontends: elige el modo según los args. Este es el punto de
 * extensión — agregar un frontend nuevo es un caso más acá, y main() no se entera.
 */
export function createMode(cli: CliArgs, core: CoreServices): FrontendMode {
  if (cli.headless) return new HeadlessMode(core, cli);
  return new TuiMode(core);
}
