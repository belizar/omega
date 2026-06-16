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

type ImageMessage = {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
};

type MessageContent = ToolMessage | ToolUseMessage | TextMessage | ImageMessage;

type Message = {
  role: "user" | "assistant";
  content: MessageContent | MessageContent[];
};

export { ImageMessage, Message, TextMessage, ToolMessage, ToolUseMessage };
