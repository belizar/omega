import { parseCliArgs } from "./cli-args.js";
import { buildCore } from "./core.js";
import { createMode } from "./frontend/mode.js";
import { logger } from "./logger.js";
import { disableRawMode } from "./tui/terminal.js";

/**
 * Entrypoint: arma el core compartido, elige el frontend (TUI o headless) y lo
 * corre. Toda la lógica vive en sus módulos — acá solo se orquesta el arranque.
 */
const main = async () => {
  const cli = parseCliArgs(process.argv.slice(2));
  const core = await buildCore();
  await createMode(cli, core).run();
};

main().catch((err) => {
  disableRawMode();
  console.log(err);
  logger.error("Fatal error", err);
  process.exit(1);
});
