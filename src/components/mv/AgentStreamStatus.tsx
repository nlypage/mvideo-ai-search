import { EmViAvatar } from "./EmViAvatar";
import type { AgentStreamEvent } from "@/lib/mv-llm";

type AgentStreamStatusProps = {
  events: AgentStreamEvent[];
  fallback?: string;
  hasText?: boolean;
};

function normalizeStatus(label: string): string {
  return label
    .replace(/^Ищет\s+/i, "смотрю ")
    .replace(/^Думает\.\.\.$/i, "формулирую ответ")
    .replace(/^Печатает\.\.\.$/i, "отвечаю…")
    .replace(/\.\.\.$/, "…");
}

function statusLabel(events: AgentStreamEvent[], hasText: boolean, fallback?: string): string {
  const toolEvents = events.filter(
    (event) => event.type === "tool_call_start" || event.type === "tool_call_done",
  );
  const last = toolEvents.at(-1);
  if (hasText) {
    return "отвечаю…";
  }
  if (last?.type === "tool_call_start") {
    return normalizeStatus(last.hint || "смотрю каталог М.Видео");
  }
  if (toolEvents.some((event) => event.type === "tool_call_done")) {
    return "формулирую ответ";
  }
  return normalizeStatus(fallback || "смотрю каталог М.Видео");
}

export function AgentStreamStatus({ events, fallback, hasText = false }: AgentStreamStatusProps) {
  const label = statusLabel(events, hasText, fallback);

  return (
    <div aria-live="polite" className="mb-3 flex items-start gap-2">
      <EmViAvatar className="mt-0.5 h-7 w-7" />
      <div className="inline-flex max-w-[min(100%,520px)] items-center gap-2 rounded-2xl rounded-tl-sm border border-border bg-white/90 px-3 py-2 text-xs text-muted-foreground shadow-sm">
        <span className="inline-flex shrink-0 items-center gap-0.5" aria-hidden="true">
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--mv-red)]/70 [animation-delay:-0.2s]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--mv-red)]/70 [animation-delay:-0.1s]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--mv-red)]/70" />
        </span>
        <span className="truncate font-medium text-foreground">{label}</span>
      </div>
    </div>
  );
}
