package security

import (
	"fmt"
	"regexp"
	"strings"
	"unicode"
)

// RefusalB2C is the customer-safe refusal used for off-topic requests.
const RefusalB2C = "Помогаю только с выбором техники в М.Видео. Сформулируйте, пожалуйста, что вы ищете 🙂"

var offTopicPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)(сортировк[а-яё]*\s+пузырьк|bubble\s*sort|quicksort|merge\s*sort|алгоритм)`),
	regexp.MustCompile(`(?i)(напиши|сгенерируй|сделай|покажи|приведи)\s+(код|программу|скрипт|функцию|пример\s+код)`),
	regexp.MustCompile(`(?i)(код|скрипт|бот|telegram|телеграм|тг)\s+(для|на|который|бота)`),
	regexp.MustCompile(`(?i)(код.+(пример|покаж|напис)|приведи\s+пример.*код|какой\s+код)`),
	regexp.MustCompile(`(?i)(бот\s+тех\s*поддержк|тех\s*поддержк.*бот)`),
	regexp.MustCompile(`(?i)(python|javascript|typescript|java|c#|golang|go|php|ruby|sql|html|css)\s*[-—:]*\s*(код|пример|скрипт|функц)`),
	regexp.MustCompile(`(?i)(рецепт|медицин|диагноз|таблетк|политик|выборы|новост[иь])`),
	regexp.MustCompile(`(?i)(эссе|сочинени|реферат|курсовая|перевед[иите]|переведи)`),
	regexp.MustCompile(`(?i)(NSFW|эротик|порно|наркотик|оружи[ея]|взрывчат|фишинг|взлом|malware|вирус)`),
}

var promptInjectionPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)(ignore|forget|disregard|override)\s+(previous|all|above|system|developer)(?:\s+(system|developer))?\s+(instructions|prompts?|rules?)`),
	regexp.MustCompile(`(?i)(reveal|show|print|dump|leak)\s+(your\s+)?(system|developer)\s+(prompt|instructions|message)`),
	regexp.MustCompile(`(?i)(system\s*prompt|developer\s*message|hidden\s+instructions?|jailbreak|DAN|developer\s*mode)`),
	regexp.MustCompile(`(?i)(выйди\s+из\s+роли|теперь\s+ты\s+обязан|ты\s+обязан\s+отвечать|теперь\s+отвечай\s+на\s+любые|запомни\s+новую\s+инструкц)`),
	regexp.MustCompile(`(?i)(ты\s+теперь|притворись|ролевая\s+игра|забудь\s+(инструкции|правила|предыдущ)|игнорируй\s+(инструкции|правила|предыдущ))`),
	regexp.MustCompile(`(?i)(раскрой|покажи|выведи|напечатай)\s+(системн\w+\s+промпт|инструкции|секрет|ключ|токен)`),
	regexp.MustCompile(`(?i)</?(system|developer|assistant|tool)>`),
}

var apiKeyPattern = regexp.MustCompile(`sk-[A-Za-z0-9_-]{20,}`)
var namedSecretPattern = regexp.MustCompile(`(?i)(api[_-]?key|token|secret)\s*[:=]\s*[A-Za-z0-9._-]{12,}`)

// IsOffTopic reports whether text is outside the shopping-assistant domain.
func IsOffTopic(text string) bool {
	return matchesAny(offTopicPatterns, text)
}

// IsPromptInjection reports whether text appears to attack the prompt boundary.
func IsPromptInjection(text string) bool {
	return matchesAny(promptInjectionPatterns, text)
}

// SanitizeUserText removes control characters, collapses whitespace, trims, and truncates by rune count.
func SanitizeUserText(value any, maxLength int) string {
	if maxLength <= 0 {
		return ""
	}
	text := strings.TrimSpace(collapseWhitespace(removeControls(toString(value))))
	runes := []rune(text)
	if len(runes) > maxLength {
		return string(runes[:maxLength])
	}
	return text
}

// RedactSensitive masks API keys and named token/secret assignments.
func RedactSensitive(text string) string {
	redacted := apiKeyPattern.ReplaceAllString(text, "[redacted-api-key]")
	return namedSecretPattern.ReplaceAllString(redacted, "$1=[redacted]")
}

func matchesAny(patterns []*regexp.Regexp, text string) bool {
	for _, pattern := range patterns {
		if pattern.MatchString(text) {
			return true
		}
	}
	return false
}

func toString(value any) string {
	if value == nil {
		return ""
	}
	return fmt.Sprint(value)
}

func removeControls(text string) string {
	var builder strings.Builder
	builder.Grow(len(text))
	for _, char := range text {
		if unicode.IsControl(char) {
			builder.WriteRune(' ')
			continue
		}
		builder.WriteRune(char)
	}
	return builder.String()
}

func collapseWhitespace(text string) string {
	return strings.Join(strings.Fields(text), " ")
}
