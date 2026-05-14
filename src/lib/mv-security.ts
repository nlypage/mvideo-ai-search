export const REFUSAL_B2C =
  "Я помогаю только с выбором техники в М.Видео. Сформулируйте, пожалуйста, что вы ищете 🙂";

const OFF_TOPIC_PATTERNS = [
  /(сортировк[а-яё]*\s+пузырьк|bubble\s*sort|quicksort|merge\s*sort|алгоритм)/iu,
  /(напиши|сгенерируй|сделай|покажи|приведи)\s+(код|программу|скрипт|функцию|пример\s+код)/iu,
  /(код|скрипт|бот|telegram|телеграм|тг)\s+(для|на|который|бота)/iu,
  /(код.+(пример|покаж|напис)|приведи\s+пример.*код|какой\s+код)/iu,
  /(бот\s+тех\s*поддержк|тех\s*поддержк.*бот)/iu,
  /(python|javascript|typescript|java|c#|golang|go|php|ruby|sql|html|css)\s*[-—:]*\s*(код|пример|скрипт|функц)/iu,
  /(рецепт|медицин|диагноз|таблетк|политик|выборы|новост[иь])/iu,
  /(эссе|сочинени|реферат|курсовая|перевед[иите]|переведи)/iu,
  /(NSFW|эротик|порно|наркотик|оружи[ея]|взрывчат|фишинг|взлом|malware|вирус)/iu,
];

const PROMPT_INJECTION_PATTERNS = [
  /(ignore|forget|disregard|override)\s+(previous|all|above|system|developer)\s+(instructions|prompts?|rules?)/iu,
  /(reveal|show|print|dump|leak)\s+(your\s+)?(system|developer)\s+(prompt|instructions|message)/iu,
  /(system\s*prompt|developer\s*message|hidden\s+instructions?|jailbreak|DAN|developer\s*mode)/iu,
  /(выйди\s+из\s+роли|теперь\s+ты\s+обязан|ты\s+обязан\s+отвечать|теперь\s+отвечай\s+на\s+любые|запомни\s+новую\s+инструкц)/iu,
  /(ты\s+теперь|притворись|ролевая\s+игра|забудь\s+(инструкции|правила|предыдущ)|игнорируй\s+(инструкции|правила|предыдущ))/iu,
  /(раскрой|покажи|выведи|напечатай)\s+(системн\w+\s+промпт|инструкции|секрет|ключ|токен)/iu,
  /<\/?(system|developer|assistant|tool)>/iu,
];

export function isOffTopic(text: string): boolean {
  return OFF_TOPIC_PATTERNS.some((re) => re.test(text));
}

export function isPromptInjection(text: string): boolean {
  return PROMPT_INJECTION_PATTERNS.some((re) => re.test(text));
}

export function sanitizeUserText(text: unknown, maxLength = 1200): string {
  return Array.from(String(text ?? ""), (char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 ? " " : char;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function redactSensitive(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "[redacted-api-key]")
    .replace(/(api[_-]?key|token|secret)\s*[:=]\s*[A-Za-z0-9._-]{12,}/gi, "$1=[redacted]");
}
