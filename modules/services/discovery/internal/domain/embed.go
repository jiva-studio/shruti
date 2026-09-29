package domain

// Spend is what an embedding call was billed.
type Spend struct {
	Model   string
	Items   int
	Tokens  *int64
	CostUSD *float64
}

// Charge is what one model call cost, as it is kept. The call itself is a
// fact; its price is only known if the provider said so, so the numbers are
// pointers and a nil means unreported rather than free.
type Charge struct {
	SourceID  string
	Kind      string
	Model     string
	Items     int
	TokensIn  *int64
	TokensOut *int64
	CostUSD   *float64
}
