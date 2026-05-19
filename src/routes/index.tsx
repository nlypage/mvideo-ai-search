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
  type LucideIcon,
} from "lucide-react";
import { SearchResults } from "@/components/mv/SearchResults";
import { B2EConsole } from "@/components/mv/B2EConsole";
import { MVideoLogo } from "@/components/mv/MVideoLogo";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  const appMode = ((import.meta.env.VITE_APP_MODE as string | undefined) || "both") as
    | "client"
    | "consultant"
    | "both";
  const effectiveMode = appMode === "consultant" ? "b2e" : "b2c";
  const isClientMode = effectiveMode === "b2c";
  const [searchInput, setSearchInput] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);

  function submit() {
    setSubmitted(searchInput.trim());
  }
  return (
    <div className="min-h-screen bg-[#f5f5f5]">
      {/* Top utility bar (dark) */}
      <div className="bg-[#1a1a1a] text-white text-[12px]">
        <div className="mx-auto max-w-[1440px] px-4 h-8 flex items-center gap-4">
          <button className="inline-flex items-center gap-1 hover:text-[var(--mv-red)]">
            <MapPin className="h-3.5 w-3.5 text-[var(--mv-red)]" /> Москва
          </button>
          <div className="hidden sm:flex items-center gap-4">
            <button className="inline-flex items-center gap-1 hover:text-[var(--mv-red)]">
              <Store className="h-3.5 w-3.5" /> Магазины
            </button>
            <button className="inline-flex items-center gap-1 hover:text-[var(--mv-red)]">
              <Wrench className="h-3.5 w-3.5" /> Установка и ремонт
            </button>
          </div>
          <div className="ml-auto flex items-center gap-4 text-white/90">
            <span className="hidden lg:inline hover:text-[var(--mv-red)] cursor-pointer">
              Мобильное приложение
            </span>
            <span className="hidden xl:inline hover:text-[var(--mv-red)] cursor-pointer">
              М.Комбо
            </span>
            <span className="hidden xl:inline hover:text-[var(--mv-red)] cursor-pointer">
              М.Клик
            </span>
            <span className="hidden 2xl:inline hover:text-[var(--mv-red)] cursor-pointer">
              Стать продавцом
            </span>
            <Phone className="h-3.5 w-3.5" />
          </div>
        </div>
      </div>

      {/* Main white header */}
      <header className="bg-white border-b border-border sticky top-0 z-40">
        <div className="mx-auto max-w-[1440px] px-4 py-2 md:py-0 md:h-[72px] flex flex-col gap-2 md:flex-row md:items-center md:gap-4">
          <div className="flex items-center gap-2 w-full md:w-auto md:flex-shrink-0">
            <MVideoLogo className="h-9 md:h-10" />

            <button className="hidden md:inline-flex items-center gap-2 h-11 px-5 rounded-lg bg-[var(--mv-red)] text-white text-[15px] font-semibold hover:bg-[var(--mv-red-dark)]">
              <Menu className="h-4 w-4" /> Каталог
            </button>

            <div className="ml-auto flex items-center gap-1 md:hidden">
              <HeaderIconCompact icon={User} label="Войти" />
              <HeaderIconCompact icon={ShoppingCart} label="Корзина" />
              <MobileHeaderMenu />
            </div>
          </div>

          <div className="flex w-full items-center gap-2 md:min-w-0 md:flex-1">
            <div className="relative flex-1 md:max-w-2xl">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                placeholder="Поиск в М.Видео"
                className={`w-full h-10 md:h-11 pl-10 pr-12 rounded-lg border border-[#d4d4d4] text-sm transition-shadow focus:outline-none focus:border-transparent focus:ring-2 focus:ring-[#16c6d9]/35 ${
                  searchFocused
                    ? "shadow-[0_0_0_1px_var(--mv-red),0_0_0_4px_rgba(22,198,217,0.12)]"
                    : ""
                }`}
              />
              <button
                onClick={submit}
                className="absolute right-1 top-1 h-8 w-8 md:h-9 md:w-9 rounded-md bg-[var(--mv-red)] text-white inline-flex items-center justify-center hover:bg-[var(--mv-red-dark)]"
              >
                <Search className="h-4 w-4" />
              </button>
              {isClientMode && (
                <div
                  className={`pointer-events-none absolute left-0 top-full mt-1 hidden text-xs text-muted-foreground transition-opacity sm:block ${
                    searchFocused ? "opacity-100" : "opacity-0"
                  }`}
                >
                  Спросите как у консультанта - например, «OLED для PS5 до 250 000»
                </div>
              )}
            </div>
          </div>

          <nav className="hidden lg:flex items-center gap-1 ml-auto">
            <HeaderIcon icon={ClipboardList} label="Заказы" />
            <HeaderIcon icon={User} label="Войти" />
            <HeaderIcon icon={BarChart3} label="Сравнение" />
            <HeaderIcon icon={Heart} label="Избранное" />
            <HeaderIcon icon={ShoppingCart} label="Корзина" />
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-[1440px]">
        {isClientMode ? (
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
    <button className="flex min-w-[58px] flex-col items-center justify-center px-2.5 py-1 text-[11px] text-foreground/80 transition-colors hover:text-[var(--mv-red)]">
      <Icon className="mb-0.5 h-5 w-5" />
      <span>{label}</span>
    </button>
  );
}

function HeaderIconCompact({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <button className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border text-foreground/80 transition-colors hover:border-[var(--mv-red)]/40 hover:text-[var(--mv-red)]">
      <Icon className="h-4 w-4" />
      <span className="sr-only">{label}</span>
    </button>
  );
}

function MobileHeaderMenu() {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <button className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border text-foreground/80 transition-colors hover:border-[var(--mv-red)]/40 hover:text-[var(--mv-red)]">
          <Menu className="h-4 w-4" />
          <span className="sr-only">Открыть меню</span>
        </button>
      </SheetTrigger>
      <SheetContent side="right" className="w-[86vw] max-w-sm p-4">
        <SheetHeader className="text-left">
          <SheetTitle>Меню</SheetTitle>
          <SheetDescription>Разделы и быстрые действия</SheetDescription>
        </SheetHeader>
        <div className="mt-5 space-y-2">
          {["Каталог", "Заказы", "Войти", "Сравнение", "Избранное", "Корзина"].map((item) => (
            <button
              key={item}
              className="w-full rounded-md border border-border px-3 py-2 text-left text-sm transition-colors hover:border-[var(--mv-red)]/40 hover:text-[var(--mv-red)]"
            >
              {item}
            </button>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
