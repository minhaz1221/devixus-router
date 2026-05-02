type AnthropicMessage = {
  role?: unknown;
  content?: unknown;
};

export type AnthropicMessagesPayload = {
  messages?: unknown;
  model?: unknown;
  [k: string]: unknown;
};

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as Record<string, unknown>).type === "text" &&
      typeof (block as Record<string, unknown>).text === "string"
    ) {
      parts.push((block as Record<string, unknown>).text as string);
    }
  }
  return parts.join("");
}

function extractLatestMessageText(payload: AnthropicMessagesPayload): string {
  const messagesUnknown = payload.messages;
  if (!Array.isArray(messagesUnknown) || messagesUnknown.length === 0) return "";
  const last = messagesUnknown[messagesUnknown.length - 1] as AnthropicMessage;
  return contentToText(last?.content);
}

export type RoutingDecision = {
  original_model: string;
  routed_model: string;
  reason: "short_plaintext" | "default";
};

export function routePayload(payload: AnthropicMessagesPayload): {
  payload: AnthropicMessagesPayload;
  decision: RoutingDecision;
} {
  const original_model = typeof payload.model === "string" ? payload.model : "claude-3-5-sonnet-20241022";

  const latestText = extractLatestMessageText(payload);
  const isShort = latestText.length > 0 && latestText.length < 300;
  const hasCodeBlocks = latestText.includes("```");

  if (isShort && !hasCodeBlocks) {
    payload.model = "claude-haiku-4-5";
    return {
      payload,
      decision: { original_model, routed_model: "claude-haiku-4-5", reason: "short_plaintext" }
    };
  }

  payload.model = original_model;
  return {
    payload,
    decision: { original_model, routed_model: original_model, reason: "default" }
  };
}

