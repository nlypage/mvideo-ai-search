import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  Sparkles,
  Send,
  ChevronDown,
  ChevronUp,
  Star,
  ShoppingCart,
  BookOpen,
  ExternalLink,
} from "lucide-react";
import {
  chatLLM,
  searchCatalogProducts,
  type AgentDebugStep,
  type ChatMessage,
  type SourceCitation,
} from "@/lib/mv-llm";
import { isOffTopic } from "@/lib/mv-security";
import type { Product } from "@/lib/mv-tools";

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
        <BookOpen className="h-3 w-3" /> Обоснование · блог М.Видео
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

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const AGENT_STEPS = [
  "Читаю статьи М.Клик…",
  "Смотрю отзывы покупателей…",
  "Сверяю характеристики товаров…",
  "Формулирую рекомендацию…",
];

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
  const [agentStep, setAgentStep] = useState(0);
  const [followUp, setFollowUp] = useState("");
  const [expanded, setExpanded] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Catalog results are independent from the assistant answer.
  const allHits: Product[] = query.trim() ? catalogProducts : [];

  // Kick off AI when initial query changes
  useEffect(() => {
    if (!query.trim()) {
      setTurns([]);
      setCatalogProducts([]);
      setDebugSteps([]);
      setCatalogLoading(false);
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
          text: "Я помогаю только с выбором техники в М.Видео. Сформулируйте, пожалуйста, что вы ищете 🙂",
        },
      ]);
      setCatalogProducts([]);
      setDebugSteps([]);
      setCatalogLoading(false);
      return;
    }
    setTurns([{ id: "u0", role: "user", text: trimmed }]);
    setCatalogProducts([]);
    setDebugSteps([]);
    setLoading(true);
    setCatalogLoading(true);
    setAgentStep(0);

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
        const res = await chatLLM(history, { mode: "b2c" });
        if (cancelled) return;
        setTurns((t) => [
          ...t,
          {
            id: "a0",
            role: "assistant",
            text: res.text,
            sources: res.sources,
            products: mergeProducts([], res.products),
            requestText: trimmed,
          },
        ]);
        if (res.debug?.length) setDebugSteps(res.debug);
      } catch (error: unknown) {
        if (cancelled) return;
        setTurns((t) => [
          ...t,
          { id: "a0", role: "assistant", text: `Ошибка: ${errorMessage(error)}` },
        ]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [query]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, loading]);

  useEffect(() => {
    if (!loading) return;
    const timer = window.setInterval(() => setAgentStep((step) => (step + 1) % 4), 1800);
    return () => window.clearInterval(timer);
  }, [loading]);

  async function sendFollowUp() {
    const text = followUp.trim().slice(0, 500);
    if (!text || loading) return;
    setFollowUp("");
    if (isOffTopic(text)) {
      setTurns((t) => [
        ...t,
        { id: crypto.randomUUID(), role: "user", text },
        {
          id: crypto.randomUUID(),
          role: "assistant",
          text: "Я отвечаю только по технике М.Видео — давайте вернёмся к выбору устройства.",
        },
      ]);
      return;
    }
    const next: Turn[] = [...turns, { id: crypto.randomUUID(), role: "user", text }];
    setTurns(next);
    setLoading(true);
    try {
      const history: ChatMessage[] = [...next.map((t) => ({ role: t.role, content: t.text }))];
      const res = await chatLLM(history, { mode: "b2c" });
      setTurns((t) => [
        ...t,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          text: res.text,
          sources: res.sources,
          products: mergeProducts([], res.products),
          requestText: text,
        },
      ]);
      if (res.debug?.length) setDebugSteps((current) => [...current, ...res.debug!]);
    } catch (error: unknown) {
      setTurns((t) => [
        ...t,
        { id: crypto.randomUUID(), role: "assistant", text: `Ошибка: ${errorMessage(error)}` },
      ]);
    } finally {
      setLoading(false);
    }
  }

  if (!query.trim()) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 text-center">
        <div className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-[var(--mv-red)]/10 mb-4">
          <Sparkles className="h-7 w-7 text-[var(--mv-red)]" />
        </div>
        <h1 className="text-2xl font-bold mb-2">Умный поиск М.Видео</h1>
        <p className="text-muted-foreground">
          Введите запрос в строке поиска — ИИ-ассистент подберёт технику и объяснит выбор.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2 text-sm">
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
              className="rounded-full border border-border bg-white px-3 py-1.5 text-foreground/70 hover:border-[var(--mv-red)] hover:text-[var(--mv-red)] hover:bg-red-50/50 transition-colors cursor-pointer"
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-6 grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
      <div className="min-w-0">
        {/* AI Answer card */}
        <section className="rounded-2xl border border-[var(--mv-red)]/30 bg-gradient-to-br from-red-50/60 to-white shadow-sm overflow-hidden mb-6">
          <header className="flex items-center gap-2 px-4 py-3 border-b border-[var(--mv-red)]/15 bg-white/60">
            <div className="h-7 w-7 rounded-full bg-[var(--mv-red)] flex items-center justify-center">
              <Sparkles className="h-3.5 w-3.5 text-white" />
            </div>
            <div className="text-sm font-semibold">Ответ ИИ-ассистента</div>
            <span className="ml-1 text-[10px] uppercase tracking-wider text-[var(--mv-red)] font-bold bg-[var(--mv-red)]/10 px-1.5 py-0.5 rounded">
              beta
            </span>
            <button
              onClick={() => setExpanded((e) => !e)}
              className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              {expanded ? (
                <>
                  Свернуть <ChevronUp className="h-3 w-3" />
                </>
              ) : (
                <>
                  Развернуть <ChevronDown className="h-3 w-3" />
                </>
              )}
            </button>
          </header>

          {expanded && (
            <>
              <div ref={scrollRef} className="px-4 py-3 max-h-[480px] overflow-y-auto space-y-3">
                {turns.map((t) => {
                  if (t.role === "user") {
                    return (
                      <div key={t.id} className="flex justify-end">
                        <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-[var(--mv-red)] text-white px-3 py-1.5 text-sm">
                          {t.text}
                        </div>
                      </div>
                    );
                  }
                  const { body, sources: inlineSources } = extractSources(t.text);
                  const sources = mergeSources(inlineSources, t.sources || []);
                  const products = mergeProducts([], t.products || []);
                  return (
                    <div key={t.id}>
                      <div className="prose prose-sm max-w-none prose-p:my-1.5 text-foreground">
                        <ReactMarkdown>{body}</ReactMarkdown>
                      </div>
                      {sources.length > 0 && <SourceCitations sources={sources} />}
                      {products.length > 0 && <TurnRecommendations products={products} />}
                    </div>
                  );
                })}
                {loading && (
                  <AgentStatus
                    label={
                      catalogLoading ? "Ищу товары в каталоге М.Видео…" : AGENT_STEPS[agentStep]
                    }
                  />
                )}

                {debugSteps.length > 0 && <AgentDebugPanel steps={debugSteps} />}
              </div>

              {/* Follow-up input */}
              <div className="border-t border-[var(--mv-red)]/15 bg-white px-3 py-2 flex items-center gap-2">
                <input
                  value={followUp}
                  onChange={(e) => setFollowUp(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && sendFollowUp()}
                  placeholder="Уточнить у ИИ…"
                  className="flex-1 h-9 px-3 rounded-full bg-muted text-sm focus:outline-none focus:ring-2 focus:ring-[var(--mv-red)]/40"
                />
                <button
                  onClick={sendFollowUp}
                  disabled={!followUp.trim() || loading}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-[var(--mv-red)] text-white hover:bg-[var(--mv-red-dark)] disabled:opacity-40"
                >
                  <Send className="h-4 w-4" />
                </button>
              </div>
            </>
          )}
        </section>

        {/* Real search results */}
        <div className="mb-3 flex items-baseline gap-3">
          <h2 className="text-base font-semibold">Товары в М.Видео</h2>
          <span className="text-xs text-muted-foreground">
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
        <div className="rounded-xl border border-border bg-white p-4 text-xs text-muted-foreground">
          <div className="font-semibold text-foreground mb-1">М.Бонусы</div>
          Войдите, чтобы копить бонусы и получать персональные цены.
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
        <span>Товары, рекомендованные ИИ</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {visibleProducts.map((product) => (
          <AICard key={product.id} product={product} />
        ))}
      </div>
    </div>
  );
}

