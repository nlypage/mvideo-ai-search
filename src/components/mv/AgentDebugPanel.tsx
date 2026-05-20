import { useState } from "react";
import {
  Activity,
  Boxes,
  CheckCircle2,
  ChevronRight,
  MousePointerClick,
  Search,
} from "lucide-react";
import type { AgentDebugStep, Product } from "@/lib/mv-llm";

const TOOL_LABELS: Record<string, string> = {
  search_catalog: "Поиск в каталоге и отзывах",
  search_blog: "Поиск в блоге",
  cite_blog_source: "Проверка источника",
  recommend_products: "Выбор карточек",
};

const TYPE_LABELS: Record<AgentDebugStep["type"], string> = {
  decision: "решение",
  assistant: "ответ",
  tool: "инструмент",
  result: "данные",
};

type AgentDebugPanelProps = {
  steps: AgentDebugStep[];
  selectedProducts?: Product[];
  className?: string;
  heading?: string;
  checkedDataLabel?: string;
  emptyAssistantLabel?: string;
};

function toolNameFromStep(step: AgentDebugStep): string | null {
  const candidates = [step.title, step.detail ?? ""];
  for (const text of candidates) {
    const match = text.match(/(search_catalog|search_blog|cite_blog_source|recommend_products)/);
    if (match) return match[1];
  }
  return null;
}

function toolLabel(name: string | null): string {
  if (!name) return "Шаг агента";
  return TOOL_LABELS[name] ?? name;
}

function readableStepTitle(step: AgentDebugStep): string {
  const tool = toolNameFromStep(step);
  if (step.title.includes("Агент выбрал инструменты")) return "Решил, какие данные нужны";
  if (step.title.includes("Нормализовал запрос каталога")) return "Упростил запрос для каталога";
  if (step.title.includes("Требую структурный источник")) return "Попросил подтвердить источник";
  if (step.title.includes("Лимит инструментов достигнут")) return "Перехожу к итоговому ответу";
  if (step.title.includes("Ответ модели")) return "Сформировал следующий шаг";
  if (step.title.includes("Локальный агент выбрал запросы")) return "Подобрал поисковые запросы";
  if (step.title.startsWith("Результат ")) return `${toolLabel(tool)}: результат`;
  return step.title;
}

function readableDetail(step: AgentDebugStep): string | undefined {
  if (step.detail?.includes("cite_blog_source")) {
    return "Ответ опирается на статью, поэтому агент сначала фиксирует ссылку на источник.";
  }
  if (step.detail?.startsWith("План следующего шага:")) {
    const tools = step.detail
      .replace("План следующего шага:", "")
      .split(",")
      .map((name) => toolLabel(name.trim()))
      .join(", ");
    return `Дальше агент вызовет: ${tools}.`;
  }
  return step.detail;
}

function compactValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function resultCount(step: AgentDebugStep): number | null {
  const result = step.result;
  if (!result || typeof result !== "object") return null;
  const record = result as Record<string, unknown>;
  if (typeof record.count === "number") return record.count;
  if (Array.isArray(record.products)) return record.products.length;
  if (typeof record.articles === "number") return record.articles;
  return null;
}

function collectTools(steps: AgentDebugStep[]): string[] {
  const seen = new Set<string>();
  const tools: string[] = [];
  for (const step of steps) {
    const name = toolNameFromStep(step);
    if (name && !seen.has(name)) {
      seen.add(name);
      tools.push(name);
    }
    if (Array.isArray(step.args)) {
      for (const item of step.args) {
        if (typeof item === "string" && TOOL_LABELS[item] && !seen.has(item)) {
          seen.add(item);
          tools.push(item);
        }
      }
    }
  }
  return tools;
}

