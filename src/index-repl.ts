import { logger } from "./logger.js";
import { REPL } from "./transport.js";

const main = async () => {
  const repl = new REPL();

  const result = await repl.input();
};

main().catch((err) => {
  logger.error("Fatal error", err);
  process.exit(1);
});
