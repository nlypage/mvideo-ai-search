import { createFileRoute } from "@tanstack/react-router";
import { TOOLS, runTool, type BlogArticle, type BlogSource, type Product } from "@/lib/mv-tools";
import { SYSTEM_B2C, SYSTEM_B2E } from "@/lib/mv-prompts";
import {
  REFUSAL_B2C,
  isOffTopic,
  isPromptInjection,
  redactSensitive,
  sanitizeUserText,
} from "@/lib/mv-security";
import type { ChatMessage } from "@/lib/mv-llm";

type Mode = "b2c" | "b2e";
type RateBucket = { count: number; resetAt: number };
type AgentDebugStep = {
  step: number;
  type: "decision" | "assistant" | "tool" | "result";
  title: string;
  detail?: string;
  args?: unknown;
  result?: unknown;
};

const RATE_LIMITS: Record<Mode, { limit: number; windowMs: number }> = {
  b2c: { limit: 30, windowMs: 10 * 60 * 1000 },
  b2e: { limit: 60, windowMs: 10 * 60 * 1000 },
};

const buckets = new Map<string, RateBucket>();
const ALLOWED_TOOLS = new Set(TOOLS.map((tool) => tool.function.name));
const MAX_LLM_BODY_BYTES = 24_000;

export const Route = createFileRoute("/api/llm")({
  server: {
    handlers: {
      GET: async () => {
        const cfg = getConfig();
        return json({
          configured: Boolean(cfg.apiKey),
          model: cfg.model,
          provider: safeProviderName(cfg.baseUrl),
          appMode: cfg.appMode,
          debug: cfg.debug,
        });
      },
      POST: async ({ request }: { request: Request }) => {
        try {
          const cfg = getConfig();
          const body = await readLimitedJson<{ mode?: Mode; messages?: unknown[] }>(
            request,
            MAX_LLM_BODY_BYTES,
          );
          const mode = body.mode === "b2e" ? "b2e" : "b2c";

          const modeError = validateServiceMode(mode, cfg.appMode);
          if (modeError) return json({ error: modeError }, 403);

          if (mode === "b2e" && cfg.consultantAccessToken) {
            const token = request.headers.get("x-consultant-token") || "";
            if (token !== cfg.consultantAccessToken) return json({ error: "Forbidden" }, 403);
          }

          const rateError = checkRateLimit(clientKey(request, mode), mode);
          if (rateError) return json({ error: rateError }, 429);

          const normalizedMessages = normalizeMessages(body.messages);
          const safety = sanitizeConversation(normalizedMessages, mode);
          if (safety.refusal) return json(safety.refusal);
          const messages = safety.messages;
          if (!messages.length) return json({ error: "Empty messages" }, 400);

          const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content || "";
          if (mode === "b2c" && isOffTopic(lastUser)) {
            return json({ text: REFUSAL_B2C, products: [], raw: [] });
          }

          if (!cfg.apiKey) {
            const directToolResult = await localToolChat(messages, mode, cfg.debug);
            return json(directToolResult);
          }

          const result = await upstreamToolChat(messages, mode, cfg);
          return json(result);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.stack || error.message : String(error);
          console.error(redactSensitive(message));
          return json({ error: "AI proxy error" }, 500);
        }
      },
    },
  },
});

