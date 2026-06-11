type ToolMessage = {
  type: "tool_result";
  tool_use_id: string;
  content: unknown;
  is_error: boolean;
};

type TextMessage =
  | {
      type: "text";
      text: string;
    }
  | string;

type MessageContent = ToolMessage | TextMessage;

type Message = {
  role: "user" | "assistant";
  content: MessageContent | MessageContent[];
};

export { Message, TextMessage, ToolMessage };
