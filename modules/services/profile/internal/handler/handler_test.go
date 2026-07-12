package handler

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	gjwt "github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/shruti/profile/internal/jwt"
	"github.com/jiva-studio/shruti/profile/internal/service"
	"github.com/jiva-studio/shruti/profile/internal/store"
)

// testKeys generates an RSA keypair, writes the public half to a temp PEM the
// Verifier reads, and returns the private key for signing test tokens.
func testKeys(t *testing.T) (*rsa.PrivateKey, *jwt.Verifier) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	pubBytes, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatalf("marshal pub: %v", err)
	}
	pubPEM := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: pubBytes})
	path := filepath.Join(t.TempDir(), "public.pem")
	if err := os.WriteFile(path, pubPEM, 0o644); err != nil {
		t.Fatalf("write pub: %v", err)
	}
	v, err := jwt.NewVerifierFromFile(path)
	if err != nil {
		t.Fatalf("verifier: %v", err)
	}
	return key, v
}

// mintToken signs an access token exactly like the auth service: RS256, kid=v1.
func mintToken(t *testing.T, key *rsa.PrivateKey, sub string, anon bool, aud ...string) string {
	t.Helper()
	claims := jwt.Claims{
		Anonymous: anon,
		RegisteredClaims: gjwt.RegisteredClaims{
			Subject:   sub,
			Audience:  gjwt.ClaimStrings(aud),
			IssuedAt:  gjwt.NewNumericDate(time.Now()),
			ExpiresAt: gjwt.NewNumericDate(time.Now().Add(time.Hour)),
		},
	}
	tok := gjwt.NewWithClaims(gjwt.SigningMethodRS256, claims)
	tok.Header["kid"] = jwt.SignerKid
	s, err := tok.SignedString(key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return s
}

func do(t *testing.T, h http.Handler, method, path, bearer string, body any, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			t.Fatalf("encode body: %v", err)
		}
	}
	req := httptest.NewRequest(method, path, &buf)
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// dbDSNFromEnv skips the test cleanly when no throwaway Postgres is configured.
func dbDSNFromEnv(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to run handler DB-backed tests")
	}
	return dsn
}

// testSchemaLockKey must match the service package's key: both reset the one
// shared `profile` schema, and `go test` runs the two packages in parallel.
const testSchemaLockKey int64 = 0x70726F66696C65 // "profile" bytes