async function upstreamToolChat(
  messages: ChatMessage[],
  mode: Mode,
  cfg: ReturnType<typeof getConfig>,
) {
  const convo: ChatMessage[] = [
    { role: "system", content: mode === "b2c" ? SYSTEM_B2C : SYSTEM_B2E },
    ...messages,
  ];
  const searchProducts: Product[] = [];
  const recommendedProducts: Product[] = [];
  const blogArticles: BlogArticle[] = [];
  const citedSources: BlogSource[] = [];
  const debug: AgentDebugStep[] = [];
  let broadCatalogCursor = 0;

  for (let step = 0; step < 8; step++) {
    const upstream = await fetchWithTimeout(
      `${cfg.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: convo,
          tools: TOOLS,
          tool_choice: "auto",
          temperature: mode === "b2c" ? 0.35 : 0.2,
          max_tokens: mode === "b2c" ? 700 : 350,
        }),
      },
      20_000,
    );

    const text = await upstream.text();
    if (!upstream.ok) {
      console.error(redactSensitive(`Upstream ${upstream.status}: ${text.slice(0, 500)}`));
      return jsonErrorText("Провайдер ИИ временно недоступен.", recommendedProducts);
    }

    const data = JSON.parse(text);
    const msg = data.choices?.[0]?.message as ChatMessage | undefined;
    if (!msg) return jsonErrorText("Провайдер ИИ вернул пустой ответ.", recommendedProducts);
    convo.push(msg);

    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls.slice(0, 4) : [];
    if (cfg.debug) {
      debug.push({
        step,
        type: calls.length ? "decision" : "assistant",
        title: calls.length ? "Агент выбрал инструменты" : "Агент сформировал ответ",
        detail: summarizeAssistantMessage(msg, calls),
      });
    }
    if (calls.length) {
      for (const rawCall of calls) {
        const call = rawCall as { id?: string; function?: { name?: string; arguments?: unknown } };
        const name = call.function?.name;
        if (!name || !ALLOWED_TOOLS.has(name)) continue;
        let args = safeToolArgs(call.function?.arguments, messages);
        if (name === "search_catalog") {
          const normalized = normalizeAgentCatalogArgs(args, messages, broadCatalogCursor);
          args = normalized.args;
          if (normalized.changed) {
            broadCatalogCursor += 1;
            if (cfg.debug) {
              debug.push({
                step,
                type: "decision",
                title: "Широкий вопрос заменён категорией каталога",
                detail: `Каталог не ищет вопросы — читаю категорию «${args.query}».`,
              });
            }
          }
        }
        if (name === "recommend_products") {
          args.productIds = filterRecommendedIds(args.productIds, searchProducts, messages);
        }
        if (cfg.debug) {
          debug.push({
            step,
            type: "tool",
            title: `Вызов ${name}`,
            args: sanitizeDebugValue(args),
          });
        }
        const result = await runTool(name, args);
        if (name === "search_catalog" && "products" in result) {
          searchProducts.push(...result.products);
        }
        if (name === "recommend_products" && "products" in result) {
          recommendedProducts.push(...result.products);
        }
        if (name === "search_blog" && "article" in result && result.article.content) {
          blogArticles.push(result.article);
        }
        if (name === "cite_blog_source" && "citation" in result) {
          const citation = canonicalBlogCitation(result.citation, blogArticles);
          if (citation) citedSources.push(citation);
        }
        if (cfg.debug) {
          debug.push({
            step,
            type: "result",
            title: `Результат ${name}`,
            result: summarizeToolResult(result),
          });
        }
        convo.push({
          role: "tool",
          tool_call_id: String(call.id || crypto.randomUUID()),
          name,
          content: JSON.stringify(result).slice(0, 6000),
        });
      }
      continue;
    }

    const answerText = redactSensitive(sanitizeAssistantText(msg.content || "", mode, messages));
    if (shouldRequireCitationTool(answerText, blogArticles, citedSources, mode)) {
      if (cfg.debug) {
        debug.push({
          step,
          type: "decision",
          title: "Требую структурный источник",
          detail: "Ответ опирается на прочитанную статью, но cite_blog_source ещё не вызван.",
        });
      }
      convo.push({
        role: "system",
        content:
          "Ты использовал данные search_blog/article.content. Перед финальным ответом обязательно вызови cite_blog_source с title и url этой статьи. Не пиши строку 'Источник:' текстом.",
      });
      continue;
    }

    return withDebug(
      {
        text: stripRenderedSourceLines(answerText),
        products: dedupeProducts(filterProductsForUserIntent(recommendedProducts, messages)),
        sources: dedupeSources(citedSources),
        raw: [],
      },
      cfg.debug,
      debug,
    );
  }

  if (cfg.debug) {
    debug.push({
      step: 6,
      type: "assistant",
      title: "Лимит инструментов достигнут",
      detail: "Запрашиваю финальный ответ у модели без инструментов по уже собранным данным.",
    });
  }

  const final = await finalNoToolsAnswer(
    convo,
    messages,
    mode,
    cfg,
    searchProducts,
    recommendedProducts,
    citedSources,
  );
  return withDebug(final, cfg.debug, debug);
}

async function localToolChat(messages: ChatMessage[], mode: Mode, debugEnabled: boolean) {
  const last = [...messages].reverse().find((m) => m.role === "user")?.content || "";
  const catalogQueries = deriveCatalogQueries(last);
  const catalogQuery = catalogQueries[0] || deriveToolQuery(last);
  const shouldUseCatalog = shouldSearchCatalog(last);
  const collectedProducts: unknown[] = [];
  const debug: AgentDebugStep[] = [];
  if (debugEnabled) {
    debug.push({
      step: 0,
      type: "decision",
      title: "Локальный агент выбрал запросы",
      args: { catalogQueries, catalogQuery, useCatalog: shouldUseCatalog },
    });
  }

  if (shouldUseCatalog) {
    for (const query of catalogQueries.slice(0, 4)) {
      const result = await runTool("search_catalog", {
        query,
        maxPrice: inferMaxPrice(last),
        limit: 12,
      });
      if (debugEnabled) {
        debug.push({
          step: 1,
          type: "result",
          title: `Результат search_catalog: ${query}`,
          result: summarizeToolResult(result),
        });
      }
      if ("products" in result) collectedProducts.push(...result.products);
    }
  }

  const products = rankProductsForUserIntent(dedupeProducts(collectedProducts), last);
  const blogRes =
    shouldSearchBlog(last) || isBroadSelectionRequest(last)
      ? await runTool("search_blog", { query: deriveBlogQuery(last, catalogQuery) })
      : { error: "skip blog" };
  if (debugEnabled) {
    debug.push({
      step: 2,
      type: "result",
      title: "Результат search_blog",
      result: summarizeToolResult(blogRes),
    });
  }
  const article = "article" in blogRes ? blogRes.article : undefined;

  if (mode === "b2e") {
    if (!products.length) {
      return {
        text: "• Реальный каталог М.Видео сейчас недоступен\n• Повторите запрос позже",
        products: [],
        raw: [],
      };
    }

    return withDebug(
      { text: buildB2eSalesText(products, last, article), products: products.slice(0, 4), raw: [] },
      debugEnabled,
      debug,
    );
  }

  if (isOffTopic(last)) return { text: REFUSAL_B2C, products: [], raw: [] };

  if (!products.length) {
    return withDebug(
      {
        text: "Я попробовал разложить запрос на конкретные категории М.Видео, но публичный каталог сейчас не вернул товары. Уточните бюджет и интересы — например игры, музыка, спорт или учёба — и я попробую другой набор категорий.",
        products: [],
        raw: [],
      },
      debugEnabled,
      debug,
    );
  }

  const selected = await runTool("recommend_products", {
    productIds: products.slice(0, 4).map((product) => product.id),
  });
  const recommended =
    "products" in selected
      ? rankProductsForUserIntent(filterProductsForUserIntent(selected.products, messages), last)
      : [];
  const displayProducts = (recommended.length ? recommended : products).slice(0, 4);
  const sources = article?.content ? [{ title: article.title, url: article.url }] : [];
  const text = buildB2cRecommendationText({
    last,
    catalogQuery,
    catalogQueries,
    products: displayProducts,
    article,
  });
  if (debugEnabled) {
    debug.push({
      step: 3,
      type: "result",
      title: "Результат recommend_products",
      result: summarizeToolResult(selected),
    });
  }
  return withDebug(
    {
      text: stripRenderedSourceLines(sanitizeAssistantText(text, mode, messages)),
      products: displayProducts,
      sources,
      raw: [],
    },
    debugEnabled,
    debug,
  );
}

function shouldSearchCatalog(text: string): boolean {
  return (
    /\p{L}|\p{N}/u.test(text) &&
    !/^\s*(привет|спасибо|как дела|что ты умеешь)\s*[.!?]*$/i.test(text)
  );
}

function shouldSearchBlog(text: string): boolean {
  return /как выбрать|что такое|чем отличается|сравни|сравнить|hdmi|dolby|atmos|oled|hdr|ps5|саундбар|кабель|телевизор|монитор/i.test(
    text,
  );
}

function isBroadSelectionRequest(text: string): boolean {
  return /что\s+подарить|подарок|варианты\s+для|что\s+взять|что\s+купить|идеи\s+для/i.test(text);
}

function deriveCatalogQueries(text: string): string[] {
  if (!isBroadSelectionRequest(text)) return [deriveToolQuery(text)];

  const lower = text.toLowerCase();
  const queries: string[] = [];
  if (/геймер|игр|playstation|ps5|xbox|компьютер/.test(lower)) {
    queries.push("игровая гарнитура", "геймпад", "игровая клавиатура", "игровая мышь");
  } else if (/подрост|школьник|студент|сын|дочь/.test(lower)) {
    queries.push("беспроводные наушники", "портативная колонка", "умные часы", "игровая гарнитура");
  } else {
    queries.push("беспроводные наушники", "умная колонка", "электронная книга", "фитнес браслет");
  }

  return [...new Set(queries)].slice(0, 4);
}

function deriveToolQuery(text: string): string {
  const cleaned = text
    .replace(/\b(подбери|найди|посоветуй|нужен|нужна|нужно|хочу|для|мне|пожалуйста)\b/giu, " ")
    .replace(/[?!.,:;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.split(" ").slice(0, 5).join(" ") || text;
}

function deriveBlogQuery(text: string, catalogQuery: string): string {
  if (isBroadSelectionRequest(text)) return `${text} гаджеты техника`;
  return catalogQuery;
}

function normalizeAgentCatalogArgs(
  args: ReturnType<typeof safeToolArgs>,
  messages: ChatMessage[],
  cursor: number,
): { args: ReturnType<typeof safeToolArgs>; changed: boolean } {
  const last = getLastUserText(messages);
  const query = args.query || last;
  if (!isBroadSelectionRequest(query) && !isBroadSelectionRequest(last)) {
    return { args, changed: false };
  }

  const categories = deriveCatalogQueries(last || query);
  const category = categories[cursor % categories.length] || deriveToolQuery(query);
  return {
    args: {
      ...args,
      query: category,
      maxPrice: args.maxPrice ?? inferMaxPrice(last || query),
      limit: args.limit ?? 12,
      offset: args.offset ?? 0,
    },
    changed: category !== query,
  };
}

function inferMaxPrice(text: string): number | undefined {
  const normalized = text.toLowerCase().replace(/\s+/g, " ");
  const match = normalized.match(/(?:до|≤|<=|не дороже|максимум)\s*(\d[\d\s.,]*)\s*(?:₽|руб|р)?/u);
  if (!match) return undefined;

  const value = Number(match[1].replace(/[\s.,]/g, ""));
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(value, 10_000_000);
}

function filterRecommendedIds(
  productIds: string[] | undefined,
  searchProducts: Product[],
  messages: ChatMessage[],
): string[] {
  if (!productIds?.length) return [];
  const allowedIds = new Set(
    filterProductsForUserIntent(searchProducts, messages).map((p) => p.id),
  );
  return productIds.filter((id) => allowedIds.has(id));
}

function filterProductsForUserIntent(products: Product[], messages: ChatMessage[]): Product[] {
  const text = getLastUserText(messages).toLowerCase();
  const intent = productIntentConstraints(text);
  if (!intent) return products;

  return products.filter((product) => {
    const productText = `${product.title} ${product.category}`.toLowerCase();
    return (
      intent.required.every((term) => productText.includes(term)) &&
      intent.excluded.every((term) => !productText.includes(term))
    );
  });
}

function productIntentConstraints(text: string): { required: string[]; excluded: string[] } | null {
  const consoleIntent = /nintendo|switch|steam\s*deck|консоль|пристав/u.test(text);
  const tvIntent = /телевизор|\bтв\b|\btv\b/u.test(text);
  const gamingDisplayIntent =
    /\boled\b|mini\s*led|qled|120\s*гц|hdmi\s*2\.?1|vrr/u.test(text) &&
    /игр|гейм|ps5|playstation|xbox/u.test(text) &&
    !/монитор|ноутбук|смартфон|телефон|планшет/u.test(text);
  if (consoleIntent && !tvIntent) return null;

  const excluded = ["консоль", "steam", "deck", "nintendo", "switch"];
  if (gamingDisplayIntent && /\boled\b/u.test(text)) {
    return { required: ["телевизор", "oled"], excluded };
  }
  if (gamingDisplayIntent || tvIntent) return { required: ["телевизор"], excluded };
  return null;
}

function getLastUserText(messages: ChatMessage[]): string {
  return [...messages].reverse().find((m) => m.role === "user")?.content || "";
}

function sanitizeConversation(
  messages: ChatMessage[],
  mode: Mode,
): { messages: ChatMessage[]; refusal?: { text: string; products: unknown[]; raw: unknown[] } } {
  let lastUnsafeUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (
      message.role === "user" &&
      (isPromptInjection(message.content) || (mode === "b2c" && isOffTopic(message.content)))
    ) {
      lastUnsafeUserIndex = index;
      break;
    }
  }

  if (lastUnsafeUserIndex === -1) return { messages };
  if (lastUnsafeUserIndex === messages.length - 1) {
    return {
      messages: [],
      refusal: {
        text:
          mode === "b2c"
            ? REFUSAL_B2C
            : "• Запрос вне рабочей задачи\n• Вернитесь к клиенту и товарам",
        products: [],
        raw: [],
      },
    };
  }

  return { messages: messages.slice(lastUnsafeUserIndex + 1) };
}

function normalizeMessages(input: unknown): ChatMessage[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter(isIncomingChatMessage)
    .slice(-8)
    .map((m) => ({
      role: m.role,
      content: sanitizeUserText(m.content, m.role === "user" ? 700 : 900),
    }))
    .filter((m) => m.content.length > 0);
}

function isIncomingChatMessage(
  value: unknown,
): value is { role: "user" | "assistant"; content: unknown } {
  if (!value || typeof value !== "object") return false;
  const message = value as { role?: unknown; content?: unknown };
  return message.role === "user" || message.role === "assistant";
}

function safeToolArgs(
  raw: unknown,
  messages: ChatMessage[],
): {
  query: string;
  productId?: string;
  productIds?: string[];
  requiredTerms?: string[];
  excludedTerms?: string[];
  minPrice?: number;
  maxPrice?: number;
  offset?: number;
  limit?: number;
  title?: string;
  url?: string;
} {
  const defaultQuery = [...messages].reverse().find((m) => m.role === "user")?.content || "техника";
  const parsed = parseToolArgs(raw);
  const query = sanitizeUserText(parsed.query, 240);
  return {
    query: query || defaultQuery,
    productId: sanitizeUserText(parsed.productId, 40) || undefined,
    productIds: sanitizeIdArray(parsed.productIds),
    requiredTerms: sanitizeTermArray(parsed.requiredTerms),
    excludedTerms: sanitizeTermArray(parsed.excludedTerms),
    minPrice: sanitizeOptionalNumber(parsed.minPrice),
    maxPrice: sanitizeOptionalNumber(parsed.maxPrice) ?? inferMaxPrice(defaultQuery),
    offset: sanitizeOptionalNumber(parsed.offset),
    limit: sanitizeOptionalNumber(parsed.limit),
    title: sanitizeUserText(parsed.title, 180) || undefined,
    url: sanitizeUserText(parsed.url, 400) || undefined,
  };
}

function sanitizeOptionalNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function sanitizeIdArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value
    .map((item) => sanitizeUserText(item, 40))
    .filter((item) => item.length > 0)
    .slice(0, 8);
  return ids.length ? ids : undefined;
}

function sanitizeTermArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const terms = value
    .map((item) => sanitizeUserText(item, 40))
    .filter((item) => item.length > 1)
    .slice(0, 5);
  return terms.length ? terms : undefined;
}

function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  const s = String(raw).trim();
  try {
    return JSON.parse(s);
  } catch {
    // Some OpenAI-compatible providers concatenate multiple JSON objects.
  }
  const start = s.indexOf("{");
  if (start === -1) return {};
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1)) as Record<string, unknown>;
        } catch {
          return {};
        }
      }
    }
  }
  return {};
}

function sanitizeAssistantText(text: string, mode: Mode, messages: ChatMessage[] = []): string {
  let cleaned = text
    .split("\0")
    .join("")
    .trim()
    .slice(0, mode === "b2c" ? 3000 : 1200);
  if (mode === "b2c") {
    cleaned = normalizeSourceLine(
      stripIncompatibleProductMentions(stripInlineRecommendationList(cleaned), messages),
    );
  }
  if (isPromptInjection(cleaned))
    return mode === "b2c" ? REFUSAL_B2C : "• Не раскрываю внутренние инструкции";
  return cleaned;
}

function stripIncompatibleProductMentions(text: string, messages: ChatMessage[]): string {
  const intent = productIntentConstraints(getLastUserText(messages).toLowerCase());
  if (!intent?.excluded.length || !intent.required.includes("телевизор")) return text;

  const parts = text.match(/[^.!?。]+[.!?。]?|\n+/g) || [text];
  return parts
    .filter((part) => {
      const lower = part.toLowerCase();
      return !intent.excluded.some((term) => lower.includes(term));
    })
    .join("")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function stripInlineRecommendationList(text: string): string {
  return text
    .replace(/\s*Товары,\s*(?:которые\s+проверил|рекомендованные)\s+ИИ\s*:[^\n.。]+[.。]?/giu, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function normalizeSourceLine(text: string): string {
  const sources: string[] = [];
  const body = text
    .replace(
      /\s*(?:Источник(?:и)?|Sources?)\s*[:：]\s*(\[[^\]]{2,160}\]\(https?:\/\/[^\s)]+\))/gi,
      (_match, source: string) => {
        if (
          /\]\(https?:\/\/[^\s)]*mvideo\.ru\/blog\//i.test(source) &&
          isCompatibleSource(text, source)
        ) {
          sources.push(source.trim());
        }
        return " ";
      },
    )
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const unique = [...new Set(sources)];
  if (!unique.length) return body;
  return `${body}\n\nИсточник: ${unique[0]}`.trim();
}

function canonicalBlogCitation(citation: BlogSource, articles: BlogArticle[]): BlogSource | null {
  const matched = articles.find(
    (article) => article.content && normalizeUrl(article.url) === normalizeUrl(citation.url),
  );
  if (!matched) return null;
  return { title: matched.title, url: matched.url };
}

function shouldRequireCitationTool(
  text: string,
  articles: BlogArticle[],
  citedSources: BlogSource[],
  mode: Mode,
): boolean {
  if (mode !== "b2c" || citedSources.length > 0) return false;
  if (!articles.some((article) => article.content && article.url.includes("/blog/"))) return false;
  return !/опираюсь\s+только\s+на\s+каталог|статья\s+не\s+использована/i.test(text);
}

function stripRenderedSourceLines(text: string): string {
  return text
    .replace(/^[\s•\-*]*(?:Источник(?:и)?|Sources?)\s*[:：].*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function dedupeSources(sources: BlogSource[]): BlogSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = normalizeUrl(source.url);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function isCompatibleSource(body: string, source: string): boolean {
  const bodyLower = body.toLowerCase();
  const sourceLower = source.toLowerCase();
  const title = extractSourceTitle(source).toLowerCase();
  if (/appgallery|график релизов|games-calendar|top-gadgets-release/.test(sourceLower)) {
    return false;
  }
  if (hasUnrequestedAccessoryTopic(title, bodyLower)) return false;
  if (isUnmatchedSingleProductReview(title, bodyLower)) return false;
  return true;
}

function extractSourceTitle(source: string): string {
  const markdownTitle = source.match(/\[([^\]]{2,180})\]\(/)?.[1];
  return markdownTitle || source;
}

function sourceTerms(text: string): string[] {
  const stop = new Set([
    "как",
    "что",
    "для",
    "или",
    "лучшие",
    "лучший",
    "выбираем",
    "выбрать",
    "обзор",
    "топ",
    "году",
    "года",
    "модель",
    "модели",
  ]);
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 2 && !stop.has(term));
}

function sameSourceTerm(left: string, right: string): boolean {
  const a = left.replace(/ё/g, "е");
  const b = right.replace(/ё/g, "е");
  const size = Math.min(6, a.length, b.length);
  return size >= 4 && a.slice(0, size) === b.slice(0, size);
}

function hasUnrequestedAccessoryTopic(title: string, body: string): boolean {
  const accessoryRoots = [
    "подстав",
    "сумк",
    "рюкзак",
    "чехл",
    "заряд",
    "кабел",
    "кроншт",
    "держател",
    "адаптер",
    "переходник",
  ];
  const head = sourceTerms(title)
    .slice(0, 4)
    .find((term) => accessoryRoots.some((root) => term.startsWith(root)));
  if (!head) return false;
  return !sourceTerms(body).some((term) => sameSourceTerm(term, head));
}

function isUnmatchedSingleProductReview(title: string, body: string): boolean {
  if (!/^обзор\s+/i.test(title)) return false;
  const reviewTerms = sourceTerms(title).slice(0, 2);
  if (!reviewTerms.length) return false;
  const bodyTerms = sourceTerms(body);
  return !reviewTerms.some((term) => bodyTerms.some((bodyTerm) => sameSourceTerm(bodyTerm, term)));
}

function withDebug<T extends object>(
  payload: T,
  enabled: boolean,
  debug: AgentDebugStep[],
): T & { debug?: AgentDebugStep[] } {
  if (!enabled) return payload;
  return { ...payload, debug: debug.slice(0, 40) };
}

function summarizeAssistantMessage(msg: ChatMessage, calls: unknown[]): string {
  if (calls.length) {
    const names = calls
      .map((call) => (call as { function?: { name?: string } }).function?.name)
      .filter(Boolean)
      .join(", ");
    return `План следующего шага: ${names || "инструменты"}`;
  }
  return sanitizeUserText(msg.content || "Финальный ответ без дополнительных инструментов", 500);
}

function sanitizeDebugValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 12).map(sanitizeDebugValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      typeof item === "string" ? sanitizeUserText(item, 500) : sanitizeDebugValue(item),
    ]),
  );
}

function summarizeToolResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  if ("products" in result && Array.isArray((result as { products?: unknown[] }).products)) {
    const typed = result as {
      products: Product[];
      page?: unknown;
      role?: unknown;
      source?: unknown;
    };
    return {
      source: typed.source,
      role: typed.role,
      page: typed.page,
      count: typed.products.length,
      products: typed.products.slice(0, 8).map((product) => ({
        id: product.id,
        title: product.title,
        price: product.price,
        rating: product.rating,
        reviews: product.reviews,
      })),
    };
  }
  if ("article" in result) {
    const typed = result as {
      title?: unknown;
      url?: unknown;
      snippet?: unknown;
      source?: unknown;
      article?: { content?: unknown; contentChars?: unknown; contentSource?: unknown };
      articles?: Array<{ title?: unknown; url?: unknown; score?: unknown; relevance?: unknown }>;
    };
    const content = typeof typed.article?.content === "string" ? typed.article.content : "";
    return {
      source: typed.source,
      title: typed.title,
      url: typed.url,
      snippet: typed.snippet,
      articleRead: content.length > 0,
      contentChars: typed.article?.contentChars ?? content.length,
      contentSource: typed.article?.contentSource,
      contentPreview: content ? sanitizeUserText(content, 300) : undefined,
      articles: typed.articles?.slice(0, 5).map((article) => ({
        title: article.title,
        url: article.url,
        score: article.score,
        relevance: article.relevance,
      })),
    };
  }
  if ("reviews" in result && Array.isArray((result as { reviews?: unknown[] }).reviews)) {
    return { count: (result as { reviews: unknown[] }).reviews.length };
  }
  if ("citation" in result) {
    return sanitizeDebugValue(result);
  }
  return sanitizeDebugValue(result);
}

async function finalNoToolsAnswer(
  convo: ChatMessage[],
  messages: ChatMessage[],
  mode: Mode,
  cfg: ReturnType<typeof getConfig>,
  searchProducts: Product[],
  recommendedProducts: Product[],
  citedSources: BlogSource[],
) {
  const fallback = gracefulToolLimitAnswer(messages, searchProducts, recommendedProducts);
  try {
    const upstream = await fetchWithTimeout(
      `${cfg.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            ...convo,
            {
              role: "system",
              content:
                "Инструменты больше недоступны. Не вызывай tools. Ответь пользователю по уже собранным результатам каталога, статей и отзывов. Не упоминай лимит инструментов или технические ошибки.",
            },
          ],
          temperature: mode === "b2c" ? 0.3 : 0.2,
          max_tokens: mode === "b2c" ? 650 : 300,
        }),
      },
      20_000,
    );
    const text = await upstream.text();
    if (!upstream.ok) return fallback;

    const data = JSON.parse(text);
    const content = String(data.choices?.[0]?.message?.content || "").trim();
    if (!content) return fallback;

    const products = rankProductsForUserIntent(
      dedupeProducts(
        filterProductsForUserIntent(
          recommendedProducts.length ? recommendedProducts : searchProducts,
          messages,
        ),
      ),
      getLastUserText(messages),
    ).slice(0, 4);

    const answerText = redactSensitive(sanitizeAssistantText(content, mode, messages));
    return {
      text: stripRenderedSourceLines(answerText),
      products,
      sources: dedupeSources(citedSources),
      raw: [],
    };
  } catch {
    return fallback;
  }
}

