import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  Send,
  LayoutGrid,
  Warehouse,
  User,
  TrendingUp,
  CheckCircle2,
  XCircle,
  Sparkles,
} from "lucide-react";
import { AgentDebugPanel } from "./AgentDebugPanel";
import { AgentStreamStatus } from "./AgentStreamStatus";
import { ProductCard } from "./ProductCard";
import {
  chatLLMStream,
  type AgentDebugStep,
  type AgentStreamEvent,
  type ChatMessage,
  type Product,
} from "@/lib/mv-llm";
import { resolveAgentDebugPanelVisibility } from "@/lib/agent-debug";

type UiMsg = { id: string; role: "user" | "assistant"; text: string; products?: Product[] };
type ConsoleTab = "catalog" | "warehouse" | "profile";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "неизвестная ошибка";
}

export function B2EConsole() {
  const [messages, setMessages] = useState<UiMsg[]>([
    {
      id: "init",
      role: "assistant",
      text: "• Готов к подсказкам\n• Уточни товар или категорию\n• Покажу остатки и план допродажи",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [progressEvents, setProgressEvents] = useState<AgentStreamEvent[]>([]);
  const [debugSteps, setDebugSteps] = useState<AgentDebugStep[]>([]);
  const [showDebugPanel, setShowDebugPanel] = useState(false);
  const [plan, setPlan] = useState<{
    status: "open" | "approved" | "declined";
    products: Product[];
  } | null>(null);
  const [active, setActive] = useState<ConsoleTab>("catalog");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, loading]);

  useEffect(() => {
    let cancelled = false;
    resolveAgentDebugPanelVisibility().then((enabled) => {
      if (!cancelled) setShowDebugPanel(enabled);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function send(text?: string) {
    const c = (text ?? input).trim();
    if (!c || loading) return;
    setInput("");
    const assistantId = crypto.randomUUID();
    setMessages((m) => [
      ...m,
      { id: crypto.randomUUID(), role: "user", text: c },
      { id: assistantId, role: "assistant", text: "" },
    ]);
    setProgressEvents([]);
    setLoading(true);
    try {
      const history: ChatMessage[] = [
        ...messages.map((m) => ({ role: m.role, content: m.text })),
        { role: "user", content: c },
      ];
      const res = await chatLLMStream(
        history,
        { mode: "b2e" },
        {
          onDelta: (chunk) => {
            setMessages((items) =>
              items.map((item) =>
                item.id === assistantId ? { ...item, text: item.text + chunk } : item,
              ),
            );
          },
          onEvent: (event) => setProgressEvents((events) => [...events, event]),
        },
      );
      setMessages((m) =>
        m.map((item) =>
          item.id === assistantId ? { ...item, text: res.text, products: res.products } : item,
        ),
      );
      if (res.products && res.products.length > 0) {
        setPlan({ status: "open", products: res.products.slice(0, 3) });
      }
      if (res.debug?.length) setDebugSteps((current) => [...current, ...res.debug!]);
    } catch (error: unknown) {
      setMessages((m) =>
        m.map((item) =>
          item.id === assistantId ? { ...item, text: `Ошибка: ${errorMessage(error)}` } : item,
        ),
      );
    } finally {
      setLoading(false);
    }
  }

  const totalMargin = plan
    ? plan.products.reduce((s, p) => s + (p.price * (p.margin || 0)) / 100, 0)
    : 0;
  const avgMargin =
    plan && plan.products.length
      ? Math.round(plan.products.reduce((s, p) => s + (p.margin || 0), 0) / plan.products.length)
      : 0;
  const streamingTextStarted =
    loading &&
    [...messages]
      .reverse()
      .find((message) => message.role === "assistant")
      ?.text.trim() !== "";
  const tabs: Array<{ k: ConsoleTab; icon: typeof LayoutGrid; label: string }> = [
    { k: "catalog", icon: LayoutGrid, label: "Каталог" },
    { k: "warehouse", icon: Warehouse, label: "Склад" },
    { k: "profile", icon: User, label: "Профиль" },
  ];

  return (
    <div className="bg-muted/30 lg:flex lg:h-[calc(100dvh-9.25rem)]">
      {/* Sidebar */}
      <aside className="hidden w-60 border-r border-border bg-white lg:flex lg:flex-col">
        <div className="flex items-center gap-3 border-b border-border p-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--mv-red)] font-bold text-white">
            ИП
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">Иван Петров</div>
            <div className="text-xs text-muted-foreground">Консультант · ТЦ Авиапарк</div>
          </div>
        </div>
        <nav className="space-y-1 p-2 text-sm">
          {tabs.map((it) => (
            <button
              key={it.k}
              onClick={() => setActive(it.k)}
              className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left ${
                active === it.k ? "bg-red-50 font-semibold text-[var(--mv-red)]" : "hover:bg-muted"
              }`}
            >
              <it.icon className="h-4 w-4" />
              {it.label}
            </button>
          ))}
        </nav>
        <div className="mt-auto border-t border-border p-3 text-xs text-muted-foreground">
          <div className="flex items-center justify-between">
            <span>Смена</span>
            <span className="font-semibold text-emerald-600">активна</span>
          </div>
          <div className="mt-1 flex items-center justify-between">
            <span>План на день</span>
            <span className="font-semibold">62%</span>
          </div>
        </div>
      </aside>

      <div className="border-b border-border bg-white px-3 py-3 lg:hidden">
        <div className="mb-3 flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--mv-red)] text-sm font-bold text-white">
            ИП
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">Иван Петров</div>
            <div className="text-xs text-muted-foreground">Консультант · ТЦ Авиапарк</div>
          </div>
          <div className="ml-auto text-right text-xs text-muted-foreground">
            <div>
              Смена <span className="font-semibold text-emerald-600">активна</span>
            </div>
            <div>
              План <span className="font-semibold text-foreground">62%</span>
            </div>
          </div>
        </div>
        <nav className="grid grid-cols-3 gap-1.5 text-sm">
          {tabs.map((it) => (
            <button
              key={it.k}
              onClick={() => setActive(it.k)}
              className={`inline-flex items-center justify-center gap-1 rounded-md px-2 py-2 ${
                active === it.k ? "bg-red-50 font-semibold text-[var(--mv-red)]" : "bg-muted/60"
              }`}
            >
              <it.icon className="h-4 w-4" />
              <span className="truncate">{it.label}</span>
            </button>
          ))}
        </nav>
      </div>

      {/* Workspace */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_300px] lg:flex-1 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-0">
        {/* Chat column */}
        <section className="flex min-h-[58dvh] flex-col bg-white md:min-h-[calc(100dvh-16rem)] lg:min-h-0 lg:border-r lg:border-border">
          <div className="flex items-center gap-2 border-b border-border px-3 py-3 sm:px-5">
            <Sparkles className="h-4 w-4 text-[var(--mv-red)]" />
            <div className="text-sm font-semibold">ИИ-помощник консультанта</div>
            <span className="ml-auto hidden text-xs text-muted-foreground sm:inline">
              тезисы · остатки · допродажи
            </span>
          </div>
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-4 sm:px-5">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[92%] sm:max-w-[88%] ${m.role === "assistant" ? "w-full" : ""}`}
                >
                  <div
                    className={`rounded-lg px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
                      m.role === "user"
                        ? "bg-[var(--mv-red)] text-white"
                        : "bg-muted/60 border border-border"
                    }`}
                  >
                    {m.role === "assistant" ? (
                      <div className="prose prose-sm max-w-none prose-p:my-1">
                        <ReactMarkdown>{m.text}</ReactMarkdown>
                      </div>
                    ) : (
                      m.text
                    )}
                  </div>
                  {m.products && m.products.length > 0 && (
                    <div className="mt-2 grid sm:grid-cols-2 gap-2">
                      {m.products.map((p) => (
                        <ProductCard key={p.id} product={p} showStock showMargin compact />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {loading && (
              <AgentStreamStatus
                events={progressEvents}
                hasText={streamingTextStarted}
                fallback="Собираю подсказку для консультанта..."
              />
            )}
          </div>
          <div className="flex flex-col gap-2 border-t border-border bg-white p-3 sm:flex-row sm:items-center">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
              placeholder="Запрос клиента: «ищу телевизор для PS5»…"
              className="h-10 w-full rounded-md border border-border px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--mv-red)] sm:flex-1"
            />
            <button
              onClick={() => send()}
              disabled={!input.trim() || loading}
              className="inline-flex h-10 items-center justify-center gap-1 rounded-md bg-[var(--mv-red)] px-4 text-sm font-semibold text-white hover:bg-[var(--mv-red-dark)] disabled:opacity-40"
            >
              <Send className="h-4 w-4" /> Отправить
            </button>
          </div>
        </section>

        {/* Plan column */}
        <aside className="space-y-4 border-t border-border bg-muted/20 p-3 sm:p-4 md:border-t-0 lg:overflow-y-auto">
          {showDebugPanel && (
            <AgentDebugPanel
              steps={debugSteps}
              selectedProducts={
                plan?.products || messages.flatMap((message) => message.products || [])
              }
            />
          )}
          <div className="rounded-xl border-2 border-emerald-500 bg-[var(--mv-success-bg)] p-4">
            <div className="flex items-center gap-2 text-emerald-700 font-semibold">
              <TrendingUp className="h-4 w-4" /> План допродажи
            </div>
            {!plan ? (
              <p className="mt-2 text-sm text-muted-foreground">
                Задай запрос клиента — соберу подсказки и план допродажи с маржой.
              </p>
            ) : (
              <>
                <ul className="mt-3 space-y-1.5 text-sm">
                  {plan.products.map((p) => (
                    <li key={p.id} className="flex items-start gap-2">
                      <span className="text-emerald-600 mt-1">•</span>
                      <div className="flex-1">
                        <div className="font-medium leading-snug">{p.title}</div>
                        <div className="text-xs text-muted-foreground">
                          маржа <b className="text-emerald-700">{p.margin}%</b> ·{" "}
                          {p.price.toLocaleString("ru")} ₽ · склад {p.stock.warehouse}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
                <div className="mt-3 pt-3 border-t border-emerald-200 text-sm flex items-center justify-between">
                  <span className="text-muted-foreground">Доп. маржа корзины</span>
                  <span className="font-bold text-emerald-700">
                    +{Math.round(totalMargin).toLocaleString("ru")} ₽{" "}
                    <span className="text-xs">(ø {avgMargin}%)</span>
                  </span>
                </div>
                {plan.status === "open" ? (
                  <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                    <button
                      onClick={() => setPlan({ ...plan, status: "approved" })}
                      className="inline-flex items-center justify-center gap-1 h-9 rounded-md bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700"
                    >
                      <CheckCircle2 className="h-4 w-4" /> Клиент одобрил
                    </button>
                    <button
                      onClick={() => setPlan({ ...plan, status: "declined" })}
                      className="inline-flex items-center justify-center gap-1 h-9 rounded-md bg-white border border-border text-sm font-semibold hover:bg-muted"
                    >
                      <XCircle className="h-4 w-4" /> Отказался
                    </button>
                  </div>
                ) : (
                  <div
                    className={`mt-3 text-sm font-semibold ${
                      plan.status === "approved" ? "text-emerald-700" : "text-muted-foreground"
                    }`}
                  >
                    {plan.status === "approved" ? "✓ Одобрено клиентом" : "✗ Клиент отказался"}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="rounded-xl border border-border bg-white p-4">
            <div className="mb-2 text-sm font-semibold">Быстрые сценарии</div>
            <div className="space-y-1.5">
              {[
                "Ищу телевизор для PS5",
                "Что предложить к OLED?",
                "Есть ли DualSense на складе?",
              ].map((q) => (
                <button
                  key={q}
                  onClick={() => send(q)}
                  className="w-full rounded-md border border-border px-3 py-2 text-left text-sm hover:border-[var(--mv-red)] hover:text-[var(--mv-red)]"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
