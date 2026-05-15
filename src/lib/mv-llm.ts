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

export async function chatLLM(
  messages: ChatMessage[],
  opts: { mode: "b2c" | "b2e" },
): Promise<{
  text: string;
  products?: Product[];
  sources?: SourceCitation[];
  raw: ChatMessage[];
  debug?: AgentDebugStep[];
}> {
  const safeMessages = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-12)
    .map((m) => ({ role: m.role, content: String(m.content ?? "").slice(0, 2000) }));

  const res = await fetch("/api/llm", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ mode: opts.mode, messages: safeMessages }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`LLM ${res.status}: ${t.slice(0, 200)}`);
  }

  const data = (await res.json()) as LLMResult;
  return {
    text: data.text || "",
    products: data.products || [],
    sources: data.sources || [],
    raw: data.raw || safeMessages,
    debug: data.debug,
  };
}