function gracefulToolLimitAnswer(
  messages: ChatMessage[],
  searchProducts: Product[],
  recommendedProducts: Product[],
) {
  const products = rankProductsForUserIntent(
    dedupeProducts(
      filterProductsForUserIntent(
        recommendedProducts.length ? recommendedProducts : searchProducts,
        messages,
      ),
    ),
    getLastUserText(messages),
  ).slice(0, 4);
  if (!products.length) {
    return {
      text: "Я не смог уверенно завершить подбор по данным каталога. Уточните бюджет или категорию — попробую сузить поиск.",
      products: [],
      raw: [],
    };
  }

  return {
    text: buildB2cRecommendationText({
      last: getLastUserText(messages),
      catalogQuery: deriveToolQuery(getLastUserText(messages)),
      catalogQueries: [],
      products,
    }),
    products,
    raw: [],
  };
}

function buildB2cRecommendationText(input: {
  last: string;
  catalogQuery: string;
  catalogQueries: string[];
  products: Product[];
  article?: BlogArticle;
}): string {
  const { last, catalogQuery, catalogQueries, products, article } = input;
  const lines: string[] = [];
  if (isBroadSelectionRequest(last) && catalogQueries.length) {
    lines.push(`Разложил запрос на идеи: ${catalogQueries.slice(0, 3).join(", ")}.`);
  } else {
    lines.push(`Подобрал варианты под запрос «${catalogQuery}».`);
  }

  const [best, ...alternatives] = products;
  if (best) {
    lines.push(`**Лучший старт:** ${formatProductPick(best, last)}`);
  }
  if (alternatives.length) {
    lines.push(
      `**Альтернативы:** ${alternatives
        .slice(0, 2)
        .map((product) => `${shortProductTitle(product)} — ${formatMoney(product.price)}`)
        .join("; ")}.`,
    );
  }
  const criteria = recommendationCriteria(last, products);
  if (criteria) lines.push(`**Почему так:** ${criteria}.`);
  if (article) {
    const articleText = sanitizeUserText(article.content || article.snippet, 180);
    if (articleText) lines.push(`**Критерий из гайда:** ${articleText}…`);
  }
  lines.push("Если хотите, могу сразу сравнить эти варианты или подобрать комплект аксессуаров.");
  return lines.join("\n\n");
}

