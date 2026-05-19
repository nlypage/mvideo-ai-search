import { Mic, MicOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

type SpeechRecognitionResultEvent = Event & {
  results: { [index: number]: { [index: number]: { transcript: string } } };
};

type BrowserSpeechRecognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

type SpeechWindow = Window & {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
};

export function VoiceButton({
  onText,
  disabled = false,
  title,
  className,
}: {
  onText: (t: string) => void;
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(true);
  const recRef = useRef<BrowserSpeechRecognition | null>(null);

  useEffect(() => {
    if (disabled) {
      setListening(false);
      setSupported(true);
      recRef.current = null;
      return;
    }

    const speechWindow = window as SpeechWindow;
    const SpeechRecognition =
      speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setSupported(false);
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = "ru-RU";
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      const text = event.results[0]?.[0]?.transcript;
      if (text) onText(text);
    };
    recognition.onend = () => setListening(false);
    recognition.onerror = () => setListening(false);
    recRef.current = recognition;
  }, [disabled, onText]);

  const toggle = () => {
    if (disabled || !recRef.current) return;
    if (listening) {
      recRef.current.stop();
    } else {
      try {
        recRef.current.start();
        setListening(true);
      } catch {
        setListening(false);
      }
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={disabled || !supported}
      title={
        title ||
        (disabled
          ? "Голосовой ввод скоро будет доступен"
          : supported
            ? "Голосовой ввод"
            : "Браузер не поддерживает распознавание речи")
      }
      className={cn(
        "inline-flex h-10 w-10 items-center justify-center rounded-full transition-colors",
        listening
          ? "animate-pulse bg-[var(--mv-red)] text-white"
          : "text-[var(--mv-red)] hover:bg-red-50",
        "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
        className,
      )}
    >
      {listening ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
    </button>
  );
}
