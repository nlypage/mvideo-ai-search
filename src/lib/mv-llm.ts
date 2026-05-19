export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
};

export type AgentDebugStep = {
  step: number;
  type: "decision" | "assistant" | "tool" | "result";
  title: string;
  detail?: string;
  args?: unknown;
  result?: unknown;
};

export type Product = {
  id: string;
  title: string;
  price: number;
  oldPrice?: number;
  rating: number;
  reviews: number;
  image: string;
  url: string;
  stock: { warehouse: number; store: number; storeName: string };
  margin?: number;
  category: string;
};

export type SourceCitation = {
  title: string;
  url: string;
};

export type LLMResult = {
  text: string;
  products?: Product[];
  sources?: SourceCitation[];
  raw?: ChatMessage[];
  debug?: AgentDebugStep[];
};

export type AgentStreamEvent = {
  type: string;
  name?: string;
  hint?: string;
  step?: number;
  detail?: string;
};

export type RuntimeAiConfig = {
  configured: boolean;
  model: string;
  provider: string;
  appMode: "client" | "consultant" | "both";
  debug: boolean;
};

const OFF_TOPIC_RE =
  /\b(?:код|python|javascript|sql|реферат|сочинение|погода|новости|политик|медицина|юрист|астролог|анекдот)\b/i;

export function isOffTopic(text: string): boolean {
  return (
    OFF_TOPIC_RE.test(text) && !/ноутбук|компьютер|техника|телевизор|смартфон|м\.видео/i.test(text)
  );
}

export function crossSellFor(_productId: string): { items: Product[]; rationale: string } {
  return { items: [], rationale: "" };
}

export async function getRuntimeAiConfig(): Promise<RuntimeAiConfig> {
  const res = await fetch("/api/llm", { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Config ${res.status}`);
  return res.json();
}

export async function searchCatalogProducts(query: string): Promise<Product[]> {
  const res = await fetch("/api/catalog", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query }),
  });

  if (!res.ok) return [];
  const data = (await res.json()) as { products?: Product[] };
  return data.products || [];
}

function safeChatMessages(messages: ChatMessage[]) {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-12)
    .map((m) => ({ role: m.role, content: String(m.content ?? "").slice(0, 2000) }));
}

function normalizeLLMResult(data: LLMResult, fallbackRaw: ChatMessage[]) {
  return {
    text: data.text || "",
    products: data.products || [],
    sources: data.sources || [],
    raw: data.raw || fallbackRaw,
    debug: data.debug,
  };
}

export async function chatLLMStream(
  messages: ChatMessage[],
  opts: { mode: "b2c" | "b2e" },
  handlers: {
    onDelta?: (text: string) => void;
    onEvent?: (event: AgentStreamEvent) => void;
  } = {},
): Promise<{
  text: string;
  products?: Product[];
  sources?: SourceCitation[];
  raw: ChatMessage[];
  debug?: AgentDebugStep[];
}> {
  const safeMessages = safeChatMessages(messages);
  const res = await fetch("/api/llm/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ mode: opts.mode, messages: safeMessages }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`LLM ${res.status}: ${t.slice(0, 200)}`);
  }
  if (!res.body) {
    const data = (await res.json()) as LLMResult;
    return normalizeLLMResult(data, safeMessages);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let accumulated = "";
  let finalResult: LLMResult | null = null;
  let streamError: Error | null = null;

  const dispatch = (block: string) => {
    const lines = block.split(/\r?\n/);
    let event = "message";
    const data: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) return;
    const payload = JSON.parse(data.join("\n"));
    if (event === "delta") {
      const text = String(payload.text ?? "");
      accumulated += text;
      handlers.onDelta?.(text);
      return;
    }
    if (event === "final") {
      finalResult = payload as LLMResult;
      return;
    }
    if (event === "error") {
      streamError = new Error(String(payload.error ?? "AI proxy error"));
      return;
    }
    handlers.onEvent?.({ ...(payload as AgentStreamEvent), type: event });
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      dispatch(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
    if (streamError) throw streamError;
    if (done) break;
  }
  if (buffer.trim()) dispatch(buffer);
  if (streamError) throw streamError;

  const result = finalResult || { text: accumulated };
  if (accumulated.trim()) {
    result.text = accumulated;
  }
  return normalizeLLMResult(result, safeMessages);
}