function buildB2eSalesText(products: Product[], last: string, article?: BlogArticle): string {
  const [best, second] = products;
  if (!best) {
    return "• Реальный каталог М.Видео сейчас недоступен\n• Уточните категорию, бюджет и сценарий клиента";
  }

  const lines = [
    `• Лучший старт: ${shortProductTitle(best)} за ${formatMoney(best.price)}`,
    `• Аргумент: ${productReason(best, last).join(", ") || "подходит под запрос клиента"}`,
  ];
  if (second) {
    lines.push(`• Альтернатива: ${shortProductTitle(second)} за ${formatMoney(second.price)}`);
  }
  lines.push("• Возражение: сравните пользу, рейтинг и наличие в магазине");
  if (article) {
    const articleArgument = sanitizeUserText(article.content || article.snippet, 90);
    if (articleArgument) lines.push(`• Подкрепление: ${articleArgument}…`);
  }
  lines.push("• Следующий шаг: покажите карточки и предложите комплект");
  return lines.slice(0, 6).join("\n");
}

function rankProductsForUserIntent(products: Product[], text: string): Product[] {
  const maxPrice = inferMaxPrice(text);
  const queryTerms = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 3)
    .slice(0, 12);

  return [...products].sort((left, right) => {
    const score = (product: Product) => {
      const productText = `${product.title} ${product.category}`.toLowerCase();
      const termScore = queryTerms.filter((term) => productText.includes(term)).length * 4;
      const ratingScore = Math.max(0, product.rating || 0) * 6;
      const reviewScore = Math.min(product.reviews || 0, 300) / 15;
      const stockScore =
        (product.stock?.store || product.stock?.warehouse ? 10 : 0) +
        (product.stock?.store ? 4 : 0);
      const discountScore = product.oldPrice && product.oldPrice > product.price ? 5 : 0;
      const budgetScore = maxPrice
        ? product.price <= maxPrice
          ? 16 - Math.max(0, (maxPrice - product.price) / maxPrice) * 6
          : -40
        : 0;
      return termScore + ratingScore + reviewScore + stockScore + discountScore + budgetScore;
    };
    return score(right) - score(left);
  });
}