func lockSchema(t *testing.T, dsn string) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("lock conn: %v", err)
	}
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock($1)`, testSchemaLockKey); err != nil {
		_ = conn.Close(ctx)
		t.Fatalf("advisory lock: %v", err)
	}
	t.Cleanup(func() {
		_, _ = conn.Exec(context.Background(), `SELECT pg_advisory_unlock($1)`, testSchemaLockKey)
		_ = conn.Close(context.Background())
	})
}

func freshDBService(t *testing.T) *service.Service {
	t.Helper()
	dsn := dbDSNFromEnv(t)
	lockSchema(t, dsn)
	ctx := context.Background()
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatalf("parse dsn: %v", err)
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	if _, err := pool.Exec(ctx, `DROP SCHEMA IF EXISTS profile CASCADE`); err != nil {
		pool.Close()
		t.Fatalf("drop schema: %v", err)
	}
	if err := store.Migrate(ctx, pool); err != nil {
		pool.Close()
		t.Fatalf("migrate: %v", err)
	}
	t.Cleanup(pool.Close)
	return &service.Service{
		Pool:         pool,
		Changes:      &store.ChangesRepo{Pool: pool},
		Cursors:      &store.CursorRepo{Pool: pool},
		Maint:        &store.MaintenanceRepo{Pool: pool},
		PullMaxLimit: 500,
	}
}

// ─── 10. Middleware: anonymous accepted, aud/kid gating, user_id from JWT ──

// The sync substrate is identity-agnostic: an anonymous token (device-provider
// user) is accepted and reaches the handler, keyed on its `sub`. An empty
// device_id makes push return 400 *before* the DB, proving pass-through
// without Postgres; pull/cursor tolerate the nil pool likewise.
func TestAnonymousTokenAccepted(t *testing.T) {
	key, verifier := testKeys(t)
	svc := &service.Service{PullMaxLimit: 500}
	r := NewRouter(RouterDeps{Svc: svc, Verifier: verifier})

	anon := mintToken(t, key, uuid.NewString(), true, jwt.AudienceChat)
	rec := do(t, r, http.MethodPost, "/profile/sync/push", anon, map[string]any{"device_id": ""}, nil)
	if rec.Code == http.StatusForbidden || rec.Code == http.StatusUnauthorized {
		t.Fatalf("anonymous token must pass the middleware, got %d (%s)", rec.Code, rec.Body.String())
	}
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("anonymous token should reach handler (400 on empty device_id), got %d (%s)", rec.Code, rec.Body.String())
	}
}

func TestMissingAndBadTokenRejected(t *testing.T) {
	key, verifier := testKeys(t)
	svc := &service.Service{PullMaxLimit: 500}
	r := NewRouter(RouterDeps{Svc: svc, Verifier: verifier})

	// No Authorization header → 401.
	if rec := do(t, r, http.MethodPost, "/profile/sync/push", "", map[string]any{}, nil); rec.Code != http.StatusUnauthorized {
		t.Errorf("missing token: want 401, got %d", rec.Code)
	}
	// Valid signature but wrong audience → 401.
	wrongAud := mintToken(t, key, uuid.NewString(), false, "billing")
	if rec := do(t, r, http.MethodPost, "/profile/sync/push", wrongAud, map[string]any{}, nil); rec.Code != http.StatusUnauthorized {
		t.Errorf("wrong aud: want 401, got %d (%s)", rec.Code, rec.Body.String())
	}
}

// A valid, non-anonymous token passes the middleware and reaches the handler:
// the empty device_id makes Push return a 400 validation error *before* it
// touches the DB, so this proves pass-through without needing Postgres.
func TestValidTokenPassesMiddleware(t *testing.T) {
	key, verifier := testKeys(t)
	svc := &service.Service{PullMaxLimit: 500}
	r := NewRouter(RouterDeps{Svc: svc, Verifier: verifier})

	tok := mintToken(t, key, uuid.NewString(), false, jwt.AudienceChat)
	rec := do(t, r, http.MethodPost, "/profile/sync/push", tok, map[string]any{"device_id": ""}, nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("valid token should reach handler (400 on empty device_id), got %d (%s)", rec.Code, rec.Body.String())
	}
}

// user_id is taken ONLY from the JWT sub: a body that tries to smuggle a
// different user_id is ignored, and the change lands under the token's user.
func TestUserIDComesFromJWTNotBody(t *testing.T) {
	svc := freshDBService(t)
	key, verifier := testKeys(t)
	r := NewRouter(RouterDeps{Svc: svc, Verifier: verifier})

	tokenUser := uuid.New()
	bodyUser := uuid.New()
	tok := mintToken(t, key, tokenUser.String(), false, jwt.AudienceChat)

	// Raw body includes a bogus "user_id" that the wire struct does not read.
	body := map[string]any{
		"user_id":   bodyUser.String(),
		"device_id": "devX",
		"changes": []map[string]any{{
			"collection": "notes",
			"doc_id":     "note-jwt",
			"op":         "upsert",
			"hlc":        "h1",
			"data":       map[string]any{"text": "hi"},
		}},
	}
	rec := do(t, r, http.MethodPost, "/profile/sync/push", tok, body, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("push: want 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	// The row belongs to the token's user, never the body-supplied one.
	var owner uuid.UUID
	if err := svc.Pool.QueryRow(context.Background(),
		`SELECT user_id FROM profile.changes WHERE collection='notes' AND doc_id='note-jwt'`).Scan(&owner); err != nil {
		t.Fatalf("read change owner: %v", err)
	}
	if owner != tokenUser {
		t.Fatalf("change owner: want token user %s, got %s", tokenUser, owner)
	}
	var bodyRows int
	if err := svc.Pool.QueryRow(context.Background(),
		`SELECT count(*) FROM profile.changes WHERE user_id=$1`, bodyUser).Scan(&bodyRows); err != nil {
		t.Fatalf("count body-user rows: %v", err)
	}
	if bodyRows != 0 {
		t.Fatalf("body-supplied user_id must be ignored, found %d rows", bodyRows)
	}
}

// ─── 11. /internal/purge — network-only (no JWT), optional shared secret ───

func TestInternalPurgeNoJWT(t *testing.T) {
	svc := freshDBService(t)
	_, verifier := testKeys(t)
	r := NewRouter(RouterDeps{Svc: svc, Verifier: verifier})

	// Seed a user directly through the service, then purge with NO bearer.
	uid := uuid.New()
	if _, err := svc.Pool.Exec(context.Background(),
		`INSERT INTO profile.notes (user_id, doc_id, text) VALUES ($1,'n','b')`, uid); err != nil {
		t.Fatalf("seed: %v", err)
	}
	rec := do(t, r, http.MethodPost, "/internal/purge", "", map[string]any{"user_id": uid.String()}, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("purge without JWT: want 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	var n int
	if err := svc.Pool.QueryRow(context.Background(),
		`SELECT count(*) FROM profile.notes WHERE user_id=$1`, uid).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Fatalf("purge should have removed the user's rows, %d left", n)
	}
}

// When a shared secret is configured, a bad/absent X-Internal-Token is 401 —
// this short-circuits before the DB, so no Postgres is needed.
func TestInternalPurgeTokenGuard(t *testing.T) {
	_, verifier := testKeys(t)
	svc := &service.Service{PullMaxLimit: 500}
	r := NewRouter(RouterDeps{Svc: svc, Verifier: verifier, PurgeToken: "s3cret"})

	// Wrong token → 401.
	rec := do(t, r, http.MethodPost, "/internal/purge", "",
		map[string]any{"user_id": uuid.NewString()},
		map[string]string{"X-Internal-Token": "nope"})
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("bad internal token: want 401, got %d (%s)", rec.Code, rec.Body.String())
	}
}
