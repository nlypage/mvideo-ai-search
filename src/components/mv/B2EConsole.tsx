import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  Send,
  Target,
  User,
  TrendingUp,
  BadgeInfo,
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
type PlanItemStatus = "pending" | "approved" | "declined";
type Plan = {
  status: "open" | "closed";
  items: { product: Product; status: PlanItemStatus }[];
};
type ShiftSummary = {
  approvedItems: number;
  totalItems: number;
  bonus: number;
};
type ConsoleTab = "assistant" | "shift" | "profile";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "неизвестная ошибка";
}

function compactAssistantText(text: string): string {
  return text
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function consultantBonus(product: Product): number {
  return Math.round((product.price * (product.margin || 0)) / 100);
}

function formatMoney(value: number): string {
  return `${value.toLocaleString("ru")} ₽`;
}

function createInitialMessages(): UiMsg[] {
  return [
    {
      id: "init",
      role: "assistant",
      text: "• Готов к подсказкам\n• Уточни товар или категорию\n• Покажу остатки и план допродажи",
    },
  ];
}

export function B2EConsole() {
  const [messages, setMessages] = useState<UiMsg[]>(createInitialMessages);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [progressEvents, setProgressEvents] = useState<AgentStreamEvent[]>([]);
  const [currentStreamingId, setCurrentStreamingId] = useState<string | null>(null);
  const [debugSteps, setDebugSteps] = useState<AgentDebugStep[]>([]);
  const [showDebugPanel, setShowDebugPanel] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [shiftSummary, setShiftSummary] = useState<ShiftSummary>({
    approvedItems: 0,
    totalItems: 0,
    bonus: 0,
  });
  const [active, setActive] = useState<ConsoleTab>("assistant");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, loading]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    resolveAgentDebugPanelVisibility().then((enabled) => {
      if (!cancelled) setShowDebugPanel(enabled);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function resetConsultationContext() {
    setMessages(createInitialMessages());
    setInput("");
    setPlan(null);
    setProgressEvents([]);
    setCurrentStreamingId(null);
    setDebugSteps([]);
    inputRef.current?.focus();
  }

  async function send(text?: string) {
    const c = (text ?? input).trim();
    if (!c || loading) return;
    setInput("");
    const assistantId = crypto.randomUUID();
    setCurrentStreamingId(assistantId);
    setMessages((m) => [...m, { id: crypto.randomUUID(), role: "user", text: c }]);
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
            setMessages((items) => {
              const existing = items.find((item) => item.id === assistantId);
              if (!existing) {
                return [...items, { id: assistantId, role: "assistant", text: chunk }];
              }
              return items.map((item) =>
                item.id === assistantId ? { ...item, text: item.text + chunk } : item,
              );
            });
          },
          onEvent: (event) => setProgressEvents((events) => [...events, event]),
        },
      );
      setMessages((m) => {
        const existing = m.find((item) => item.id === assistantId);
        if (!existing) {
          return [
            ...m,
            { id: assistantId, role: "assistant", text: res.text, products: res.products },
          ];
        }
        return m.map((item) =>
          item.id === assistantId ? { ...item, text: res.text, products: res.products } : item,
        );
      });
      if (res.products && res.products.length > 0) {
        setPlan({
          status: "open",
          items: res.products.slice(0, 4).map((product) => ({ product, status: "pending" })),
        });
      }
      if (res.debug?.length) setDebugSteps((current) => [...current, ...res.debug!]);
    } catch (error: unknown) {
      setMessages((m) => {
        const text = `Не получилось получить подсказку: ${errorMessage(error)}`;
        const existing = m.find((item) => item.id === assistantId);
        if (!existing) return [...m, { id: assistantId, role: "assistant", text }];
        return m.map((item) => (item.id === assistantId ? { ...item, text } : item));
      });
    } finally {
      setLoading(false);
      setCurrentStreamingId(null);
    }
  }

  const planItems = plan?.items || [];
  const approvedItems = planItems.filter((item) => item.status === "approved");
  const declinedCount = planItems.filter((item) => item.status === "declined").length;
  const pendingCount = planItems.filter((item) => item.status === "pending").length;
  const saleBonus = approvedItems.reduce((sum, item) => sum + consultantBonus(item.product), 0);
  const shiftTotalItems = shiftSummary.totalItems + planItems.length;
  const shiftApprovedItems = shiftSummary.approvedItems + approvedItems.length;
  const shiftProgress = Math.round((shiftApprovedItems / Math.max(1, shiftTotalItems)) * 100);
  const shiftBonus = shiftSummary.bonus + saleBonus;
  const setPlanItemStatus = (productId: string, status: PlanItemStatus) => {
    setPlan((current) => {
      if (!current || current.status === "closed") return current;
      return {
        ...current,
        items: current.items.map((item) =>
          item.product.id === productId
            ? { ...item, status: item.status === status ? "pending" : status }
            : item,
        ),
      };
    });
  };
  function finishConsultation() {
    if (plan) {
      setShiftSummary((current) => ({
        approvedItems: current.approvedItems + approvedItems.length,
        totalItems: current.totalItems + plan.items.length,
        bonus: current.bonus + saleBonus,
      }));
    }
    resetConsultationContext();
  }

  const streamingTextStarted =
    loading &&
    currentStreamingId != null &&
    messages.find((message) => message.id === currentStreamingId)?.text.trim() !== "";
  const tabs: Array<{ k: ConsoleTab; icon: typeof Sparkles; label: string; enabled: boolean }> = [
    { k: "assistant", icon: Sparkles, label: "Ассистент", enabled: true },
    { k: "shift", icon: Target, label: "План дня", enabled: false },
    { k: "profile", icon: User, label: "Профиль", enabled: false },
  ];

  return (
    <div className="min-h-screen min-w-0 overflow-x-hidden bg-muted/30 xl:flex xl:h-screen">
      {/* Sidebar */}
      <aside className="hidden w-56 border-r border-border bg-white xl:flex xl:flex-col">
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
              onClick={() => {
                if (it.enabled) setActive(it.k);
              }}
              aria-disabled={!it.enabled}
              title={it.enabled ? undefined : "Раздел скоро будет доступен"}
              className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left ${
                active === it.k
                  ? "bg-red-50 font-semibold text-[var(--mv-red)]"
                  : it.enabled
                    ? "text-muted-foreground hover:bg-muted"
                    : "cursor-not-allowed text-muted-foreground/50"
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
            <span className="font-semibold">{shiftProgress}%</span>
          </div>
          <div className="mt-1 flex items-center justify-between">
            <span>Бонус смены</span>
            <span className="font-semibold">{formatMoney(shiftBonus)}</span>
          </div>
        </div>
      </aside>

      <div className="border-b border-border bg-white px-3 py-3 xl:hidden">
        <div className="mb-3 flex items-center gap-2 sm:gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--mv-red)] text-sm font-bold text-white">
            ИП
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">Иван Петров</div>
            <div className="truncate text-xs text-muted-foreground">Консультант · ТЦ Авиапарк</div>
          </div>
          <div className="shrink-0 text-right text-xs text-muted-foreground">
            <div>
              Смена <span className="font-semibold text-emerald-600">активна</span>
            </div>
            <div>
              План <span className="font-semibold text-foreground">{shiftProgress}%</span>
            </div>
          </div>
        </div>
        <nav className="grid grid-cols-3 gap-1.5 text-sm">
          {tabs.map((it) => (
            <button
              key={it.k}
              onClick={() => {
                if (it.enabled) setActive(it.k);
              }}
              aria-disabled={!it.enabled}
              title={it.enabled ? undefined : "Раздел скоро будет доступен"}
              className={`inline-flex items-center justify-center gap-1 rounded-md px-2 py-2 ${
                active === it.k
                  ? "bg-red-50 font-semibold text-[var(--mv-red)]"
                  : it.enabled
                    ? "bg-muted/60 text-muted-foreground"
                    : "cursor-not-allowed bg-muted/40 text-muted-foreground/50"
              }`}
            >
              <it.icon className="h-4 w-4" />
              <span className="hidden truncate min-[360px]:inline">{it.label}</span>
            </button>
          ))}
        </nav>
      </div>

      {/* Workspace */}
      <div className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_320px] xl:flex-1 xl:grid-cols-[minmax(0,1fr)_360px] xl:gap-0">
        {/* Chat column */}
        <section className="flex min-h-[58dvh] min-w-0 flex-col bg-white lg:min-h-[calc(100dvh-7rem)] lg:border-r lg:border-border xl:min-h-0">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-3 sm:px-5">
            <Sparkles className="h-4 w-4 text-[var(--mv-red)]" />
            <div className="text-sm font-semibold">ИИ-помощник консультанта</div>
            <span
              className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700"
              title="Бонусы и остатки сгенерированы для презентации. Товары и цены берём с mvideo.ru."
            >
              <BadgeInfo className="h-3.5 w-3.5" /> демо-режим
            </span>
          </div>
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-4 sm:px-5">
            {messages
              .filter((m) => m.text.trim() !== "" || (m.products && m.products.length > 0))
              .map((m) => (
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
                        <div className="prose prose-sm max-w-none prose-p:my-0 prose-ul:my-1 prose-li:my-0">
                          <ReactMarkdown>{compactAssistantText(m.text)}</ReactMarkdown>
                        </div>
                      ) : (
                        m.text
                      )}
                    </div>
                    {m.products && m.products.length > 0 && (
                      <div className="mt-2 grid min-w-0 gap-2 sm:grid-cols-2">
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
                fallback="формулирую подсказку"
                tone="b2e"
              />
            )}
          </div>
          <div className="border-t border-border bg-white p-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <textarea
                ref={inputRef}
                value={input}
                rows={1}
                onChange={(e) => setInput(e.target.value)}
                onInput={(e) => {
                  const el = e.currentTarget;
                  el.style.height = "auto";
                  el.style.height = `${Math.min(el.scrollHeight, 112)}px`;
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder="Запрос клиента: «ищу телевизор для PS5»..."
                className="max-h-28 min-h-10 w-full resize-none rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--mv-red)] sm:flex-1"
              />
              <button
                onClick={() => send()}
                disabled={!input.trim() || loading}
                className="inline-flex h-10 items-center justify-center gap-1 rounded-md bg-[var(--mv-red)] px-4 text-sm font-semibold text-white hover:bg-[var(--mv-red-dark)] disabled:opacity-40"
              >
                <Send className="h-4 w-4" /> Отправить
              </button>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              Опиши запрос клиента своими словами - я подскажу аргументы и допродажу
            </div>
          </div>
        </section>

        {/* Plan column */}
        <aside className="min-w-0 space-y-4 border-t border-border bg-muted/20 p-3 sm:p-4 lg:max-h-[calc(100dvh-7rem)] lg:overflow-y-auto lg:border-t-0 xl:max-h-none">
          {showDebugPanel && (
            <AgentDebugPanel
              steps={debugSteps}
              selectedProducts={
                plan?.items.map((item) => item.product) ||
                messages.flatMap((message) => message.products || [])
              }
            />
          )}
          <div className="rounded-xl border-2 border-emerald-500 bg-[var(--mv-success-bg)] p-4">
            <div className="flex items-center gap-2 text-emerald-700 font-semibold">
              <TrendingUp className="h-4 w-4" /> План допродажи
            </div>
            {!plan ? (
              <p className="mt-2 text-sm text-muted-foreground">
                Задай запрос клиента - соберу подсказки и посчитаю бонус за продажу.
              </p>
            ) : (
              <>
                <ul className="mt-3 max-h-[26rem] space-y-2 overflow-y-auto pr-1 text-sm">
                  {plan.items.map(({ product, status }) => (
                    <li
                      key={product.id}
                      className="rounded-lg border border-emerald-200 bg-white/70 p-2"
                    >
                      <div className="font-medium leading-snug">{product.title}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        бонус консультанта{" "}
                        <b className="text-emerald-700">{formatMoney(consultantBonus(product))}</b>{" "}
                        · {formatMoney(product.price)} · на складе РЦ: {product.stock.warehouse} · в
                        зале: {product.stock.store}
                      </div>
                      <div
                        className="mt-2 flex gap-1.5"
                        role="radiogroup"
                        aria-label="Статус позиции"
                      >
                        <button
                          type="button"
                          disabled={plan.status === "closed"}
                          aria-pressed={status === "approved"}
                          onClick={() => setPlanItemStatus(product.id, "approved")}
                          className={`inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-semibold disabled:opacity-60 ${
                            status === "approved"
                              ? "bg-emerald-600 text-white"
                              : "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                          }`}
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" /> Взял
                        </button>
                        <button
                          type="button"
                          disabled={plan.status === "closed"}
                          aria-pressed={status === "declined"}
                          onClick={() => setPlanItemStatus(product.id, "declined")}
                          className={`inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-semibold disabled:opacity-60 ${
                            status === "declined"
                              ? "bg-slate-700 text-white"
                              : "bg-white text-muted-foreground ring-1 ring-border hover:bg-muted"
                          }`}
                        >
                          <XCircle className="h-3.5 w-3.5" /> Отказался
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
                <div className="mt-3 border-t border-emerald-200 pt-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Бонус за продажу</span>
                    <span className="font-bold text-emerald-700">{formatMoney(saleBonus)}</span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Взято: {approvedItems.length} · Отказ: {declinedCount} · Ожидает: {pendingCount}
                  </div>
                </div>
                {plan.status === "open" ? (
                  <button
                    onClick={finishConsultation}
                    className="mt-3 inline-flex h-9 w-full items-center justify-center rounded-md bg-emerald-600 text-sm font-semibold text-white hover:bg-emerald-700"
                  >
                    Завершить и очистить чат
                  </button>
                ) : (
                  <div className="mt-3 text-sm font-semibold text-emerald-700">
                    Консультация закрыта: взято {approvedItems.length} из {plan.items.length}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="rounded-xl border border-border bg-white p-4">
            <div className="mb-2 text-sm font-semibold">Быстрые сценарии</div>
            <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 lg:block lg:space-y-1.5 lg:overflow-visible lg:pb-0">
              {[
                "Клиенту нужна стиральная машина до 40 тысяч",
                "Подбери наушники в подарок жене",
                "Что предложить к холодильнику Atlant?",
                "Клиент сравнивает iPhone 15 и Galaxy S24",
              ].map((q) => (
                <button
                  key={q}
                  onClick={() => send(q)}
                  className="min-w-[220px] rounded-md border border-border px-3 py-2 text-left text-sm hover:border-[var(--mv-red)] hover:text-[var(--mv-red)] lg:w-full lg:min-w-0"
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