function recommendationCriteria(text: string, products: Product[]): string {
  const criteria = new Set<string>();
  if (inferMaxPrice(text)) criteria.add("уложился в бюджет");
  if (products.some((product) => product.rating >= 4.5)) criteria.add("высокий рейтинг");
  if (products.some((product) => product.reviews >= 20)) criteria.add("есть отзывы покупателей");
  if (products.some((product) => product.stock?.store || product.stock?.warehouse)) {
    criteria.add("есть наличие");
  }
  if (/игр|ps5|playstation|xbox|гейм/u.test(text.toLowerCase())) {
    criteria.add("игровой сценарий");
  }
  return [...criteria].slice(0, 4).join(", ");
}

function formatProductPick(product: Product, text: string): string {
  const reasons = productReason(product, text);
  return `${shortProductTitle(product)} — ${formatMoney(product.price)}${
    reasons.length ? ` (${reasons.join(", ")})` : ""
  }.`;
}

function productReason(product: Product, text: string): string[] {
  const reasons: string[] = [];
  const maxPrice = inferMaxPrice(text);
  if (maxPrice && product.price <= maxPrice) reasons.push("в бюджете");
  if (product.rating >= 4.5) reasons.push(`рейтинг ${product.rating.toFixed(1)}`);
  if (product.reviews >= 20) reasons.push(`${product.reviews} отзывов`);
  if (product.stock?.store) reasons.push("есть в магазине");
  else if (product.stock?.warehouse) reasons.push("есть на складе");
  if (product.oldPrice && product.oldPrice > product.price) reasons.push("есть скидка");
  if (/игр|ps5|playstation|xbox|гейм/u.test(text.toLowerCase())) {
    reasons.push("под игровой сценарий");
  }
  return reasons.slice(0, 3);
}

