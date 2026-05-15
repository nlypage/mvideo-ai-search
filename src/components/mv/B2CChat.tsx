import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Send, ShoppingBag, X, Plus, Minus, Sparkles } from "lucide-react";
import { ProductCard } from "./ProductCard";
import { VoiceButton } from "./VoiceButton";
import {
  chatLLM,
  crossSellFor,
  type ChatMessage,
  type Product,
  type SourceCitation,
} from "@/lib/mv-llm";

type UiMsg = {
  id: string;
  role: "user" | "assistant";
  text: string;
  products?: Product[];
  sources?: SourceCitation[];
};

type CartItem = { product: Product; qty: number };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "неизвестная ошибка";
}

function SourceLinks({ sources }: { sources: SourceCitation[] }) {
  return (
    <div className="mt-2 rounded-xl border border-[var(--mv-red)]/20 bg-white px-3 py-2 text-xs">
      <div className="font-semibold text-[var(--mv-red)]">Источник · блог М.Видео</div>
      <div className="mt-1 space-y-1">
        {sources.map((source) => (
          <a
            key={source.url}
            href={source.url}
            target="_blank"
            rel="noreferrer"
            className="block text-foreground underline-offset-2 hover:underline"
          >
            {source.title}
          </a>
        ))}
      </div>
    </div>
  );
}

