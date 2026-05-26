package handlers

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

// fakeRegionServer is a destination stub that records every delivery
// for assertion. status controls the response code; bodyJSON the body.
type fakeRegionServer struct {
	hits     atomic.Int32
	lastBody []byte
	lastMAC  string
	status   int32
	resp     []byte
	srv      *httptest.Server
}

func newFakeRegion(t *testing.T) *fakeRegionServer {
	t.Helper()
	f := &fakeRegionServer{status: http.StatusOK, resp: []byte(`{"matched":false}`)}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.hits.Add(1)
		body, _ := io.ReadAll(r.Body)
		f.lastBody = body
		f.lastMAC = r.Header.Get("X-Lectorium-HMAC")
		w.WriteHeader(int(atomic.LoadInt32(&f.status)))
		_, _ = w.Write(f.resp)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeRegionServer) URL() string  { return f.srv.URL }
func (f *fakeRegionServer) Hits() int32  { return f.hits.Load() }
func (f *fakeRegionServer) SetStatus(s int) {
	atomic.StoreInt32(&f.status, int32(s))
}

// makePayload builds a broadcast outbox payload mirroring what
// service.ApplyRCSubscriberState writes when RegionID=="global".
func makePayload(t *testing.T, sourceRegion string) []byte {
	t.Helper()
	expires := int64(1_700_000_000_000)
	b, err := json.Marshal(map[string]any{
		"event_id":        "ev-broadcast-1",
		"app_user_id":     "rc_user_99",
		"tier":            "pro",
		"tier_expires_at": expires,
		"source_region":   sourceRegion,
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}

// hmacHex computes the same HMAC the handler does — used to assert the
// destination saw the right header.
func hmacHex(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

// TestSubscriptionBroadcast_DeliversWithValidHMAC — a single configured
// region receives the snapshot, HMAC matches body bytes, handler
// returns nil so the outbox row gets marked processed.
func TestSubscriptionBroadcast_DeliversWithValidHMAC(t *testing.T) {
	const secret = "shared-secret-1"
	fake := newFakeRegion(t)
	h := &SubscriptionBroadcastHandler{
		Client: http.DefaultClient,
		Secret: secret,
		RemoteRegions: []RemoteRegion{
			{ID: "russia", BaseURL: fake.URL()},
		},
	}
	payload := makePayload(t, "global")

	if err := h.Handle(context.Background(), payload); err != nil {
		t.Fatalf("Handle returned err on happy path: %v", err)
	}
	if got := fake.Hits(); got != 1 {
		t.Fatalf("expected exactly 1 delivery, got %d", got)
	}

	// The body posted on the wire must equal the JSON-marshal of the
	// parsed payload (canonical form), and HMAC must equal sha256 of it.
	want := hmacHex(secret, fake.lastBody)
	if fake.lastMAC != want {
		t.Errorf("HMAC mismatch: header=%q want=%q (body=%s)", fake.lastMAC, want, string(fake.lastBody))
	}
	// Sanity: body decodes back to our payload shape.
	var p subscriptionBroadcastPayload
	if err := json.Unmarshal(fake.lastBody, &p); err != nil {
		t.Fatalf("posted body not valid JSON: %v", err)
	}
	if p.EventID != "ev-broadcast-1" || p.AppUserID != "rc_user_99" || p.Tier != "pro" {
		t.Errorf("posted body payload mismatch: %+v", p)
	}
}

// TestSubscriptionBroadcast_NoRemotesIsNoOp — a single-region
// deployment has REMOTE_REGIONS unset; handler returns nil without
// hitting the network. The outer worker still marks the row processed
// so it doesn't accumulate.
func TestSubscriptionBroadcast_NoRemotesIsNoOp(t *testing.T) {
	h := &SubscriptionBroadcastHandler{
		Client:        http.DefaultClient,
		Secret:        "anything",
		RemoteRegions: nil,
	}
	if err := h.Handle(context.Background(), makePayload(t, "global")); err != nil {
		t.Errorf("no-remote handler must return nil, got %v", err)
	}
}

// TestSubscriptionBroadcast_SkipsSelfEcho — the originating region's
// own ID may appear in REMOTE_REGIONS if the operator copied the env
// across all boxes; the handler must skip that entry to avoid looping
// the snapshot back into the source region's apply path.
func TestSubscriptionBroadcast_SkipsSelfEcho(t *testing.T) {
	const secret = "secret-self"
	self := newFakeRegion(t)
	other := newFakeRegion(t)
	h := &SubscriptionBroadcastHandler{
		Client: http.DefaultClient,
		Secret: secret,
		RemoteRegions: []RemoteRegion{
			{ID: "global", BaseURL: self.URL()},  // self
			{ID: "russia", BaseURL: other.URL()}, // legit remote
		},
	}
	if err := h.Handle(context.Background(), makePayload(t, "global")); err != nil {
		t.Fatalf("handler err: %v", err)
	}
	if self.Hits() != 0 {
		t.Errorf("self-echo region must NOT be POSTed (got %d hits)", self.Hits())
	}
	if other.Hits() != 1 {
		t.Errorf("non-self region must receive exactly 1 delivery (got %d)", other.Hits())
	}
}

// TestSubscriptionBroadcast_5xxIsRetryableError — when a remote returns
// 500, the handler must return a non-nil error so the outbox row stays
// pending for the next retry. The successful sibling regions still
// receive the snapshot (per-region isolation).
func TestSubscriptionBroadcast_5xxIsRetryableError(t *testing.T) {
	const secret = "secret-5xx"
	good := newFakeRegion(t)
	bad := newFakeRegion(t)
	bad.SetStatus(http.StatusInternalServerError)
	bad.resp = []byte(`{"error":"boom"}`)
	h := &SubscriptionBroadcastHandler{
		Client: http.DefaultClient,
		Secret: secret,
		RemoteRegions: []RemoteRegion{
			{ID: "russia", BaseURL: bad.URL()},
			{ID: "asia", BaseURL: good.URL()},
		},
	}
	err := h.Handle(context.Background(), makePayload(t, "global"))
	if err == nil {
		t.Fatal("expected error from 5xx region so outbox retries; got nil")
	}
	if good.Hits() != 1 {
		t.Errorf("healthy region must still receive its delivery (per-region isolation), got %d hits", good.Hits())
	}
	if bad.Hits() != 1 {
		t.Errorf("failing region must still be attempted exactly once per Handle call, got %d hits", bad.Hits())
	}
}

// TestSubscriptionBroadcast_AllRegionsAttemptedDespiteFirstFailure —
// belt-and-suspenders against an early-return regression: with two
// failing regions, both must show one attempt; the returned error
// surfaces the FIRST failure.
func TestSubscriptionBroadcast_AllRegionsAttemptedDespiteFirstFailure(t *testing.T) {
	const secret = "secret-fanout"
	a := newFakeRegion(t)
	a.SetStatus(http.StatusBadGateway)
	b := newFakeRegion(t)
	b.SetStatus(http.StatusServiceUnavailable)
	h := &SubscriptionBroadcastHandler{
		Client: http.DefaultClient,
		Secret: secret,
		RemoteRegions: []RemoteRegion{
			{ID: "a", BaseURL: a.URL()},
			{ID: "b", BaseURL: b.URL()},
		},
	}
	if err := h.Handle(context.Background(), makePayload(t, "global")); err == nil {
		t.Fatal("expected non-nil error when every region fails")
	}
	if a.Hits() != 1 {
		t.Errorf("region a hits=%d, want 1", a.Hits())
	}
	if b.Hits() != 1 {
		t.Errorf("region b hits=%d, want 1", b.Hits())
	}
}

// TestSubscriptionBroadcast_NonJSONPayloadIsProcessed — a malformed
// payload (producer bug) must NOT loop forever in the outbox. Handler
// logs + returns nil so the row gets marked processed and stays
// available for forensic inspection until the retention sweep deletes
// it.
func TestSubscriptionBroadcast_NonJSONPayloadIsProcessed(t *testing.T) {
	h := &SubscriptionBroadcastHandler{
		Client:        http.DefaultClient,
		Secret:        "x",
		RemoteRegions: []RemoteRegion{{ID: "russia", BaseURL: "http://127.0.0.1:1"}},
	}
	if err := h.Handle(context.Background(), []byte("{not json")); err != nil {
		t.Errorf("malformed payload must not requeue; got %v", err)
	}
}

// TestSubscriptionBroadcastClosure_WrapsHandle — the Handler-returning
// constructor must call through to Handle with the event's payload.
func TestSubscriptionBroadcastClosure_WrapsHandle(t *testing.T) {
	const secret = "wrap-test"
	fake := newFakeRegion(t)
	bh := &SubscriptionBroadcastHandler{
		Client:        http.DefaultClient,
		Secret:        secret,
		RemoteRegions: []RemoteRegion{{ID: "russia", BaseURL: fake.URL()}},
	}
	h := SubscriptionBroadcast(bh)
	if err := h(context.Background(), Event{
		EventType:   "subscription.broadcast",
		AggregateID: "user-xyz",
		Payload:     makePayload(t, "global"),
	}); err != nil {
		t.Fatalf("closure returned err: %v", err)
	}
	if fake.Hits() != 1 {
		t.Errorf("expected 1 delivery via closure, got %d", fake.Hits())
	}
}
