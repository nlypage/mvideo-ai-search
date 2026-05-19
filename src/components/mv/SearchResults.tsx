import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  Send,
  ChevronDown,
  ChevronUp,
  ShoppingCart,
  BookOpen,
  ExternalLink,
  Heart,
  SlidersHorizontal,
  ArrowDownUp,
} from "lucide-react";
import { AgentDebugPanel } from "./AgentDebugPanel";
import { AgentStreamStatus } from "./AgentStreamStatus";
import { EmViAvatar } from "./EmViAvatar";
import {
  chatLLMStream,
  searchCatalogProducts,
  type AgentDebugStep,
  type AgentStreamEvent,
  isOffTopic,
  type ChatMessage,
  type Product,
  type SourceCitation,
} from "@/lib/mv-llm";
import { resolveAgentDebugPanelVisibility } from "@/lib/agent-debug";

type Turn = {
  id: string;
  role: "user" | "assistant";
  text: string;
  sources?: SourceCitation[];
  products?: Product[];
  requestText?: string;
};

type Source = SourceCitation;

/** Pull markdown links that follow an "Источник:" / "Sources:" / "Источники:" marker
 *  out of the body so we can render them as a styled citation block. */
function extractSources(text: string): { body: string; sources: Source[] } {
  const sources: Source[] = [];
  const linkRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  // Match a line starting with "Источник(и):" or "Sources:" — capture the rest of the line
  const lineRe = /^[\s•\-*]*(?:Источник(?:и)?|Sources?)\s*[:：]\s*(.+)$/gim;
  const body = text
    .replace(lineRe, (_full, payload: string) => {
      let m: RegExpExecArray | null;
      linkRe.lastIndex = 0;
      while ((m = linkRe.exec(payload)) !== null) {
        sources.push({ title: m[1].trim(), url: m[2].trim() });
      }
      return ""; // strip the line from body
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // Dedupe by url
  const seen = new Set<string>();
  const unique = sources.filter((s) => (seen.has(s.url) ? false : (seen.add(s.url), true)));
  return { body, sources: unique };
}

function mergeSources(...groups: Source[][]): Source[] {
  const seen = new Set<string>();
  return groups.flat().filter((source) => {
    const key = source.url;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function SourceCitations({ sources }: { sources: Source[] }) {
  return (
    <div className="mt-3 rounded-xl border border-[var(--mv-red)]/25 bg-white/80 backdrop-blur p-2.5">
      <div className="flex items-center gap-1.5 mb-2 text-[10px] font-bold uppercase tracking-wider text-[var(--mv-red)]">
        <BookOpen className="h-3 w-3" /> Источники
      </div>
      <div className="space-y-1.5">
        {sources.map((s) => (
          <a
            key={s.url}
            href={s.url}
            target="_blank"
            rel="noreferrer"
            className="group flex items-start gap-2 rounded-lg border border-border bg-white px-2.5 py-2 hover:border-[var(--mv-red)] hover:bg-red-50/40 transition-colors"
          >
            <span className="mt-0.5 inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded bg-[var(--mv-red)]/10 text-[var(--mv-red)]">
              <BookOpen className="h-3 w-3" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium leading-snug text-foreground group-hover:text-[var(--mv-red)] line-clamp-2">
                {s.title}
              </span>
              <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                {hostnameOf(s.url)} <ExternalLink className="h-3 w-3" />
              </span>
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}

function SourceChips({ sources }: { sources: Source[] }) {
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {sources.map((source) => (
        <a
          key={source.url}
          href={source.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-white/85 px-2.5 py-1 text-xs text-muted-foreground transition hover:border-[var(--mv-red)]/40 hover:text-foreground"
        >
          <BookOpen className="h-3 w-3 shrink-0 text-[var(--mv-red)]" />
          <span className="truncate">{hostnameOf(source.url)}</span>
        </a>
      ))}
    </div>
  );
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "неизвестная ошибка";
}

function mergeProducts(current: Product[], incoming: Product[] = []): Product[] {
  const seen = new Set<string>();
  return [...current, ...incoming].filter((product) => {
    const key = product.id || product.url || product.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function SearchResults({
  query,
  onPickSuggestion,
}: {
  query: string;
  onPickSuggestion?: (q: string) => void;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [catalogProducts, setCatalogProducts] = useState<Product[]>([]);
  const [debugSteps, setDebugSteps] = useState<AgentDebugStep[]>([]);
  const [loading, setLoading] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [progressEvents, setProgressEvents] = useState<AgentStreamEvent[]>([]);
  const [followUp, setFollowUp] = useState("");
  const [fullyOpen, setFullyOpen] = useState(false);
  const [showDebugPanel, setShowDebugPanel] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasFullyOpenRef = useRef(false);

  // Catalog results are independent from the assistant answer.
  const allHits: Product[] = query.trim() ? catalogProducts : [];
  const latestAssistantTurn = [...turns].reverse().find((turn) => turn.role === "assistant");
  const latestAssistantText = latestAssistantTurn?.text.trim() || "";
  const latestAnswer = extractSources(latestAssistantText);
  const latestSources = mergeSources(latestAnswer.sources, latestAssistantTurn?.sources || []);
  const latestProducts = mergeProducts([], latestAssistantTurn?.products || []);
  const selectedDebugProducts = mergeProducts(
    [],
    turns.flatMap((turn) => turn.products || []),
  );
  const hasAnyAssistantContent = turns.some(
    (turn) =>
      turn.role === "assistant" &&
      (turn.text.trim() !== "" || Boolean(turn.sources?.length) || Boolean(turn.products?.length)),
  );
  const hasAnswer = hasAnyAssistantContent || (fullyOpen && turns.length > 0);
  const streamingTextStarted = loading && latestAssistantText !== "";
  const isCompactAnswer =
    latestAssistantText.startsWith("Ошибка:") ||
    latestAssistantText.startsWith("Помогаю только") ||
    latestAssistantText.startsWith("Отвечаю только");
  const hasExpandableContent =
    !isCompactAnswer &&
    (loading ||
      latestAnswer.body.length > 420 ||
      latestSources.length > 0 ||
      latestProducts.length > 0 ||
      turns.length > 2);
  const answerRequestText = turns.find((turn) => turn.role === "user")?.text || query;

  useEffect(() => {
    let cancelled = false;
    resolveAgentDebugPanelVisibility().then((enabled) => {
      if (!cancelled) setShowDebugPanel(enabled);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const wasFullyOpen = wasFullyOpenRef.current;
    wasFullyOpenRef.current = fullyOpen;

    if (!fullyOpen || !wasFullyOpen) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [fullyOpen, loading, turns]);

  // Kick off AI when initial query changes
  useEffect(() => {
    setFullyOpen(false);
    if (!query.trim()) {
      setTurns([]);
      setCatalogProducts([]);
      setDebugSteps([]);
      setProgressEvents([]);
      setCatalogLoading(false);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const trimmed = query.trim().slice(0, 500);
    if (isOffTopic(trimmed)) {
      setTurns([
        { id: "u0", role: "user", text: trimmed },
        {
          id: "a0",
          role: "assistant",
          text: "Помогаю только с выбором техники в М.Видео. Сформулируйте, пожалуйста, что вы ищете 🙂",
        },
      ]);
      setCatalogProducts([]);
      setDebugSteps([]);
      setProgressEvents([]);
      setCatalogLoading(false);
      setLoading(false);
      return;
    }
    setTurns([
      { id: "u0", role: "user", text: trimmed },
      { id: "a0", role: "assistant", text: "" },
    ]);
    setCatalogProducts([]);
    setDebugSteps([]);
    setProgressEvents([]);
    setLoading(true);
    setCatalogLoading(true);

    (async () => {
      try {
        const products = await searchCatalogProducts(trimmed);
        if (!cancelled) setCatalogProducts(products);
      } finally {
        if (!cancelled) setCatalogLoading(false);
      }
    })();

    (async () => {
      try {
        const history: ChatMessage[] = [{ role: "user", content: trimmed }];
        const res = await chatLLMStream(
          history,
          { mode: "b2c" },
          {
            onDelta: (chunk) => {
              if (cancelled) return;
              setTurns((items) =>
                items.map((item) =>
                  item.id === "a0" ? { ...item, text: item.text + chunk } : item,
                ),
              );
            },
            onEvent: (event) => {
              if (!cancelled) setProgressEvents((events) => [...events, event]);
            },
          },
        );
        if (cancelled) return;
        setTurns((t) =>
          t.map((item) =>
            item.id === "a0"
              ? {
                  ...item,
                  text: res.text,
                  sources: res.sources,
                  products: mergeProducts([], res.products),
                  requestText: trimmed,
                }
              : item,
          ),
        );
        if (res.debug?.length) setDebugSteps(res.debug);
      } catch (error: unknown) {
        if (cancelled) return;
        setTurns((t) =>
          t.map((item) =>
            item.id === "a0" ? { ...item, text: `Ошибка: ${errorMessage(error)}` } : item,
          ),
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [query]);

  async function sendFollowUp(nextText?: string) {
    const text = (nextText || followUp).trim().slice(0, 500);
    if (!text || loading) return;
    setFollowUp("");
    setFullyOpen(true);
    if (isOffTopic(text)) {
      setTurns((t) => [
        ...t,
        { id: crypto.randomUUID(), role: "user", text },
        {
          id: crypto.randomUUID(),
          role: "assistant",
          text: "Отвечаю только по технике М.Видео - давайте вернёмся к выбору устройства 🙂",
        },
      ]);
      return;
    }
    const assistantId = crypto.randomUUID();
    const next: Turn[] = [
      ...turns,
      { id: crypto.randomUUID(), role: "user", text },
      { id: assistantId, role: "assistant", text: "" },
    ];
    setTurns(next);
    setProgressEvents([]);
    setLoading(true);
    try {
      const history: ChatMessage[] = [...next.map((t) => ({ role: t.role, content: t.text }))];
      const res = await chatLLMStream(
        history,
        { mode: "b2c" },
        {
          onDelta: (chunk) => {
            setTurns((items) =>
              items.map((item) =>
                item.id === assistantId ? { ...item, text: item.text + chunk } : item,
              ),
            );
          },
          onEvent: (event) => setProgressEvents((events) => [...events, event]),
        },
      );
      setTurns((t) =>
        t.map((item) =>
          item.id === assistantId
            ? {
                ...item,
                text: res.text,
                sources: res.sources,
                products: mergeProducts([], res.products),
                requestText: text,
              }
            : item,
        ),
      );
      if (res.debug?.length) setDebugSteps((current) => [...current, ...res.debug!]);
    } catch (error: unknown) {
      setTurns((t) =>
        t.map((item) =>
          item.id === assistantId ? { ...item, text: `Ошибка: ${errorMessage(error)}` } : item,
        ),
      );
    } finally {
      setLoading(false);
    }
  }

  if (!query.trim()) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-9 sm:py-12">
        <div className="mx-auto max-w-3xl text-center">
          <h1 className="mb-3 text-2xl font-bold sm:text-[2rem]">Что подбираем сегодня?</h1>
          <div className="mt-6 text-xs font-semibold text-muted-foreground sm:text-sm">
            Часто ищут
          </div>
          <div className="mt-3 flex flex-wrap justify-center gap-2 text-xs sm:text-sm">
            {[
              "OLED-телевизор для PS5 до 250 000",
              "Подарок подростку до 5 000",
              "Ноутбук для разработки до 120 000",
              "Саундбар к ТВ до 40 000",
            ].map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onPickSuggestion?.(s)}
                className="cursor-pointer rounded-full border border-border bg-white px-3 py-1.5 text-foreground/70 transition-colors hover:border-[var(--mv-red)] hover:bg-red-50/50 hover:text-[var(--mv-red)]"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1484px] px-4 py-5 sm:px-6 lg:px-8">
      {loading && !fullyOpen && !hasAnyAssistantContent && (
        <div className="mb-5 max-w-[920px]">
          <AgentStreamStatus
            events={progressEvents}
            hasText={streamingTextStarted}
            fallback={catalogLoading ? "смотрю каталог М.Видео" : "формулирую ответ"}
          />
        </div>
      )}

      {hasAnswer && (
        <section className="mb-6 max-w-[920px] overflow-hidden rounded-2xl border border-[#e1e5eb] bg-white shadow-[0_8px_28px_rgba(34,42,53,0.08)]">
          <header className="flex items-center gap-3 border-b border-[#eef0f3] bg-white px-4 py-3">
            <EmViAvatar className="h-9 w-9" />
            <div className="min-w-0">
              <div className="text-[15px] font-bold text-[#1f232a]">Ответ Эм.Ви</div>
              <div className="truncate text-xs text-[#818794]">
                по запросу: «{answerRequestText}»
              </div>
            </div>
            {fullyOpen && hasExpandableContent && (
              <button
                type="button"
                onClick={() => setFullyOpen(false)}
                className="ml-auto inline-flex items-center gap-1 rounded-full bg-[#f2f3f5] px-3 py-1.5 text-xs font-semibold text-[#4b515b] transition-colors hover:text-[var(--mv-red)]"
              >
                Свернуть <ChevronUp className="h-3.5 w-3.5" />
              </button>
            )}
          </header>

          {fullyOpen ? (
            <>
              <div
                ref={scrollRef}
                className="max-h-[62dvh] space-y-3 overflow-y-auto bg-[#fafbfc] px-4 py-4 sm:max-h-[460px]"
              >
                {turns.map((turn) => {
                  if (turn.role === "user") {
                    return (
                      <div key={turn.id} className="flex justify-end">
                        <div className="max-w-[86%] rounded-2xl rounded-br-sm bg-[var(--mv-red)] px-3 py-1.5 text-sm text-white sm:max-w-[80%]">
                          {turn.text}
                        </div>
                      </div>
                    );
                  }

                  const { body, sources: inlineSources } = extractSources(turn.text);
                  const sources = mergeSources(inlineSources, turn.sources || []);
                  const products = mergeProducts([], turn.products || []);
                  const hasBody = body.trim() !== "";
                  const isStreamingTurn = loading && latestAssistantTurn?.id === turn.id;

                  if (!hasBody && sources.length === 0 && products.length === 0) {
                    return isStreamingTurn ? (
                      <AgentStreamStatus
                        key={turn.id}
                        events={progressEvents}
                        hasText={streamingTextStarted}
                        fallback="формулирую ответ"
                      />
                    ) : null;
                  }

                  return (
                    <div key={turn.id} className="flex items-start gap-2.5">
                      <EmViAvatar className="mt-0.5 h-7 w-7" />
                      <div className="min-w-0 max-w-[min(100%,760px)] flex-1">
                        {hasBody && (
                          <div className="rounded-xl rounded-tl-sm border border-[#e4e7ec] bg-white px-3 py-2 text-[14px] leading-[1.45] shadow-sm">
                            <div className="prose prose-sm max-w-none prose-p:my-1 prose-ul:my-1 prose-li:my-0.5 text-[#1f232a]">
                              <ReactMarkdown>{body}</ReactMarkdown>
                            </div>
                          </div>
                        )}
                        {sources.length > 0 && <SourceCitations sources={sources} />}
                        {products.length > 0 && <TurnRecommendations products={products} />}
                      </div>
                    </div>
                  );
                })}
                {showDebugPanel && (
                  <AgentDebugPanel
                    steps={debugSteps}
                    selectedProducts={selectedDebugProducts}
                    className="mt-2"
                    heading="Как Эм.Ви думала под капотом"
                    checkedDataLabel="Какие данные проверила"
                    emptyAssistantLabel="Эм.Ви"
                  />
                )}
              </div>

              {!isCompactAnswer && (
                <div className="flex items-center gap-2 border-t border-[#eef0f3] bg-white px-4 py-3">
                  <input
                    value={followUp}
                    onChange={(e) => setFollowUp(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && void sendFollowUp()}
                    placeholder="Спросите уточнение…"
                    className="h-10 flex-1 rounded-full bg-[#f2f3f5] px-4 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--mv-red)]/25 sm:h-9"
                  />
                  <button
                    type="button"
                    onClick={() => void sendFollowUp()}
                    disabled={!followUp.trim() || loading}
                    className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-[var(--mv-red)] text-white hover:bg-[var(--mv-red-dark)] disabled:opacity-40 sm:h-9 sm:w-9"
                  >
                    <Send className="h-4 w-4" />
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="px-4 py-4">
              <div
                className={`relative ${hasExpandableContent ? "max-h-[150px] overflow-hidden" : ""}`}
              >
                {latestAnswer.body.trim() && (
                  <div className="prose prose-sm max-w-none text-[14px] leading-[1.55] text-[#1f232a] prose-p:my-1.5 prose-ul:my-1.5 prose-li:my-0.5">
                    <ReactMarkdown>{latestAnswer.body}</ReactMarkdown>
                  </div>
                )}

                {latestSources.length > 0 && <SourceChips sources={latestSources.slice(0, 3)} />}

                {hasExpandableContent && (
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-white via-white/90 to-transparent" />
                )}
              </div>

              {hasExpandableContent && (
                <button
                  type="button"
                  onClick={() => setFullyOpen(true)}
                  className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-full border border-[#dfe3e8] bg-white px-4 py-2 text-sm font-semibold text-[#1f232a] transition-colors hover:border-[var(--mv-red)]/40 hover:text-[var(--mv-red)]"
                >
                  Показать полностью <ChevronDown className="h-4 w-4" />
                </button>
              )}
            </div>
          )}
        </section>
      )}

      <div className="mb-4 flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-[28px] font-bold leading-tight text-[#1f232a]">{query}</h1>
          <span className="text-[15px] text-[#8b929d]">
            {catalogLoading && allHits.length === 0
              ? "ищем товары"
              : `${allHits.length.toLocaleString("ru")} найдено товаров`}
          </span>
        </div>
        <ProductFilterBar />
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-8 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
        {allHits.map((p) => (
          <ResultCard key={p.id} product={p} />
        ))}
        {catalogLoading && allHits.length === 0 && <ProductLoadingCards />}
        {!catalogLoading && allHits.length === 0 && (
          <div className="col-span-full rounded-2xl border border-dashed border-[#d9dde5] bg-white p-10 text-center text-sm text-[#6a717d]">
            Реальный каталог М.Видео не вернул товары по запросу.
          </div>
        )}
      </div>
    </div>
  );
}

function TurnRecommendations({ products }: { products: Product[] }) {
  const visibleProducts = products.slice(0, 4);
  return (
    <div className="mt-3 rounded-xl border border-[var(--mv-red)]/20 bg-white/75 p-2.5">
      <div className="mb-2 flex items-start gap-1.5 text-xs font-semibold text-muted-foreground">
        <ShoppingCart className="mt-0.5 h-3.5 w-3.5 text-[var(--mv-red)]" />
        <span>Что советует Эм.Ви</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {visibleProducts.map((product) => (
          <AICard key={product.id} product={product} />
        ))}
      </div>
    </div>
  );
}

function ProductFilterBar() {
  const filters = [
    { label: "Популярные", icon: ArrowDownUp },
    { label: "Все фильтры", icon: SlidersHorizontal },
    { label: "Цена", caret: true },
    { label: "Категория", caret: true },
    { label: "Бренд", caret: true },
    { label: "Доставить курьером" },
  ];

  return (
    <div className="flex gap-1.5 overflow-x-auto pb-1 text-[14px] text-[#252a32]">
      {filters.map((filter) => {
        const Icon = filter.icon;
        return (
          <button
            key={filter.label}
            type="button"
            className="inline-flex h-9 shrink-0 items-center gap-2 rounded-xl bg-[#f2f3f5] px-3.5 font-medium transition-colors hover:bg-[#e8ebef]"
          >
            {Icon && <Icon className="h-4 w-4" />}
            {filter.label}
            {filter.caret && <ChevronDown className="h-4 w-4" />}
          </button>
        );
      })}
    </div>
  );
}

function ProductLoadingCards() {
  return (
    <>
      {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((item) => (
        <div key={item} className="animate-pulse" aria-label="Ищем товар в М.Видео">
          <div className="aspect-[0.86] bg-[#f3f4f6]" />
          <div className="mt-3 h-5 w-28 rounded bg-[#eef0f3]" />
          <div className="mt-2 h-4 rounded bg-[#eef0f3]" />
          <div className="mt-1 h-4 w-4/5 rounded bg-[#eef0f3]" />
          <div className="mt-4 h-10 rounded-xl bg-[#eef0f3]" />
        </div>
      ))}
    </>
  );
}

function ResultCard({ product }: { product: Product }) {
  const hasDiscount = Boolean(product.oldPrice && product.oldPrice > product.price);
  const discount = hasDiscount
    ? Math.round(((product.oldPrice! - product.price) / product.oldPrice!) * 100)
    : 0;
  const clubBonus = Math.max(1, Math.round(product.price * 0.06));

  return (
    <div className="group min-w-0 bg-white">
      <a
        href={product.url}
        target="_blank"
        rel="noreferrer"
        className="block aspect-[0.86] overflow-hidden bg-white"
      >
        <img
          src={product.image}
          alt={product.title}
          className="h-full w-full bg-white object-contain transition duration-300 group-hover:scale-[1.03]"
          loading="lazy"
        />
      </a>

      <div className="mt-2 inline-flex h-5 items-center bg-[var(--mv-red)] px-2 text-[11px] font-bold text-white">
        М +{clubBonus.toLocaleString("ru")}
      </div>

      <div className="mt-2 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        <div className="text-[18px] font-bold leading-none text-[#1f232a]">
          {product.price.toLocaleString("ru")} ₽
        </div>
        {product.oldPrice && (
          <div className="text-[12px] text-[#9aa1ac] line-through">
            {product.oldPrice.toLocaleString("ru")} ₽
          </div>
        )}
        {hasDiscount && (
          <div className="text-[12px] font-semibold text-[var(--mv-red)]">-{discount}%</div>
        )}
      </div>

      <a
        href={product.url}
        target="_blank"
        rel="noreferrer"
        className="mt-1.5 block min-h-[42px] text-[13px] leading-[1.28] text-[#2f3540] transition-colors line-clamp-2 hover:text-[var(--mv-red)]"
      >
        {product.title}
      </a>

      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          className="h-10 flex-1 rounded-xl bg-[#ff0032] px-3 text-[15px] font-semibold text-white transition-colors hover:bg-[var(--mv-red-dark)]"
        >
          В корзину
        </button>
        <button
          type="button"
          aria-label="Добавить в избранное"
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#f5f6f8] text-[#1f232a] transition-colors hover:text-[var(--mv-red)]"
        >
          <Heart className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}

function AICard({ product }: { product: Product }) {
  return (
    <a
      href={product.url}
      target="_blank"
      rel="noreferrer"
      className="rounded-lg border border-border bg-white p-2.5 flex gap-2.5 hover:border-[var(--mv-red)]/40 transition"
    >
      <img
        src={product.image}
        alt=""
        className="h-14 w-14 rounded bg-white object-cover flex-shrink-0"
        loading="lazy"
      />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium leading-snug line-clamp-2">{product.title}</div>
        <div className="mt-1 text-sm font-bold">{product.price.toLocaleString("ru")} ₽</div>
      </div>
    </a>
  );
}
