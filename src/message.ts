type ToolMessage = {
  type: "tool_result";
  tool_use_id: string;
  content: unknown;
  is_error: boolean;
};

type ToolUseMessage = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};

type TextMessage =
  | {
      type: "text";
      text: string;
    }
  | string;

type MessageContent = ToolMessage | ToolUseMessage | TextMessage;

type Message = {
  role: "user" | "assistant";
  content: MessageContent | MessageContent[];
};

export { Message, TextMessage, ToolMessage, ToolUseMessage };