function dedupeProducts(products: Product[]): Product[] {
  const seen = new Set<string>();
  return products.filter((product) => {
    const key = product.id || product.url || product.title;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function AgentDebugPanel({
  steps,
  selectedProducts = [],
  className = "",
  heading = "Как агент думал под капотом",
  checkedDataLabel = "Какие данные проверил",
  emptyAssistantLabel = "ассистента",
}: AgentDebugPanelProps) {
  const tools = collectTools(steps);
  const stepCount = new Set(steps.map((step) => step.step)).size;
  const products = dedupeProducts(selectedProducts).slice(0, 4);
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <aside
      className={`rounded-xl border border-slate-200 bg-white p-4 text-xs text-slate-700 shadow-sm ${className}`}
    >
      <button
        type="button"
        onClick={() => setIsExpanded((current) => !current)}
        className="flex w-full items-start gap-2 text-left"
      >
        <div className="mt-0.5 rounded-lg bg-slate-900 p-1.5 text-white">
          <Activity className="h-3.5 w-3.5" />
        </div>
        <div className="flex-1">
          <div className="font-semibold text-slate-950">{heading}</div>
          <div className="mt-0.5 text-slate-500">
            {steps.length > 0 ? `${stepCount} шагов, ${steps.length} событий` : "панель включена"}
          </div>
        </div>
        <ChevronRight
          className={`mt-0.5 h-4 w-4 text-slate-500 transition-transform ${isExpanded ? "rotate-90" : ""}`}
        />
      </button>

      {isExpanded && (
        <>
          <div className="mt-4 grid gap-2">
            <div className="rounded-lg bg-slate-50 p-3">
              <div className="flex items-center gap-1.5 font-semibold text-slate-900">
                <Search className="h-3.5 w-3.5" /> {checkedDataLabel}
              </div>
              {tools.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {tools.map((name) => (
                    <span
                      key={name}
                      className="rounded-full border border-slate-200 bg-white px-2 py-1"
                    >
                      {toolLabel(name)}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="mt-2 text-slate-500">
                  {steps.length > 0
                    ? "Ответил без дополнительных инструментов."
                    : `События появятся здесь после первого ответа ${emptyAssistantLabel}.`}
                </div>
              )}
            </div>

            <div className="rounded-lg bg-slate-50 p-3">
              <div className="flex items-center gap-1.5 font-semibold text-slate-900">
                <Boxes className="h-3.5 w-3.5" /> Какие товары выбраны
              </div>
              {products.length > 0 ? (
                <div className="mt-2 space-y-2">
                  {products.map((product) => (
                    <div
                      key={product.id || product.url}
                      className="rounded-md border border-slate-200 bg-white p-2"
                    >
                      <div className="line-clamp-2 font-medium text-slate-900">{product.title}</div>
                      <div className="mt-1 text-slate-500">
                        {product.price.toLocaleString("ru")} ₽ · рейтинг {product.rating || "-"}
                      </div>
                    </div>
                  ))}
                  <div className="flex items-start gap-1.5 text-slate-500">
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 text-emerald-600" />
                    Отобраны из результатов каталога и ранжированы под последний запрос
                    пользователя.
                  </div>
                </div>
              ) : (
                <div className="mt-2 text-slate-500">Товары пока не зафиксированы в ответе.</div>
              )}
            </div>
          </div>

          <details className="mt-4" open={steps.length === 0}>
            <summary className="flex cursor-pointer list-none items-center gap-1.5 font-semibold text-slate-900">
              <MousePointerClick className="h-3.5 w-3.5" /> Подробные шаги
              <ChevronRight className="h-3.5 w-3.5" />
            </summary>
            {steps.length === 0 && (
              <div className="mt-3 rounded-lg border border-dashed border-slate-200 bg-slate-50 p-3 text-slate-500">
                Включён debug режим. Запустите запрос - тут появятся решения, инструменты и
                результаты.
              </div>
            )}
            <div className="mt-3 space-y-2">
              {steps.map((step, index) => {
                const value = compactValue(step.args ?? step.result);
                const count = resultCount(step);
                return (
                  <div
                    key={`${step.step}-${index}`}
                    className="rounded-lg border border-slate-200 bg-white p-2"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-medium text-slate-900">{readableStepTitle(step)}</span>
                      <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                        {TYPE_LABELS[step.type]} · {step.step + 1}
                      </span>
                    </div>
                    {readableDetail(step) && (
                      <div className="mt-1 text-slate-600">{readableDetail(step)}</div>
                    )}
                    {count !== null && <div className="mt-1 text-slate-500">Найдено: {count}</div>}
                    {value && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-[11px] font-medium text-slate-500">
                          Показать данные
                        </summary>
                        <pre className="mt-1 max-h-44 overflow-auto rounded bg-slate-950 p-2 text-[11px] leading-relaxed text-slate-100">
                          {value}
                        </pre>
                      </details>
                    )}
                  </div>
                );
              })}
            </div>
          </details>
        </>
      )}
    </aside>
  );
}
