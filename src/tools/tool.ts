type ToolConstructorProps = {
  name: string;
  description: string;
  schema: Record<string, unknown>;
};

export abstract class Tool<Tin, Tout> {
  #name: string;
  #description: string;
  #schema: Record<string, unknown>;

  constructor({ name, description, schema }: ToolConstructorProps) {
    this.#name = name;
    this.#description = description;
    this.#schema = schema;
  }

  /** Ejecuta la tool. El `signal` opcional permite que el caller (el runner)
   *  cancele operaciones long-running — ej: bash mata el proceso hijo al
   *  recibir Ctrl+C. Las tools que no lo necesiten pueden ignorarlo. */
  abstract execute(input: Tin, signal?: AbortSignal): Promise<Tout>;

  get name() {
    return this.#name;
  }

  toJSON() {
    return {
      name: this.#name,
      description: this.#description,
      input_schema: this.#schema,
    };
  }
}
