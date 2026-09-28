// Package wire holds the JSON bodies billing's HTTP routes read and write.
// Field order matches the bodies clients and Paymento already see.
package wire

// CheckoutRequest is POST /billing/checkout's body. ReturnPath is the
// site-relative, locale-correct success path the web app wants the customer
// sent back to (e.g. "/en/subscribe/success").
type CheckoutRequest struct {
	Plan       string `json:"plan"`
	ReturnPath string `json:"returnPath"`
}

// CheckoutResponse sends the customer to the payment page.
type CheckoutResponse struct {
	RedirectURL string `json:"redirectUrl"`
}

// PaymentoIPN is the part of Paymento's instant payment notification billing
// acts on.
type PaymentoIPN struct {
	PaymentID   string `json:"PaymentId"`
	OrderID     string `json:"OrderId"`
	OrderStatus int    `json:"OrderStatus"`
}

// WebhookAck acknowledges an IPN. OK is false for a notification that could
// not be read; Duplicate is set for one about an already fulfilled payment.
type WebhookAck struct {
	Duplicate bool `json:"duplicate,omitempty"`
	OK        bool `json:"ok"`
}

// Health is GET /billing/healthz's body.
type Health struct {
	Build  Build  `json:"build"`
	Status string `json:"status"`
}

// Build names the running build.
type Build struct {
	SHA  string `json:"sha"`
	Time string `json:"time"`
}

// Error is the body of every refusal.
type Error struct {
	Error ErrorDetail `json:"error"`
}

// ErrorDetail is a stable machine code and a human message.
type ErrorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
