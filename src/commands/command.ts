import { Context } from "../app-context.js";

interface Command<Tout> {
  description: string;
  handler(ctx: Context): Promise<Tout> | Tout;
}

export { Command };
