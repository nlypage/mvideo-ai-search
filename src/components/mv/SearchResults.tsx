import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  Send,
  ChevronDown,
  ChevronUp,
  Star,
  ShoppingCart,
  BookOpen,
  ExternalLink,
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
    if (!fullyOpen) return;
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
    <div className="mx-auto grid max-w-[1200px] grid-cols-1 gap-4 px-3 py-4 sm:gap-6 sm:px-4 sm:py-6 lg:grid-cols-[1fr_320px]">
      <div className="min-w-0">
        {loading && !fullyOpen && !hasAnyAssistantContent && (
          <AgentStreamStatus
            events={progressEvents}
            hasText={streamingTextStarted}
            fallback={catalogLoading ? "смотрю каталог М.Видео" : "формулирую ответ"}
          />
        )}

        {hasAnswer && (
          <section className="mb-5 overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-red-50/60 via-white to-cyan-50/35 shadow-sm sm:mb-6">
            <header className="flex items-center gap-2 border-b border-border/70 bg-white/75 px-3 py-3 sm:px-4">
              <EmViAvatar className="h-8 w-8" />
              <div className="min-w-0">
                <div className="text-sm font-semibold">Ответ Эм.Ви</div>
                <div className="truncate text-xs text-muted-foreground">
                  по запросу: «{answerRequestText}»
                </div>
              </div>
              {fullyOpen && hasExpandableContent && (
                <button
                  type="button"
                  onClick={() => setFullyOpen(false)}
                  className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  Свернуть <ChevronUp className="h-3.5 w-3.5" />
                </button>
              )}
            </header>

            {fullyOpen ? (
              <>
                <div
                  ref={scrollRef}
                  className="max-h-[62dvh] space-y-2.5 overflow-y-auto px-3 py-3 sm:max-h-[460px] sm:px-4"
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
                      <div key={turn.id} className="flex items-start gap-2">
                        <EmViAvatar className="mt-0.5 h-7 w-7" />
                        <div className="min-w-0 max-w-[min(100%,760px)] flex-1">
                          {hasBody && (
                            <div className="rounded-xl rounded-tl-sm border border-border bg-white/85 px-3 py-2 text-[14px] leading-[1.45] shadow-sm">
                              <div className="prose prose-sm max-w-none prose-p:my-1 prose-ul:my-1 prose-li:my-0.5 text-foreground">
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
                  <div className="flex items-center gap-2 border-t border-border/70 bg-white/80 px-3 py-2 sm:px-4">
                    <input
                      value={followUp}
                      onChange={(e) => setFollowUp(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && void sendFollowUp()}
                      placeholder="Спросите уточнение…"
                      className="h-10 flex-1 rounded-full bg-muted px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--mv-red)]/35 sm:h-9"
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
              <div className="px-3 py-3 sm:px-4 sm:py-4">
                <div
                  className={`relative ${hasExpandableContent ? "max-h-[170px] overflow-hidden" : ""}`}
                >
                  {latestAnswer.body.trim() && (
                    <div className="prose prose-sm max-w-none text-[14px] leading-[1.55] text-foreground prose-p:my-1.5 prose-ul:my-1.5 prose-li:my-0.5">
                      <ReactMarkdown>{latestAnswer.body}</ReactMarkdown>
                    </div>
                  )}

                  {latestSources.length > 0 && <SourceChips sources={latestSources.slice(0, 3)} />}

                  {hasExpandableContent && (
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-white via-white/90 to-transparent" />
                  )}
                </div>

                {hasExpandableContent && (
                  <button
                    type="button"
                    onClick={() => setFullyOpen(true)}
                    className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-full border border-border bg-white px-4 py-2 text-sm font-semibold text-foreground transition-colors hover:border-[var(--mv-red)]/40 hover:text-[var(--mv-red)]"
                  >
                    Показать полностью <ChevronDown className="h-4 w-4" />
                  </button>
                )}
              </div>
            )}
          </section>
        )}

        {/* Real search results */}
        <div className="mb-3 flex flex-col gap-1.5 sm:flex-row sm:items-baseline sm:gap-3">
          <h2 className="text-lg font-semibold">Товары в М.Видео</h2>
          <span className="text-xs leading-relaxed text-muted-foreground">
            {catalogLoading && allHits.length === 0
              ? `Ищем реальные товары М.Видео для «${query}»…`
              : `Найдено ${allHits.length} по реальным данным М.Видео для «${query}»`}
          </span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {allHits.map((p) => (
            <ResultCard key={p.id} product={p} />
          ))}
          {catalogLoading && allHits.length === 0 && <ProductLoadingCards />}
          {!catalogLoading && allHits.length === 0 && (
            <div className="col-span-full text-sm text-muted-foreground p-8 text-center border border-dashed rounded-xl">
              Реальный каталог М.Видео не вернул товары по запросу.
            </div>
          )}
        </div>
      </div>

      <aside className="hidden lg:block space-y-4">
        <div className="rounded-xl border border-border bg-white p-4 text-sm text-muted-foreground">
          <div className="font-semibold text-foreground mb-1">Фильтры</div>
          Фильтры появятся после подключения официального API каталога.
        </div>
      </aside>
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

function ProductLoadingCards() {
  return (
    <>
      {[0, 1, 2, 3, 4, 5].map((item) => (
        <div
          key={item}
          className="rounded-xl border border-border bg-white p-3 animate-pulse"
          aria-label="Ищем товар в М.Видео"
        >
          <div className="aspect-square rounded-lg bg-muted mb-3" />
          <div className="h-4 rounded bg-muted mb-2" />
          <div className="h-4 w-2/3 rounded bg-muted mb-4" />
          <div className="h-5 w-24 rounded bg-muted" />
        </div>
      ))}
    </>
  );
}

function ResultCard({ product }: { product: Product }) {
  return (
    <a
      href={product.url}
      target="_blank"
      rel="noreferrer"
      className="group rounded-xl border border-border bg-white p-3 flex flex-col hover:shadow-md hover:border-[var(--mv-red)]/40 transition"
    >
      <div className="aspect-square rounded-lg bg-muted overflow-hidden mb-2">
        <img
          src={product.image}
          alt={product.title}
          className="h-full w-full object-cover group-hover:scale-105 transition"
          loading="lazy"
        />
      </div>
      <div className="text-sm font-medium leading-snug line-clamp-2 group-hover:text-[var(--mv-red)] min-h-[2.5rem]">
        {product.title}
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Star className="h-3 w-3 fill-amber-400 stroke-amber-400" />
        {product.rating} · {product.reviews}
      </div>
      <div className="mt-2 flex items-end justify-between">
        <div>
          <div className="text-lg font-bold leading-none">
            {product.price.toLocaleString("ru")} ₽
          </div>
          {product.oldPrice && (
            <div className="text-xs text-muted-foreground line-through">
              {product.oldPrice.toLocaleString("ru")} ₽
            </div>
          )}
        </div>
        <span className="inline-flex items-center gap-1 rounded-md bg-[var(--mv-red)] px-2.5 py-1.5 text-xs font-semibold text-white">
          <ShoppingCart className="h-3.5 w-3.5" />
        </span>
      </div>
    </a>
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
        className="h-14 w-14 rounded object-cover bg-muted flex-shrink-0"
        loading="lazy"
      />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium leading-snug line-clamp-2">{product.title}</div>
        <div className="mt-1 text-sm font-bold">{product.price.toLocaleString("ru")} ₽</div>
      </div>
    </a>
  );
}
