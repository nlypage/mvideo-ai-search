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
import { ProductCard } from "./ProductCard";
import { chatLLM, type ChatMessage } from "@/lib/mv-llm";
import type { Product } from "@/lib/mv-tools";

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
  const [plan, setPlan] = useState<{
    status: "open" | "approved" | "declined";
    products: Product[];
  } | null>(null);
  const [active, setActive] = useState<ConsoleTab>("catalog");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, loading]);

  async function send(text?: string) {
    const c = (text ?? input).trim();
    if (!c || loading) return;
    setInput("");
    setMessages((m) => [...m, { id: crypto.randomUUID(), role: "user", text: c }]);
    setLoading(true);
    try {
      const history: ChatMessage[] = [
        ...messages.map((m) => ({ role: m.role, content: m.text })),
        { role: "user", content: c },
      ];
      const res = await chatLLM(history, { mode: "b2e" });
      setMessages((m) => [
        ...m,
        { id: crypto.randomUUID(), role: "assistant", text: res.text, products: res.products },
      ]);
      if (res.products && res.products.length > 0) {
        setPlan({ status: "open", products: res.products.slice(0, 3) });
      }
    } catch (error: unknown) {
      setMessages((m) => [
        ...m,
        { id: crypto.randomUUID(), role: "assistant", text: `Ошибка: ${errorMessage(error)}` },
      ]);
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
  const tabs: Array<{ k: ConsoleTab; icon: typeof LayoutGrid; label: string }> = [
    { k: "catalog", icon: LayoutGrid, label: "Каталог" },
    { k: "warehouse", icon: Warehouse, label: "Склад" },
    { k: "profile", icon: User, label: "Профиль" },
  ];

  return (
    <div className="flex h-[calc(100vh-9.25rem)] bg-muted/30">
      {/* Sidebar */}
      <aside className="w-60 bg-white border-r border-border flex flex-col">
        <div className="p-4 flex items-center gap-3 border-b border-border">
          <div className="h-10 w-10 rounded-full bg-[var(--mv-red)] text-white font-bold flex items-center justify-center">
            ИП
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate">Иван Петров</div>
            <div className="text-xs text-muted-foreground">Консультант · ТЦ Авиапарк</div>
          </div>
        </div>
        <nav className="p-2 space-y-1 text-sm">
          {tabs.map((it) => (
            <button
              key={it.k}
              onClick={() => setActive(it.k)}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-left ${
                active === it.k ? "bg-red-50 text-[var(--mv-red)] font-semibold" : "hover:bg-muted"
              }`}
            >
              <it.icon className="h-4 w-4" />
              {it.label}
            </button>
          ))}
        </nav>
        <div className="mt-auto p-3 text-xs text-muted-foreground border-t border-border">
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

      {/* Workspace */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_360px] overflow-hidden">
        {/* Chat column */}
        <section className="flex flex-col bg-white border-r border-border min-h-0">
          <div className="px-5 py-3 border-b border-border flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-[var(--mv-red)]" />
            <div className="text-sm font-semibold">ИИ-помощник консультанта</div>
            <span className="ml-auto text-xs text-muted-foreground">
              тезисы · остатки · допродажи
            </span>
          </div>
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div className={`max-w-[88%] ${m.role === "assistant" ? "w-full" : ""}`}>
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
            {loading && <div className="text-xs text-muted-foreground">Думаю…</div>}
          </div>
          <div className="border-t border-border p-3 flex items-center gap-2 bg-white">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
              placeholder="Запрос клиента: «ищу телевизор для PS5»…"
              className="flex-1 h-10 px-3 rounded-md border border-border text-sm focus:outline-none focus:ring-2 focus:ring-[var(--mv-red)]"
            />
            <button
              onClick={() => send()}
              disabled={!input.trim() || loading}
              className="inline-flex h-10 px-4 items-center gap-1 rounded-md bg-[var(--mv-red)] text-white text-sm font-semibold hover:bg-[var(--mv-red-dark)] disabled:opacity-40"
            >
              <Send className="h-4 w-4" /> Отправить
            </button>
          </div>
        </section>

        {/* Plan column */}
        <aside className="overflow-y-auto p-4 space-y-4">
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
                  <div className="mt-3 grid grid-cols-2 gap-2">
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
            <div className="text-sm font-semibold mb-2">Быстрые сценарии</div>
            <div className="space-y-1.5">
              {[
                "Ищу телевизор для PS5",
                "Что предложить к OLED?",
                "Есть ли DualSense на складе?",
              ].map((q) => (
                <button
                  key={q}
                  onClick={() => send(q)}
                  className="w-full text-left text-sm px-3 py-2 rounded-md border border-border hover:border-[var(--mv-red)] hover:text-[var(--mv-red)]"
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
