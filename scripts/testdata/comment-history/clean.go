package fixture

import "fmt"

// Parse accepts a trailing comma; the grammar is at http://example.com/grammar#12.
func Parse(legacyMode bool) {
	fmt.Println("used to be today", legacyMode)
	url := "http://example.com/today" // the endpoint serves one page
	_ = url
}

// Retry stops when the lease expires, and the previous attempt's error is
// returned with it.
func Retry() {}

// Sign returns the key that is used to sign today's quota token; a superseded
// token is refused. ErrGone means no user was removed: the address it was
// added under is unknown. See `todayBucket` and `legacyHeader`.
func Sign() {}
