package rcsync

import (
	"context"
	"errors"
	"log/slog"
	"regexp"
	"strings"

	"github.com/jiva-studio/shruti/auth/internal/domain/subscription"
)

// Delivery is what a RevenueCat webhook delivery says about whom to refetch.
// TRANSFER events carry no AppUserID: the entitlement moves from
// TransferredFrom to TransferredTo.
type Delivery struct {
	EventID, Type, AppUserID       string
	TransferredFrom, TransferredTo []string
}

// Outcome is how a delivery ended; the transport answers RevenueCat from it.
// Every outcome except Processed, Duplicate and Deferred leaves the event
// unprocessed, so RevenueCat or the reconcile pass tries it again.
type Outcome int

const (
	// Processed: the refetched state is applied.
	Processed Outcome = iota + 1
	// Duplicate: an earlier delivery of the event was processed.
	Duplicate
	// Deferred: a TRANSFER to anonymous ids only, stored for the orphan sweep
	// to resolve once one of them is bound to a user.
	Deferred
	// Unresolvable: RevenueCat refused the refetch permanently.
	Unresolvable
	// NoAppUserID: the delivery names nobody to refetch.
	NoAppUserID
	// RCUnavailable: the refetch failed transiently.
	RCUnavailable
	// Unmatched: no user is bound to the customer yet.
	Unmatched
	// DeferFailed: the anonymous TRANSFER could not be stored.
	DeferFailed
	// RecordFailed: the delivery could not be recorded.
	RecordFailed
	// ApplyFailed: the snapshot could not be applied.
	ApplyFailed
)

const anonIDPrefix = "$RCAnonymousID:"

// HandleDelivery refetches the customer a delivery is about and applies its
// state. It never seals an event it could not resolve authoritatively.
func (s *Service) HandleDelivery(ctx context.Context, d Delivery) Outcome {
	// The identified TRANSFER destination is the id bound to a user, and its
	// refetch carries the transferred entitlement.
	appUserID := d.AppUserID
	if appUserID == "" {
		appUserID = firstIdentified(d.TransferredTo)
	}
	if appUserID == "" {
		return s.deferAnonymousTransfer(ctx, d)
	}

	// RecordDelivery is one INSERT … ON CONFLICT, so concurrent retries of an
	// event cannot both miss it. An unprocessed earlier delivery goes on to
	// Apply, which re-checks under the customer lock.
	inserted, processed, err := s.RecordDelivery(ctx, d.EventID, appUserID)
	if err != nil {
		slog.ErrorContext(ctx, "rc_webhook_idempotency_failed",
			"event_id", d.EventID, "err", err.Error())
		return RecordFailed
	}
	if !inserted && processed {
		return Duplicate
	}

	snap, err := s.fetch(ctx, appUserID)
	switch {
	case errors.Is(err, subscription.ErrSubscriberNotFound):
		// RevenueCat creates a customer lazily, so a webhook can race ahead
		// of it; the free snapshot is applied.
		slog.InfoContext(ctx, "rc_refetch_not_found",
			"event_id", d.EventID, "rc_app_user_id", appUserID)
	case errors.Is(err, subscription.ErrPermanent):
		// Sealing would freeze the current tier and could keep a refunded
		// user on Pro. The row stays unprocessed for RevenueCat's retries and
		// the reconcile pass once the key is fixed; 200 stops a redelivery
		// storm meanwhile.
		s.Metrics.APIPermanent()
		s.Metrics.APIAuthFailed()
		s.Metrics.WebhookPermanentUnresolved()
		safeErr := SanitizeRCError(err)
		slog.ErrorContext(ctx, "rc_refetch_permanent_failure",
			"event_id", d.EventID, "rc_app_user_id", appUserID, "err", safeErr)
		s.recordError(ctx, d.EventID, "permanent: "+safeErr)
		return Unresolvable
	case err != nil:
		if errors.Is(err, subscription.ErrRateLimited) {
			s.Metrics.APIRateLimited()
		}
		safeErr := SanitizeRCError(err)
		slog.ErrorContext(ctx, "rc_refetch_failed", "event_id", d.EventID, "err", safeErr)
		s.recordError(ctx, d.EventID, safeErr)
		return RCUnavailable
	}

	userID, matched, err := s.Apply(ctx, d.EventID, snap)
	if err != nil {
		safeErr := SanitizeRCError(err)
		slog.ErrorContext(ctx, "rc_apply_failed", "event_id", d.EventID, "err", safeErr)
		s.recordError(ctx, d.EventID, safeErr)
		return ApplyFailed
	}
	if !matched {
		// The webhook beat the client's Purchases.logIn. RevenueCat retries
		// within its budget; past it the orphan sweep seals the row. The event
		// is counted once, on its first delivery, not once per retry.
		if inserted {
			s.Metrics.WebhookUnmatched()
		}
		slog.InfoContext(ctx, "rc_webhook_unmatched",
			"event_id", d.EventID, "event_type", d.Type, "rc_app_user_id", appUserID)
		return Unmatched
	}
	slog.InfoContext(ctx, "rc_webhook_processed",
		"event_id", d.EventID,
		"event_type", d.Type,
		"rc_app_user_id", appUserID,
		"user_id", userID.String(),
		"matched", matched,
		"tier", snap.Tier,
	)

	// An identified former owner of a transferred entitlement is downgraded
	// now, or one purchase reads as Pro on two accounts until the stale sweep.
	if from := firstIdentified(d.TransferredFrom); from != "" && from != appUserID {
		s.downgradeTransferSource(ctx, d.EventID, from)
	}
	return Processed
}

