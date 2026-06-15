import { stdout } from "process";
import { cyan, dim, gray } from "../theme.js";

interface DisplayText {
  display(text: string): void;
}

class DisplayAssistantText implements DisplayText {
  display(text: string): void {
    stdout.write(dim(text));
    stdout.write("\n");
  }
}

class DisplayToolCall implements DisplayText {
  display(text: string): void {
    stdout.write(cyan(text));
    stdout.write("\n");
  }
}

class DisplayToolResult implements DisplayText {
  display(text: string): void {
    stdout.write(gray(text));
    stdout.write("\n");
  }
}

export { DisplayAssistantText, DisplayToolCall, DisplayToolResult };
