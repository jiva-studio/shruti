package domain

// Spend is what an embedding call was billed.
type Spend struct {
	Model   string
	Items   int
	Tokens  *int64
	CostUSD *float64
}
