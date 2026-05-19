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
import { VoiceButton } from "@/components/mv/VoiceButton";
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

const CATALOG_ICON_HREF =
  "/e3eacfcf7eb23503951ca5c089d6c47c35ff8f27/sprites/sprite.symbol.svg#hamburger-search";

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
    <div className="min-h-screen bg-[var(--mv-page)]">
      {isClientMode && (
        <>
          {/* Top utility bar */}
          <div className="border-b border-[#e6e8ec] bg-[#f7f8fa] text-[12px] text-[#626975]">
            <div className="mx-auto flex h-8 max-w-[1440px] items-center gap-4 px-4">
              <button className="inline-flex items-center gap-1 transition-colors hover:text-[var(--mv-red)]">
                <MapPin className="h-3.5 w-3.5 text-[var(--mv-red)]" /> Москва
              </button>
              <div className="hidden items-center gap-4 sm:flex">
                <button className="inline-flex items-center gap-1 transition-colors hover:text-[var(--mv-red)]">
                  <Store className="h-3.5 w-3.5" /> Магазины
                </button>
                <button className="inline-flex items-center gap-1 transition-colors hover:text-[var(--mv-red)]">
                  <Wrench className="h-3.5 w-3.5" /> Установка и ремонт
                </button>
              </div>
              <div className="ml-auto flex items-center gap-4 text-[#626975]">
                <span className="hidden cursor-pointer transition-colors hover:text-[var(--mv-red)] lg:inline">
                  Мобильное приложение
                </span>
                <span className="hidden cursor-pointer transition-colors hover:text-[var(--mv-red)] xl:inline">
                  М.Комбо
                </span>
                <span className="hidden cursor-pointer transition-colors hover:text-[var(--mv-red)] xl:inline">
                  М.Клик
                </span>
                <span className="hidden cursor-pointer transition-colors hover:text-[var(--mv-red)] 2xl:inline">
                  Стать продавцом
                </span>
                <Phone className="h-3.5 w-3.5" />
              </div>
            </div>
          </div>

          {/* Main white header */}
          <header className="sticky top-0 z-40 border-b border-[#e5e7eb] bg-white shadow-[0_2px_12px_rgba(34,42,53,0.06)]">
            <div className="mx-auto flex max-w-[1440px] flex-col gap-2 px-4 py-2 md:h-[68px] md:flex-row md:items-center md:gap-4 md:py-0">
              <div className="flex w-full items-center gap-3 md:w-auto md:flex-shrink-0">
                <MVideoLogo className="h-9 md:h-12" />

                <button className="hidden h-11 items-center gap-2 rounded-xl bg-[var(--mv-red)] px-4 text-[15px] font-semibold text-white shadow-[0_5px_14px_rgba(227,6,19,0.24)] transition-colors hover:bg-[var(--mv-red-dark)] md:inline-flex">
                  <CatalogIcon className="h-5 w-5" /> Каталог
                </button>

                <div className="ml-auto flex items-center gap-1 md:hidden">
                  <HeaderIconCompact icon={User} label="Войти" />
                  <HeaderIconCompact icon={ShoppingCart} label="Корзина" />
                  <MobileHeaderMenu />
                </div>
              </div>

              <div className="flex w-full items-center gap-2 md:min-w-0 md:flex-1">
                <div className="relative w-full md:min-w-[260px]">
                  <Search className="pointer-events-none absolute left-4 top-1/2 h-4.5 w-4.5 -translate-y-1/2 text-[#818794]" />
                  <input
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    onFocus={() => setSearchFocused(true)}
                    onBlur={() => setSearchFocused(false)}
                    onKeyDown={(e) => e.key === "Enter" && submit()}
                    placeholder="Поиск в М.Видео"
                    className={`h-10 w-full rounded-xl border border-[#e3e5ea] bg-white pl-11 pr-[5.75rem] text-sm text-[#2c3138] shadow-[inset_0_0_0_1px_rgba(34,42,53,0.03)] transition-[border-color,box-shadow] placeholder:text-[#8a909b] focus:border-[#d8dce3] focus:outline-none md:h-11 ${
                      searchFocused ? "shadow-[0_0_0_2px_rgba(34,42,53,0.06)]" : ""
                    }`}
                  />
                  <VoiceButton
                    disabled
                    onText={() => {}}
                    className="absolute right-10 top-1 h-8 w-8 rounded-lg text-[#818794] md:h-9 md:w-9"
                  />
                  <button
                    onClick={submit}
                    className="absolute right-1 top-1 inline-flex h-8 w-8 items-center justify-center rounded-lg bg-[#2b3038] text-white transition-colors hover:bg-[#1f232a] md:h-9 md:w-9"
                  >
                    <Search className="h-4 w-4" />
                  </button>
                </div>
              </div>

              <nav className="hidden shrink-0 items-center gap-1 lg:flex">
                <HeaderIcon icon={ClipboardList} label="Статус заказа" />
                <HeaderIcon icon={User} label="Войти" />
                <HeaderIcon icon={BarChart3} label="Сравнение" />
                <HeaderIcon icon={Heart} label="Избранное" />
                <HeaderIcon icon={ShoppingCart} label="Корзина" />
              </nav>
            </div>
            <div className="hidden border-t border-[#eef0f3] bg-white md:block">
              <div className="mx-auto flex h-10 max-w-[1440px] items-center gap-5 overflow-x-auto px-4 text-[13px] font-medium text-[#3f4652]">
                {["Акции", "Уценка", "M.Club", "Рассрочка", "Доставка", "Сервисы", "Бизнесу"].map(
                  (item) => (
                    <button
                      key={item}
                      type="button"
                      className="whitespace-nowrap transition-colors hover:text-[var(--mv-red)]"
                    >
                      {item}
                    </button>
                  ),
                )}
              </div>
            </div>
          </header>
        </>
      )}
      <main className={isClientMode ? "mx-auto max-w-[1440px]" : ""}>
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

function CatalogIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <use href={CATALOG_ICON_HREF} xlinkHref={CATALOG_ICON_HREF} />
    </svg>
  );
}

function HeaderIcon({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <button className="flex min-w-[82px] flex-col items-center justify-center px-2.5 py-1 text-[13px] font-medium leading-tight text-[#2c3138] transition-colors hover:text-[var(--mv-red)]">
      <Icon className="mb-0.5 h-6 w-6 stroke-[2.1]" />
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
          {["Каталог", "Статус заказа", "Войти", "Сравнение", "Избранное", "Корзина"].map(
            (item) => (
              <button
                key={item}
                className="w-full rounded-md border border-border px-3 py-2 text-left text-sm transition-colors hover:border-[var(--mv-red)]/40 hover:text-[var(--mv-red)]"
              >
                {item}
              </button>
            ),
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
