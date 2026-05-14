import { Mic, MicOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function VoiceButton({ onText }: { onText: (t: string) => void }) {
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(true);
  const recRef = useRef<any>(null);

  useEffect(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      setSupported(false);
      return;
    }
    const r = new SR();
    r.lang = "ru-RU";
    r.interimResults = false;
    r.continuous = false;
    r.onresult = (e: any) => {
      const t = e.results[0][0].transcript;
      onText(t);
    };
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    recRef.current = r;
  }, [onText]);

  const toggle = () => {
    if (!recRef.current) return;
    if (listening) {
      recRef.current.stop();
    } else {
      try {
        recRef.current.start();
        setListening(true);
      } catch {}
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={!supported}
      title={supported ? "Голосовой ввод" : "Браузер не поддерживает распознавание речи"}
      className={`inline-flex h-10 w-10 items-center justify-center rounded-full transition-colors ${
        listening ? "bg-[var(--mv-red)] text-white animate-pulse" : "text-[var(--mv-red)] hover:bg-red-50"
      } disabled:opacity-40`}
    >
      {listening ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
    </button>
  );
}