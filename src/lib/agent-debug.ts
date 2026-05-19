function isEnabled(value: unknown): boolean {
  const normalized = String(value ?? "").toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function shouldShowAgentDebugPanel(): boolean {
  if (isEnabled(import.meta.env.VITE_AI_DEBUG)) return true;
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  return params.get("debug") === "1" || params.get("ai_debug") === "1";
}

export async function resolveAgentDebugPanelVisibility(): Promise<boolean> {
  if (shouldShowAgentDebugPanel()) return true;
  try {
    const res = await fetch("/api/llm", { headers: { Accept: "application/json" } });
    if (!res.ok) return false;
    const data = (await res.json()) as { debug?: boolean };
    return data.debug === true;
  } catch {
    return false;
  }
}