function shortProductTitle(product: Product): string {
  return product.title.split(",")[0].trim();
}

function formatMoney(value: number): string {
  return `${Math.round(value).toLocaleString("ru-RU")} ₽`;
}

function jsonErrorText(text: string, products: unknown[]) {
  return { text, products: dedupeProducts(products), raw: [] };
}

function dedupeProducts(products: unknown[]): Product[] {
  const seen = new Set<string>();
  return products.filter((product): product is Product => {
    if (!product || typeof product !== "object") return false;
    const item = product as { id?: unknown; title?: unknown };
    const key = String(item.id || item.title || "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function readLimitedJson<T>(request: Request, maxBytes: number): Promise<T> {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > maxBytes) throw new Error("Request body too large");

  const text = await request.text();
  if (text.length > maxBytes) throw new Error("Request body too large");
  return JSON.parse(text) as T;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function checkRateLimit(key: string, mode: Mode): string | null {
  const policy = RATE_LIMITS[mode];
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + policy.windowMs });
    return null;
  }
  bucket.count += 1;
  if (bucket.count > policy.limit) return "Rate limit exceeded";
  return null;
}

function clientKey(request: Request, mode: Mode): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = request.headers.get("x-real-ip") || forwarded || "unknown";
  return `${mode}:${realIp}`;
}

