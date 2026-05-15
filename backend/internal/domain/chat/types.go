package chat

// Mode identifies the assistant persona/service contract.
type Mode string

const (
	// ModeB2C is the customer-facing shopping assistant.
	ModeB2C Mode = "b2c"
	// ModeB2E is the consultant-facing sales assistant.
	ModeB2E Mode = "b2e"
)

// Message is the public chat message contract accepted by /api/llm.
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}
