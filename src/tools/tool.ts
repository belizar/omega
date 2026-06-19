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

  abstract execute(input: Tin): Promise<Tout>;

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
