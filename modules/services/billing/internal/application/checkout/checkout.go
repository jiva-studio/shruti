// Package checkout starts a purchase: it stores an order, asks the payment
// gateway for a payment and answers with the page the customer pays on.
package checkout

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/billing/internal/domain/order"
	"github.com/jiva-studio/shruti/billing/internal/ports"
)

var (
	// ErrUnknownPlan is returned for a plan that is not sold.
	ErrUnknownPlan = errors.New("unknown plan")
	// ErrPaymentsUnavailable is returned while the gateway has no API key.
	ErrPaymentsUnavailable = errors.New("payments are not available")
	// ErrStoreOrder is returned when the order could not be stored.
	ErrStoreOrder = errors.New("could not create order")
	// ErrGateway is returned when the gateway refused or failed the payment.
	ErrGateway = errors.New("could not start payment")
	// ErrStoreToken is returned when the gateway's token could not be stored.
	ErrStoreToken = errors.New("could not persist payment token")
)

// defaultSuccessPath is where the customer lands after paying when the caller
// named no acceptable path.
const defaultSuccessPath = "/subscribe/success"

// Service starts checkouts. PublicBaseURL is the site the gateway returns the
// customer to.
type Service struct {
	Orders        ports.Orders
	Gateway       ports.PaymentGateway
	PublicBaseURL string
}

// Start begins a checkout of plan for userID and returns the URL the customer
// is redirected to. returnPath is the site-relative success path the customer
// comes back to; one that is not acceptable falls back to the default.
func (s *Service) Start(ctx context.Context, userID uuid.UUID, plan, returnPath string) (string, error) {
	amountCents, ok := order.PriceCents(plan)
	if !ok {
		return "", ErrUnknownPlan
	}
	if !s.Gateway.Configured() {
		return "", ErrPaymentsUnavailable
	}

	o, err := s.Orders.Create(ctx, userID, plan, amountCents)
	if err != nil {
		slog.ErrorContext(ctx, "billing_create_order_failed", "err", err.Error())
		return "", fmt.Errorf("%w: %w", ErrStoreOrder, err)
	}

	successPath := defaultSuccessPath
	if p := safeReturnPath(returnPath); p != "" {
		successPath = p
	}
	returnURL := s.PublicBaseURL + successPath + "?order=" + o.ID.String()
	token, err := s.Gateway.CreatePayment(ctx,
		dollars(amountCents), "USD", returnURL, o.ID.String(),
		map[string]string{"userId": userID.String(), "plan": plan})
	if err != nil {
		if berr := s.Orders.BumpAttempt(ctx, o.ID, "create: "+err.Error()); berr != nil {
			slog.ErrorContext(ctx, "billing_bump_attempt_failed", "order_id", o.ID.String(), "err", berr.Error())
		}
		if errors.Is(err, ports.ErrGatewayUnconfigured) {
			return "", fmt.Errorf("%w: %w", ErrPaymentsUnavailable, err)
		}
		slog.ErrorContext(ctx, "billing_paymento_create_failed", "order_id", o.ID.String(), "err", err.Error())
		return "", fmt.Errorf("%w: %w", ErrGateway, err)
	}
	if err := s.Orders.SetToken(ctx, o.ID, token); err != nil {
		slog.ErrorContext(ctx, "billing_set_token_failed", "order_id", o.ID.String(), "err", err.Error())
		return "", fmt.Errorf("%w: %w", ErrStoreToken, err)
	}

	slog.InfoContext(ctx, "billing_checkout_created",
		"order_id", o.ID.String(), "plan", plan, "amount_cents", amountCents)
	return s.Gateway.RedirectURL(token), nil
}

// safeReturnPath accepts only a site-relative ".../subscribe/success" path
// (single leading slash, no scheme/host) so a caller can't smuggle an
// off-site return URL. Returns "" when the path is not acceptable.
func safeReturnPath(p string) string {
	if len(p) < 2 || p[0] != '/' || strings.HasPrefix(p, "//") {
		return ""
	}
	if strings.ContainsAny(p, " \t\r\n") || strings.Contains(p, "..") {
		return ""
	}
	if !strings.HasSuffix(p, "/subscribe/success") {
		return ""
	}
	return p
}

// dollars renders cents as a plain dollar string (e.g. 299 → "2.99").
func dollars(cents int) string {
	return fmt.Sprintf("%d.%02d", cents/100, cents%100)
}
