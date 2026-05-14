import { useEffect, useState } from "react";
import { Settings, ShieldCheck } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogDescription,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { getRuntimeAiConfig, type RuntimeAiConfig } from "@/lib/mv-llm";

export function SettingsDialog() {
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<RuntimeAiConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getRuntimeAiConfig()
      .then((next) => {
        if (!cancelled) setConfig(next);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-foreground/70 hover:bg-muted hover:text-[var(--mv-red)]"
          aria-label="Настройки ИИ"
        >
          <Settings className="h-4 w-4" />
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-emerald-600" /> ИИ настроен администратором
          </DialogTitle>
          <DialogDescription>
            API-ключ и адрес провайдера больше не вводятся пользователем и не хранятся в браузере.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 rounded-lg border border-border bg-muted/40 p-3 text-sm">
          {error ? (
            <div className="text-destructive">Не удалось получить конфигурацию: {error}</div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Статус ключа</span>
                <Badge variant={config?.configured ? "default" : "secondary"}>
                  {config?.configured ? "задан в .env" : "ключ не задан"}
                </Badge>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Провайдер</span>
                <span className="font-medium">{config?.provider || "загрузка…"}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Модель</span>
                <span className="font-medium">{config?.model || "загрузка…"}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Режим сервиса</span>
                <span className="font-medium">{config?.appMode || "both"}</span>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
