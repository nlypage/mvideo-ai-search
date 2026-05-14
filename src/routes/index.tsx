import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  MapPin,
  Store,
  Wrench,
  Phone,
  Search,
  Menu,
  ClipboardList,
  User,
  BarChart3,
  Heart,
  ShoppingCart,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { SearchResults } from "@/components/mv/SearchResults";
import { B2EConsole } from "@/components/mv/B2EConsole";
import { MVideoLogo } from "@/components/mv/MVideoLogo";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  const appMode = ((import.meta.env.VITE_APP_MODE as string | undefined) || "both") as
    | "client"
    | "consultant"
    | "both";
  const effectiveMode = appMode === "consultant" ? "b2e" : "b2c";
  const [searchInput, setSearchInput] = useState("");
  const [submitted, setSubmitted] = useState("");

  function submit() {
    setSubmitted(searchInput.trim());
  }
  return (
    <div className="min-h-screen bg-[#f5f5f5]">
      {/* Top utility bar (dark) */}
      <div className="bg-[#1a1a1a] text-white text-[12px]">
        <div className="mx-auto max-w-[1440px] px-4 h-8 flex items-center gap-5">
          <button className="inline-flex items-center gap-1 hover:text-[var(--mv-red)]">
            <MapPin className="h-3.5 w-3.5 text-[var(--mv-red)]" /> Москва
          </button>
          <button className="inline-flex items-center gap-1 hover:text-[var(--mv-red)]">
            <Store className="h-3.5 w-3.5" /> Магазины
          </button>
          <button className="inline-flex items-center gap-1 hover:text-[var(--mv-red)]">
            <Wrench className="h-3.5 w-3.5" /> Установка и ремонт
          </button>
          <div className="ml-auto flex items-center gap-5 text-white/90">
            <span className="hidden md:inline hover:text-[var(--mv-red)] cursor-pointer">
              Мобильное приложение
            </span>
            <span className="hidden md:inline hover:text-[var(--mv-red)] cursor-pointer">
              М.Комбо
            </span>
            <span className="hidden md:inline hover:text-[var(--mv-red)] cursor-pointer">
              М.Клик
            </span>
            <span className="hidden lg:inline hover:text-[var(--mv-red)] cursor-pointer">
              Стать продавцом
            </span>
            <Phone className="h-3.5 w-3.5" />
          </div>
        </div>
      </div>

      {/* Main white header */}
      <header className="bg-white border-b border-border sticky top-0 z-40">
        <div className="mx-auto max-w-[1440px] px-4 h-[72px] flex items-center gap-4">
          <MVideoLogo className="h-10" />
          <button className="ml-2 inline-flex items-center gap-2 h-11 px-5 rounded-lg bg-[var(--mv-red)] text-white text-[15px] font-semibold hover:bg-[var(--mv-red-dark)]">
            <Menu className="h-4 w-4" /> Каталог
          </button>
          <div className="relative flex-1 max-w-2xl">
            <div className="absolute left-3 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 pointer-events-none">
              <Sparkles className="h-4 w-4 text-[var(--mv-red)]" />
              <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--mv-red)] bg-[var(--mv-red)]/10 px-1.5 py-0.5 rounded">
                AI
              </span>
            </div>
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder="Умный поиск с ИИ — спросите как у эксперта…"
              className="w-full h-11 pl-[88px] pr-12 rounded-lg border border-[#d4d4d4] text-sm focus:outline-none focus:border-[var(--mv-red)] focus:ring-2 focus:ring-[var(--mv-red)]/20"
            />
            <button
              onClick={submit}
              className="absolute right-1 top-1 h-9 w-9 rounded-md bg-[var(--mv-red)] text-white inline-flex items-center justify-center hover:bg-[var(--mv-red-dark)]"
            >
              <Search className="h-4 w-4" />
            </button>
          </div>
          <nav className="ml-auto flex items-center gap-1">
            <HeaderIcon icon={ClipboardList} label="Заказы" />
            <HeaderIcon icon={User} label="Войти" />
            <HeaderIcon icon={BarChart3} label="Сравнение" />
            <HeaderIcon icon={Heart} label="Избранное" />
            <HeaderIcon icon={ShoppingCart} label="Корзина" />
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-[1440px]">
        {effectiveMode === "b2c" ? (
          <SearchResults
            query={submitted}
            onPickSuggestion={(q) => {
              setSearchInput(q);
              setSubmitted(q);
            }}
          />
        ) : (
          <B2EConsole />
        )}
      </main>
    </div>
  );
}

function HeaderIcon({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <button className="flex flex-col items-center justify-center px-2.5 py-1 min-w-[58px] text-[11px] text-foreground/80 hover:text-[var(--mv-red)] transition-colors">
      <Icon className="h-5 w-5 mb-0.5" />
      <span>{label}</span>
    </button>
  );
}