function AgentStatus({ label }: { label: string }) {
  return (
    <div className="text-sm text-muted-foreground inline-flex gap-1 items-center">
      <span className="h-1.5 w-1.5 rounded-full bg-[var(--mv-red)] animate-bounce" />
      <span className="h-1.5 w-1.5 rounded-full bg-[var(--mv-red)] animate-bounce [animation-delay:0.15s]" />
      <span className="h-1.5 w-1.5 rounded-full bg-[var(--mv-red)] animate-bounce [animation-delay:0.3s]" />
      <span className="ml-2">{label}</span>
    </div>
  );
}

function AgentDebugPanel({ steps }: { steps: AgentDebugStep[] }) {
  return (
    <details className="rounded-xl border border-slate-200 bg-slate-50/80 p-3 text-xs text-slate-700">
      <summary className="cursor-pointer select-none font-semibold text-slate-900">
        Debug агента · {steps.length} событий
      </summary>
      <div className="mt-3 space-y-2">
        {steps.map((step, index) => (
          <div
            key={`${step.step}-${index}`}
            className="rounded-lg border border-slate-200 bg-white p-2"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-slate-900">{step.title}</span>
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase text-slate-500">
                {step.type} · {step.step + 1}
              </span>
            </div>
            {step.detail && <div className="mt-1 text-slate-600">{step.detail}</div>}
            {(step.args !== undefined || step.result !== undefined) && (
              <pre className="mt-2 max-h-44 overflow-auto rounded bg-slate-950 p-2 text-[11px] leading-relaxed text-slate-100">
                {JSON.stringify(step.args ?? step.result, null, 2)}
              </pre>
            )}
          </div>
        ))}
      </div>
    </details>
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