export function B2CChat() {
  const [messages, setMessages] = useState<UiMsg[]>([
    {
      id: "init",
      role: "assistant",
      text: "Здравствуйте! Я подберу технику в М.Видео. Что вас интересует — телевизор, консоль, аудио?",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [lastAdded, setLastAdded] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  async function send(text?: string) {
    const content = (text ?? input).trim();
    if (!content || loading) return;
    setInput("");
    const userMsg: UiMsg = { id: crypto.randomUUID(), role: "user", text: content };
    setMessages((m) => [...m, userMsg]);
    setLoading(true);
    try {
      const history: ChatMessage[] = [
        ...messages.map((m) => ({ role: m.role, content: m.text })),
        { role: "user", content },
      ];
      const res = await chatLLM(history, { mode: "b2c" });
      setMessages((m) => [
        ...m,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          text: res.text,
          products: res.products,
          sources: res.sources,
        },
      ]);
    } catch (error: unknown) {
      setMessages((m) => [
        ...m,
        { id: crypto.randomUUID(), role: "assistant", text: `Ошибка: ${errorMessage(error)}` },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function addToCart(p: Product) {
    setCart((c) => {
      const ex = c.find((i) => i.product.id === p.id);
      if (ex) return c.map((i) => (i.product.id === p.id ? { ...i, qty: i.qty + 1 } : i));
      return [...c, { product: p, qty: 1 }];
    });
    setLastAdded(p.id);
    setCartOpen(true);
  }

  const cartCount = cart.reduce((s, i) => s + i.qty, 0);
  const cartTotal = cart.reduce((s, i) => s + i.qty * i.product.price, 0);

  return (
    <div className="mx-auto flex h-[calc(100vh-9.25rem)] w-full max-w-md flex-col bg-white border-x border-border">
      {/* Sub-header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-white">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-full bg-[var(--mv-red)] flex items-center justify-center">
            <Sparkles className="h-4 w-4 text-white" />
          </div>
          <div>
            <div className="text-sm font-semibold">ИИ-консультант</div>
            <div className="text-xs text-emerald-600">● онлайн</div>
          </div>
        </div>
        <button
          onClick={() => setCartOpen(true)}
          className="relative inline-flex items-center justify-center h-9 w-9 rounded-full hover:bg-muted"
        >
          <ShoppingBag className="h-5 w-5" />
          {cartCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 h-4 min-w-4 px-1 rounded-full bg-[var(--mv-red)] text-white text-[10px] font-bold flex items-center justify-center">
              {cartCount}
            </span>
          )}
        </button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-4 space-y-3 bg-[#fafafa]">
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[85%] ${m.role === "user" ? "" : "w-full"}`}>
              <div
                className={`rounded-2xl px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
                  m.role === "user"
                    ? "bg-[var(--mv-red)] text-white rounded-br-sm"
                    : "bg-white border border-border rounded-bl-sm"
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
              {m.sources && m.sources.length > 0 && <SourceLinks sources={m.sources} />}
              {m.products && m.products.length > 0 && (
                <div className="mt-2 space-y-2">
                  {m.products.map((p) => (
                    <ProductCard key={p.id} product={p} onAdd={addToCart} />
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-white border border-border rounded-2xl rounded-bl-sm px-3.5 py-2 text-sm text-muted-foreground">
              <span className="inline-flex gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-bounce" />
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:0.15s]" />
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:0.3s]" />
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-border bg-white px-3 py-2 flex items-center gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Спросите о товаре…"
          className="flex-1 h-10 px-3 rounded-full bg-muted text-sm focus:outline-none focus:ring-2 focus:ring-[var(--mv-red)]"
        />
        <VoiceButton onText={(t) => send(t)} />
        <button
          onClick={() => send()}
          disabled={!input.trim() || loading}
          className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-[var(--mv-red)] text-white hover:bg-[var(--mv-red-dark)] disabled:opacity-40"
        >
          <Send className="h-4 w-4" />
        </button>
      </div>

      {/* Cart Drawer */}
      {cartOpen && (
        <CartDrawer
          cart={cart}
          setCart={setCart}
          onClose={() => setCartOpen(false)}
          lastAdded={lastAdded}
          total={cartTotal}
        />
      )}
    </div>
  );
}

function CartDrawer({
  cart,
  setCart,
  onClose,
  lastAdded,
  total,
}: {
  cart: CartItem[];
  setCart: (c: CartItem[] | ((c: CartItem[]) => CartItem[])) => void;
  onClose: () => void;
  lastAdded: string | null;
  total: number;
}) {
  const cross = lastAdded ? crossSellFor(lastAdded) : { items: [], rationale: "" };
  const inCartIds = new Set(cart.map((i) => i.product.id));
  const crossItems = cross.items.filter((p) => !inCartIds.has(p.id));

  function addCross(p: Product) {
    setCart((c) => {
      const ex = c.find((i) => i.product.id === p.id);
      if (ex) return c.map((i) => (i.product.id === p.id ? { ...i, qty: i.qty + 1 } : i));
      return [...c, { product: p, qty: 1 }];
    });
  }

  return (
    <div className="absolute inset-0 z-50 flex justify-end" role="dialog">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <aside className="relative w-full max-w-md h-full bg-white flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-4 h-14 border-b border-border bg-[var(--mv-red)] text-white">
          <div className="font-semibold">Корзина</div>
          <button
            onClick={onClose}
            className="h-8 w-8 inline-flex items-center justify-center rounded-full hover:bg-white/10"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {cart.length === 0 && (
            <div className="text-center text-sm text-muted-foreground py-12">Корзина пуста</div>
          )}
          {cart.map((i) => (
            <div
              key={i.product.id}
              className="rounded-lg border border-border bg-card p-3 flex gap-3"
            >
              <img
                src={i.product.image}
                alt=""
                className="h-16 w-16 rounded object-cover bg-muted"
              />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium line-clamp-2">{i.product.title}</div>
                <div className="mt-1 text-sm font-bold">
                  {(i.product.price * i.qty).toLocaleString("ru")} ₽
                </div>
                <div className="mt-2 inline-flex items-center gap-1 rounded-full border border-border">
                  <button
                    onClick={() =>
                      setCart((c) =>
                        c.flatMap((x) =>
                          x.product.id === i.product.id
                            ? x.qty > 1
                              ? [{ ...x, qty: x.qty - 1 }]
                              : []
                            : [x],
                        ),
                      )
                    }
                    className="h-7 w-7 inline-flex items-center justify-center"
                  >
                    <Minus className="h-3 w-3" />
                  </button>
                  <span className="px-1 text-sm w-5 text-center">{i.qty}</span>
                  <button
                    onClick={() =>
                      setCart((c) =>
                        c.map((x) =>
                          x.product.id === i.product.id ? { ...x, qty: x.qty + 1 } : x,
                        ),
                      )
                    }
                    className="h-7 w-7 inline-flex items-center justify-center"
                  >
                    <Plus className="h-3 w-3" />
                  </button>
                </div>
              </div>
            </div>
          ))}

          {crossItems.length > 0 && (
            <div className="mt-4 rounded-xl border-2 border-dashed border-[var(--mv-red)]/40 bg-red-50/40 p-3">
              <div className="flex items-center gap-1.5 text-sm font-semibold text-[var(--mv-red)]">
                <Sparkles className="h-4 w-4" /> ИИ рекомендует — техническое обоснование
              </div>
              <div className="prose prose-sm max-w-none mt-1.5 text-foreground/90">
                <ReactMarkdown>{cross.rationale}</ReactMarkdown>
              </div>
              <div className="mt-3 space-y-2">
                {crossItems.map((p) => (
                  <ProductCard key={p.id} product={p} onAdd={addCross} compact />
                ))}
              </div>
            </div>
          )}
        </div>
        {cart.length > 0 && (
          <div className="border-t border-border p-3 space-y-2 bg-white">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Итого</span>
              <span className="text-xl font-bold">{total.toLocaleString("ru")} ₽</span>
            </div>
            <button className="w-full h-11 rounded-md bg-[var(--mv-red)] text-white font-semibold hover:bg-[var(--mv-red-dark)]">
              Оформить заказ
            </button>
          </div>
        )}
      </aside>
    </div>
  );
}