// deferAnonymousTransfer stores a TRANSFER whose destinations are all
// anonymous under the first of them: the client may bind it moments later,
// and the orphan sweep can only replay an event that was stored. A delivery
// with no id at all is refused.
func (s *Service) deferAnonymousTransfer(ctx context.Context, d Delivery) Outcome {
	anonTarget := firstAnonymous(d.TransferredTo)
	if anonTarget == "" {
		slog.WarnContext(ctx, "rc_webhook_no_app_user_id",
			"event_id", d.EventID, "event_type", d.Type)
		return NoAppUserID
	}
	if _, _, err := s.RecordDelivery(ctx, d.EventID, anonTarget); err != nil {
		slog.ErrorContext(ctx, "rc_webhook_store_anon_transfer_failed",
			"event_id", d.EventID, "err", err.Error())
		return DeferFailed
	}
	slog.InfoContext(ctx, "rc_webhook_anon_transfer_stored",
		"event_id", d.EventID, "rc_app_user_id", anonTarget)
	return Deferred
}

// downgradeTransferSource applies the former owner's refetched state under
// its own event id, so it cannot collide with the primary event's rows. The
// primary apply is committed already, so a failure is logged and left to the
// stale sweep.
func (s *Service) downgradeTransferSource(ctx context.Context, eventID, fromID string) {
	snap, err := s.FetchSnapshot(ctx, fromID)
	if err != nil {
		slog.WarnContext(ctx, "rc_transfer_source_refetch_failed",
			"event_id", eventID, "rc_app_user_id", fromID, "err", SanitizeRCError(err))
		return
	}
	srcEventID := eventID + ":from:" + fromID
	srcUserID, srcMatched, err := s.Apply(ctx, srcEventID, snap)
	if err != nil {
		slog.WarnContext(ctx, "rc_transfer_source_apply_failed",
			"event_id", srcEventID, "rc_app_user_id", fromID, "err", SanitizeRCError(err))
		return
	}
	slog.InfoContext(ctx, "rc_transfer_source_reconciled",
		"event_id", srcEventID, "rc_app_user_id", fromID,
		"user_id", srcUserID.String(), "matched", srcMatched, "tier", snap.Tier)
}

// recordError stores msg on the unprocessed event. The outcome does not
// depend on it, so a failure is logged and the event stays retryable.
func (s *Service) recordError(ctx context.Context, eventID, msg string) {
	if err := s.RecordError(ctx, eventID, msg); err != nil {
		slog.ErrorContext(ctx, "rc_webhook_record_error_failed",
			"event_id", eventID, "err", err.Error())
	}
}

// firstIdentified returns the first non-empty, non-anonymous id, or "".
func firstIdentified(ids []string) string {
	for _, id := range ids {
		if id != "" && !strings.HasPrefix(id, anonIDPrefix) {
			return id
		}
	}
	return ""
}

// firstAnonymous returns the first $RCAnonymousID:* id, or "".
func firstAnonymous(ids []string) string {
	for _, id := range ids {
		if strings.HasPrefix(id, anonIDPrefix) {
			return id
		}
	}
	return ""
}

var (
	rcErrEmailRE = regexp.MustCompile(`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`)
	rcErrPhoneRE = regexp.MustCompile(`\+?\d{7,}`)
)

// SanitizeRCError bounds an error to 200 characters and masks anything that
// looks like an email or a phone number: RevenueCat bodies can carry either,
// and the result is stored on the event row and logged.
func SanitizeRCError(err error) string {
	if err == nil {
		return ""
	}
	s := err.Error()
	const maxLen = 200
	if len(s) > maxLen {
		s = s[:maxLen]
	}
	s = rcErrEmailRE.ReplaceAllString(s, "<email>")
	s = rcErrPhoneRE.ReplaceAllString(s, "<phone>")
	return s
}
