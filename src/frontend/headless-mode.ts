import { Context } from "../app-context.js";
import { CliArgs } from "../cli-args.js";
import { CoreServices } from "../core.js";
import { TurnRunner } from "../turn-runner.js";
import { Screen } from "../tui/screen.js";
import { expandFileMentions } from "../tui/file-mentions.js";
import { HeadlessFrontend } from "./headless-frontend.js";
import type { FrontendMode } from "./mode.js";

/** Lee todo stdin hasta EOF (para `-p -` o `-p` sin valor). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Modo headless one-shot: corre UN prompt hasta terminar y sale. No toca la
 * terminal — monta un frontend que emite a stdout (la "cabeza" que le ponemos al
 * mismo cuerpo). El exit code refleja si el turno terminó ok.
 */
export class HeadlessMode implements FrontendMode {
  #core: CoreServices;
  #cli: CliArgs;

  constructor(core: CoreServices, cli: CliArgs) {
    this.#core = core;
    this.#cli = cli;
  }

  async run(): Promise<void> {
    const { config, session, agentConfig, toolRegistry, classifier } = this.#core;

    const prompt = this.#cli.prompt ?? (await readStdin());
    if (!prompt.trim()) {
      process.stderr.write('omega: prompt vacío (usá -p "…" o pasalo por stdin)\n');
      process.exit(2);
    }

    // Override de modelo por corrida (`--model`). Clave para interviews: variar
    // el candidate. Se aplica como override de sesión (mismo camino que /model),
    // así lo toma TurnRunner al resolver el modelo primario del turno.
    if (this.#cli.model) {
      session.setModelOverride("primary", this.#cli.model);
    }
    const effectiveModel = this.#cli.model ?? config.model;

    // Screen inerte: satisface la dependencia del Context sin enganchar la
    // terminal (no llamamos screen.start()). El headless nunca renderiza por acá.
    // TODO: idealmente Context depende de un ScreenPort, no del Screen concreto.
    const screen = new Screen(config.screenPadding);
    const ctx = new Context({ session, agentConfig, screen, toolRegistry, classifier });

    const frontend = new HeadlessFrontend({
      prompt,
      format: this.#cli.format,
      model: effectiveModel,
      sessionId: session.id,
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
    });

    const turnRunner = new TurnRunner(this.#core, ctx, frontend);

    frontend.start();

    // Ctrl+C aborta el turno en curso (corta la llamada al LLM y deja emitir el
    // `result`) en vez de matar el proceso en seco. Un solo listener, en el driver.
    process.on("SIGINT", () => {
      if (!frontend.interrupt()) process.exit(130); // sin turno activo → salir
    });

    // @-mentions se expanden (útil para tareas que referencian archivos); las
    // imágenes de visión no se soportan en headless v1.
    const resolved = await expandFileMentions(prompt);
    session.addUserMessage(resolved.text || prompt);

    await turnRunner.run();

    frontend.stop();
    toolRegistry.disconnectAll();
    process.exit(frontend.hadError ? 1 : 0);
  }
}