function validateServiceMode(mode: Mode, appMode: "client" | "consultant" | "both"): string | null {
  if (appMode === "client" && mode !== "b2c") return "This service allows only customer AI mode";
  if (appMode === "consultant" && mode !== "b2e")
    return "This service allows only consultant AI mode";
  return null;
}

function getConfig() {
  const rawBaseUrl = env("LLM_BASE_URL") || "https://api.openai.com/v1";
  return {
    apiKey: env("LLM_API_KEY") || env("OPENAI_API_KEY") || "",
    baseUrl: validateBaseUrl(rawBaseUrl),
    model: env("LLM_MODEL") || "gpt-4o-mini",
    consultantAccessToken: env("CONSULTANT_ACCESS_TOKEN") || "",
    appMode: normalizeAppMode(env("APP_MODE") || env("VITE_APP_MODE")),
    debug: isEnvEnabled(env("AI_DEBUG") || env("LLM_DEBUG") || env("VITE_AI_DEBUG")),
  };
}

function env(name: string): string | undefined {
  return typeof process !== "undefined" ? process.env[name] : undefined;
}

function isEnvEnabled(value?: string): boolean {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function normalizeAppMode(value?: string): "client" | "consultant" | "both" {
  return value === "consultant" || value === "client" || value === "both" ? value : "both";
}

function validateBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return "https://api.openai.com/v1";
    url.pathname = url.pathname.replace(/\/$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "https://api.openai.com/v1";
  }
}

function safeProviderName(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "configured provider";
  }
}

function json(payload: unknown, status = 200) {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
