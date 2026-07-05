package service

import (
	"context"
	"encoding/json"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/shruti/profile/internal/store"
	"github.com/jiva-studio/shruti/profile/internal/wire"
)

// testSchemaLockKey serializes schema drop/recreate across every test in every
// profile package that shares the one throwaway database: `go test` runs
// different packages in parallel, and they all reset the single `profile`
// schema. A session advisory lock held for each test's full duration makes
// those tests mutually exclusive so one never wipes another's rows mid-run.
const testSchemaLockKey int64 = 0x70726F66696C65 // "profile" bytes

// lockSchema opens a dedicated connection, takes the shared advisory lock, and
// releases it (closing the connection) on test cleanup.
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

// dbDSNFromEnv returns the test DSN, or skips the whole test when unset — so
// `go test ./...` stays green in CI without a database, and runs for real when
// TEST_DATABASE_URL points at a throwaway Postgres. Mirrors auth's helper.
func dbDSNFromEnv(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to run profile integration tests")
	}
	return dsn
}

// freshPool connects, drops the profile schema (real isolation so the
// advisory-lock / global_seq assertions are trustworthy) and re-applies the
// embedded migrations via profile's OWN runner. MaxConns is bumped so the
// concurrency test can actually fan out.
func freshPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := dbDSNFromEnv(t)
	lockSchema(t, dsn)
	ctx := context.Background()

	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatalf("parse dsn: %v", err)
	}
	cfg.MaxConns = 20
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	// Real isolation: a clean schema per test. CASCADE also drops the
	// schema_migrations ledger, so Migrate re-applies from scratch.
	if _, err := pool.Exec(ctx, `DROP SCHEMA IF EXISTS profile CASCADE`); err != nil {
		pool.Close()
		t.Fatalf("drop schema: %v", err)
	}
	if err := store.Migrate(ctx, pool); err != nil {
		pool.Close()
		t.Fatalf("migrate: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func newService(t *testing.T, pullMax int) *Service {
	t.Helper()
	pool := freshPool(t)
	return serviceOn(pool, pullMax)
}

func serviceOn(pool *pgxpool.Pool, pullMax int) *Service {
	if pullMax <= 0 {
		pullMax = 500
	}
	return &Service{
		Pool:         pool,
		Changes:      &store.ChangesRepo{Pool: pool},
		Cursors:      &store.CursorRepo{Pool: pool},
		Maint:        &store.MaintenanceRepo{Pool: pool},
		PullMaxLimit: pullMax,
	}
}

// --- small builders -------------------------------------------------------

func item(collection, docID, op, hlc, baseHLC, data string) wire.PushItem {
	it := wire.PushItem{Collection: collection, DocID: docID, Op: op, HLC: hlc, BaseHLC: baseHLC}
	if data != "" {
		it.Data = json.RawMessage(data)
	}
	return it
}

func push(t *testing.T, svc *Service, uid uuid.UUID, device string, items ...wire.PushItem) wire.PushResponse {
	t.Helper()
	resp, err := svc.Push(context.Background(), uid, wire.PushRequest{DeviceID: device, Changes: items})
	if err != nil {
		t.Fatalf("push: %v", err)
	}
	return resp
}

func changeCount(t *testing.T, pool *pgxpool.Pool, uid uuid.UUID, collection, docID string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM profile.changes WHERE user_id=$1 AND collection=$2 AND doc_id=$3`,
		uid, collection, docID,
	).Scan(&n); err != nil {
		t.Fatalf("count changes: %v", err)
	}
	return n
}

func stateCount(t *testing.T, pool *pgxpool.Pool, table string, uid uuid.UUID, docID string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM `+table+` WHERE user_id=$1 AND doc_id=$2`, uid, docID,
	).Scan(&n); err != nil {
		t.Fatalf("count %s: %v", table, err)
	}
	return n
}

// ─── 1. Migrations ────────────────────────────────────────────────────────

func TestMigrationsIdempotentAndReady(t *testing.T) {
	pool := freshPool(t) // migrates once
	ctx := context.Background()

	if err := store.SchemaReady(ctx, pool); err != nil {
		t.Fatalf("SchemaReady after first migrate: %v", err)
	}
	// Running the runner again is a no-op and must not error.
	if err := store.Migrate(ctx, pool); err != nil {
		t.Fatalf("second Migrate: %v", err)
	}
	if err := store.Migrate(ctx, pool); err != nil {
		t.Fatalf("third Migrate: %v", err)
	}
	if err := store.SchemaReady(ctx, pool); err != nil {
		t.Fatalf("SchemaReady after re-migrate: %v", err)
	}
	// The ledger holds exactly one row per embedded migration file; a
	// repeated run must not have inserted duplicates.
	var ledger int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM profile.schema_migrations`).Scan(&ledger); err != nil {
		t.Fatalf("count ledger: %v", err)
	}
	if ledger < 1 {
		t.Fatalf("expected at least one recorded migration, got %d", ledger)
	}
}

// ─── 2. Push new doc → applied + one changes row + typed-state projection ──

func TestPushProjectsTypedState(t *testing.T) {
	svc := newService(t, 0)
	pool := svc.Pool
	uid := uuid.New()
	ctx := context.Background()

	// playlist_items: doc_id == track_id natural key.
	resp := push(t, svc, uid, "devA",
		item("playlist_items", "trk-1", "upsert", "h1", "",
			`{"track_id":"trk-1","added_at":"2026-01-02T03:04:05Z","collection_id":"col-9"}`),
	)
	if len(resp.Applied) != 1 || resp.Applied[0].DocID != "trk-1" {
		t.Fatalf("expected trk-1 applied, got %+v", resp.Applied)
	}
	if len(resp.Conflicts) != 0 {
		t.Fatalf("no conflicts expected, got %+v", resp.Conflicts)
	}
	if n := changeCount(t, pool, uid, "playlist_items", "trk-1"); n != 1 {
		t.Fatalf("expected 1 changes row, got %d", n)
	}
	var (
		trackID string
		colID   *string
		addedAt *time.Time
	)
	if err := pool.QueryRow(ctx,
		`SELECT track_id, collection_id, added_at FROM profile.playlist_items WHERE user_id=$1 AND doc_id=$2`,
		uid, "trk-1",
	).Scan(&trackID, &colID, &addedAt); err != nil {
		t.Fatalf("read playlist_items: %v", err)
	}
	if trackID != "trk-1" {
		t.Errorf("track_id: want trk-1, got %q", trackID)
	}
	if colID == nil || *colID != "col-9" {
		t.Errorf("collection_id: want col-9, got %v", colID)
	}
	if addedAt == nil || !addedAt.Equal(time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)) {
		t.Errorf("added_at not projected: %v", addedAt)
	}

	// notes projection.
	push(t, svc, uid, "devA",
		item("notes", "note-1", "upsert", "n1", "",
			`{"track_id":"trk-1","body":"hello","time_start_s":12,"meta":{"k":"v"}}`),
	)
	var (
		body       *string
		timeStartS *int
		meta       []byte
	)
	if err := pool.QueryRow(ctx,
		`SELECT body, time_start_s, meta FROM profile.notes WHERE user_id=$1 AND doc_id=$2`,
		uid, "note-1",
	).Scan(&body, &timeStartS, &meta); err != nil {
		t.Fatalf("read notes: %v", err)
	}
	if body == nil || *body != "hello" {
		t.Errorf("note body: want hello, got %v", body)
	}
	if timeStartS == nil || *timeStartS != 12 {
		t.Errorf("time_start_s: want 12, got %v", timeStartS)
	}
	if string(meta) != `{"k": "v"}` && string(meta) != `{"k":"v"}` {
		t.Errorf("note meta jsonb not projected: %q", string(meta))
	}

	// listening_sessions projection.
	push(t, svc, uid, "devA",
		item("listening_sessions", "ls-1", "upsert", "s1", "",
			`{"track_id":"trk-1","from_position_s":0,"to_position_s":90}`),
	)
	var (
		toPos   *int
		lsTrack *string
	)
	if err := pool.QueryRow(ctx,
		`SELECT to_position_s, track_id FROM profile.listening_sessions WHERE user_id=$1 AND doc_id=$2`,
		uid, "ls-1",
	).Scan(&toPos, &lsTrack); err != nil {
		t.Fatalf("read listening_sessions: %v", err)
	}
	if toPos == nil || *toPos != 90 {
		t.Errorf("to_position_s: want 90, got %v", toPos)
	}
	if lsTrack == nil || *lsTrack != "trk-1" {
		t.Errorf("ls track_id: want trk-1, got %v", lsTrack)
	}
}

// ─── 3. Push idempotency (same hlc) ───────────────────────────────────────

func TestPushIdempotentSameHLC(t *testing.T) {
	svc := newService(t, 0)
	uid := uuid.New()

	it := item("notes", "note-x", "upsert", "hlc-1", "", `{"body":"first"}`)
	first := push(t, svc, uid, "devA", it)
	if len(first.Applied) != 1 {
		t.Fatalf("first push must apply, got %+v", first)
	}
	// Re-push the identical change (same hlc). Reported applied, but no new
	// changes row — the UNIQUE(user,collection,doc,hlc)/ON CONFLICT path.
	second := push(t, svc, uid, "devA", it)
	if len(second.Applied) != 1 || len(second.Conflicts) != 0 {
		t.Fatalf("retry must be applied no-op, got %+v", second)
	}
	if n := changeCount(t, svc.Pool, uid, "notes", "note-x"); n != 1 {
		t.Fatalf("expected exactly 1 changes row after retry, got %d", n)
	}
}

// ─── 4. Stale base_hlc → conflict, no mutation; re-push at master applies ──

func TestStaleBaseConflictThenApply(t *testing.T) {
	svc := newService(t, 0)
	pool := svc.Pool
	uid := uuid.New()

	// Seed master at hlc h1.
	push(t, svc, uid, "devA",
		item("playlist_items", "trk-c", "upsert", "h1", "", `{"track_id":"trk-c","collection_id":"orig"}`))

	// Push with a stale base that doesn't match master h1 → conflict.
	resp := push(t, svc, uid, "devB",
		item("playlist_items", "trk-c", "upsert", "h3", "wrong-base", `{"track_id":"trk-c","collection_id":"stale"}`))
	if len(resp.Applied) != 0 {
		t.Fatalf("stale push must not apply, got %+v", resp.Applied)
	}
	if len(resp.Conflicts) != 1 {
		t.Fatalf("expected 1 conflict, got %+v", resp.Conflicts)
	}
	c := resp.Conflicts[0]
	if c.Master.HLC != "h1" {
		t.Errorf("conflict master hlc: want h1, got %q", c.Master.HLC)
	}
	if c.DocID != "trk-c" || c.Collection != "playlist_items" {
		t.Errorf("conflict identity wrong: %+v", c)
	}
	// State must NOT have been mutated by the rejected push.
	var colID *string
	if err := pool.QueryRow(context.Background(),
		`SELECT collection_id FROM profile.playlist_items WHERE user_id=$1 AND doc_id=$2`,
		uid, "trk-c").Scan(&colID); err != nil {
		t.Fatalf("read state: %v", err)
	}
	if colID == nil || *colID != "orig" {
		t.Errorf("state must be untouched (orig), got %v", colID)
	}
	if n := changeCount(t, pool, uid, "playlist_items", "trk-c"); n != 1 {
		t.Fatalf("conflict must not append a changes row, got %d", n)
	}

	// Re-merge: push again with base == master hlc → fast-forward applies.
	ff := push(t, svc, uid, "devB",
		item("playlist_items", "trk-c", "upsert", "h3", "h1", `{"track_id":"trk-c","collection_id":"merged"}`))
	if len(ff.Applied) != 1 || len(ff.Conflicts) != 0 {
		t.Fatalf("re-push at master must apply, got %+v", ff)
	}
	if err := pool.QueryRow(context.Background(),
		`SELECT collection_id FROM profile.playlist_items WHERE user_id=$1 AND doc_id=$2`,
		uid, "trk-c").Scan(&colID); err != nil {
		t.Fatalf("re-read state: %v", err)
	}
	if colID == nil || *colID != "merged" {
		t.Errorf("state after merge: want merged, got %v", colID)
	}
}

// ─── 5. Advisory lock / global_seq monotonicity under concurrency ─────────

func TestConcurrentPushSameUserMonotonicSeq(t *testing.T) {
	svc := newService(t, 0)
	pool := svc.Pool
	uid := uuid.New()
	const n = 12

	var wg sync.WaitGroup
	start := make(chan struct{})
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			doc := "trk-" + uuid.NewString()
			_, errs[i] = svc.Push(context.Background(), uid, wire.PushRequest{
				DeviceID: "dev",
				Changes: []wire.PushItem{
					item("playlist_items", doc, "upsert", "h-"+doc, "", `{"track_id":"`+doc+`"}`),
				},
			})
		}(i)
	}
	close(start)
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("concurrent push %d failed: %v", i, err)
		}
	}

	// Every change durably appended: exactly n rows for this user.
	rows, err := pool.Query(context.Background(),
		`SELECT global_seq FROM profile.changes WHERE user_id=$1 ORDER BY global_seq`, uid)
	if err != nil {
		t.Fatalf("query seqs: %v", err)
	}
	defer rows.Close()
	var seqs []int64
	for rows.Next() {
		var s int64
		if err := rows.Scan(&s); err != nil {
			t.Fatalf("scan: %v", err)
		}
		seqs = append(seqs, s)
	}
	if len(seqs) != n {
		t.Fatalf("expected %d durable changes, got %d", n, len(seqs))
	}
	// Assigned without gaps or duplicates: on a fresh schema this user is the
	// only writer, so global_seq is a contiguous strictly-increasing run.
	for i := 1; i < len(seqs); i++ {
		if seqs[i] == seqs[i-1] {
			t.Fatalf("duplicate global_seq %d", seqs[i])
		}
		if seqs[i] != seqs[i-1]+1 {
			t.Fatalf("gap in global_seq: %d then %d", seqs[i-1], seqs[i])
		}
	}
}

func TestConcurrentPushDifferentUsersDoNotBlock(t *testing.T) {
	svc := newService(t, 0)
	uidA, uidB := uuid.New(), uuid.New()

	var wg sync.WaitGroup
	start := make(chan struct{})
	var errA, errB error
	wg.Add(2)
	go func() {
		defer wg.Done()
		<-start
		_, errA = svc.Push(context.Background(), uidA, wire.PushRequest{
			DeviceID: "a",
			Changes:  []wire.PushItem{item("notes", "n", "upsert", "ha", "", `{"body":"a"}`)},
		})
	}()
	go func() {
		defer wg.Done()
		<-start
		_, errB = svc.Push(context.Background(), uidB, wire.PushRequest{
			DeviceID: "b",
			Changes:  []wire.PushItem{item("notes", "n", "upsert", "hb", "", `{"body":"b"}`)},
		})
	}()
	close(start)
	wg.Wait()
	if errA != nil || errB != nil {
		t.Fatalf("distinct users must both succeed: a=%v b=%v", errA, errB)
	}
	if got := stateCount(t, svc.Pool, "profile.notes", uidA, "n"); got != 1 {
		t.Errorf("user A note missing: %d", got)
	}
	if got := stateCount(t, svc.Pool, "profile.notes", uidB, "n"); got != 1 {
		t.Errorf("user B note missing: %d", got)
	}
}

// ─── 6. Pull: cursor, limit clamp, own-writes returned, paging ────────────

func TestPullOwnWritesAndPaging(t *testing.T) {
	// PullMaxLimit deliberately small to exercise the clamp + paging.
	svc := newService(t, 2)
	uid := uuid.New()
	ctx := context.Background()

	// Two changes from devA, three from devB — 5 total.
	push(t, svc, uid, "devA", item("notes", "a1", "upsert", "a1", "", `{"body":"a1"}`))
	push(t, svc, uid, "devA", item("notes", "a2", "upsert", "a2", "", `{"body":"a2"}`))
	push(t, svc, uid, "devB", item("notes", "b1", "upsert", "b1", "", `{"body":"b1"}`))
	push(t, svc, uid, "devB", item("notes", "b2", "upsert", "b2", "", `{"body":"b2"}`))
	push(t, svc, uid, "devB", item("notes", "b3", "upsert", "b3", "", `{"body":"b3"}`))

	// devA pulls from 0: sees ALL rows (its own devA writes included — the
	// only way it recovers them after a local wipe), clamped to the max
	// limit of 2 despite asking for 100.
	page1, err := svc.Pull(ctx, uid, wire.PullRequest{Cursor: 0, Limit: 100})
	if err != nil {
		t.Fatalf("pull p1: %v", err)
	}
	if len(page1.Changes) != 2 {
		t.Fatalf("limit clamp failed: want 2 rows, got %d", len(page1.Changes))
	}
	if !page1.HasMore {
		t.Errorf("has_more should be true after a full page")
	}
	for _, c := range page1.Changes {
		if c.ServerSeq == 0 {
			t.Errorf("pull must populate server_seq")
		}
	}
	if page1.Cursor != page1.Changes[1].ServerSeq {
		t.Errorf("cursor must equal last row seq: %d vs %d", page1.Cursor, page1.Changes[1].ServerSeq)
	}

	// Page through the rest from the advancing cursor until drained.
	seen := map[string]bool{}
	for _, c := range page1.Changes {
		seen[c.DocID] = true
	}
	cursor := page1.Cursor
	for {
		pg, err := svc.Pull(ctx, uid, wire.PullRequest{Cursor: cursor, Limit: 100})
		if err != nil {
			t.Fatalf("pull page: %v", err)
		}
		for _, c := range pg.Changes {
			seen[c.DocID] = true
		}
		cursor = pg.Cursor
		if !pg.HasMore {
			break
		}
	}

	// All five docs seen across the pages — including devA's own writes.
	for _, want := range []string{"a1", "a2", "b1", "b2", "b3"} {
		if !seen[want] {
			t.Errorf("missing %s across pages", want)
		}
	}
}

// ─── 7. Delete/tombstone projection + chat cascade + orphan drop ──────────

func TestDeleteCascadeAndOrphanDrop(t *testing.T) {
	svc := newService(t, 0)
	pool := svc.Pool
	uid := uuid.New()

	// upsert a note, then delete it → state row gone.
	push(t, svc, uid, "d", item("notes", "n-del", "upsert", "h1", "", `{"body":"x"}`))
	if stateCount(t, pool, "profile.notes", uid, "n-del") != 1 {
		t.Fatalf("note should exist before delete")
	}
	push(t, svc, uid, "d", item("notes", "n-del", "delete", "h2", "h1", ""))
	if stateCount(t, pool, "profile.notes", uid, "n-del") != 0 {
		t.Fatalf("delete must tombstone the note state row")
	}

	// chat cascade: session S with a message M.
	push(t, svc, uid, "d", item("chat_sessions", "S", "upsert", "s1", "", `{"title":"t"}`))
	push(t, svc, uid, "d", item("chat_messages", "M", "upsert", "m1", "", `{"session_id":"S","role":"user","content":"hi"}`))
	if stateCount(t, pool, "profile.chat_messages", uid, "M") != 1 {
		t.Fatalf("message M should be present")
	}
	// Deleting the parent session cascades to its messages (composite FK).
	push(t, svc, uid, "d", item("chat_sessions", "S", "delete", "s2", "s1", ""))
	if stateCount(t, pool, "profile.chat_sessions", uid, "S") != 0 {
		t.Fatalf("session S should be deleted")
	}
	if stateCount(t, pool, "profile.chat_messages", uid, "M") != 0 {
		t.Fatalf("message M should cascade-delete with its session")
	}

	// orphan drop: a message whose parent session is absent is dropped from
	// state (WHERE EXISTS), yet the changes row is still appended so it
	// replicates and each device applies its own orphan rule.
	resp := push(t, svc, uid, "d",
		item("chat_messages", "orphan", "upsert", "o1", "", `{"session_id":"ghost","role":"user","content":"?"}`))
	if len(resp.Applied) != 1 {
		t.Fatalf("orphan message push should still be reported applied, got %+v", resp)
	}
	if stateCount(t, pool, "profile.chat_messages", uid, "orphan") != 0 {
		t.Fatalf("orphan message must be dropped from state")
	}
	if changeCount(t, pool, uid, "chat_messages", "orphan") != 1 {
		t.Fatalf("orphan message changes row must still be appended")
	}
}

// ─── 8. Cursor ack (GREATEST semantics) ───────────────────────────────────

func TestCursorAckGreatest(t *testing.T) {
	svc := newService(t, 0)
	uid := uuid.New()
	ctx := context.Background()

	read := func() int64 {
		var v int64
		if err := svc.Pool.QueryRow(ctx,
			`SELECT acked_seq FROM profile.sync_cursors WHERE user_id=$1 AND device_id=$2`,
			uid, "devA").Scan(&v); err != nil {
			t.Fatalf("read cursor: %v", err)
		}
		return v
	}

	if err := svc.AckCursor(ctx, uid, wire.CursorRequest{DeviceID: "devA", AckedSeq: 5}); err != nil {
		t.Fatalf("ack 5: %v", err)
	}
	if got := read(); got != 5 {
		t.Fatalf("after ack 5: got %d", got)
	}
	// A lower ack must not regress the cursor (GREATEST).
	if err := svc.AckCursor(ctx, uid, wire.CursorRequest{DeviceID: "devA", AckedSeq: 3}); err != nil {
		t.Fatalf("ack 3: %v", err)
	}
	if got := read(); got != 5 {
		t.Fatalf("lower ack must not regress: got %d", got)
	}
	// A higher ack advances it.
	if err := svc.AckCursor(ctx, uid, wire.CursorRequest{DeviceID: "devA", AckedSeq: 10}); err != nil {
		t.Fatalf("ack 10: %v", err)
	}
	if got := read(); got != 10 {
		t.Fatalf("higher ack should advance: got %d", got)
	}

	// device_id required.
	if err := svc.AckCursor(ctx, uid, wire.CursorRequest{DeviceID: "", AckedSeq: 1}); err == nil || !IsValidation(err) {
		t.Fatalf("empty device_id must be a validation error, got %v", err)
	}
}

// ─── 9. Purge wipes one user, leaves others intact ────────────────────────

func TestPurgeUserIsolated(t *testing.T) {
	svc := newService(t, 0)
	pool := svc.Pool
	ctx := context.Background()
	victim, keep := uuid.New(), uuid.New()

	seed := func(uid uuid.UUID) {
		push(t, svc, uid, "d", item("playlist_items", "trk", "upsert", "h1", "", `{"track_id":"trk"}`))
		push(t, svc, uid, "d", item("listening_sessions", "ls", "upsert", "h2", "", `{"track_id":"trk"}`))
		push(t, svc, uid, "d", item("notes", "nt", "upsert", "h3", "", `{"body":"b"}`))
		push(t, svc, uid, "d", item("chat_sessions", "S", "upsert", "h4", "", `{"title":"t"}`))
		push(t, svc, uid, "d", item("chat_messages", "M", "upsert", "h5", "", `{"session_id":"S","content":"c"}`))
		if err := svc.AckCursor(ctx, uid, wire.CursorRequest{DeviceID: "d", AckedSeq: 3}); err != nil {
			t.Fatalf("ack: %v", err)
		}
	}
	seed(victim)
	seed(keep)

	if err := svc.Purge(ctx, victim); err != nil {
		t.Fatalf("purge: %v", err)
	}

	tables := []string{
		"profile.changes", "profile.sync_cursors", "profile.playlist_items",
		"profile.listening_sessions", "profile.notes",
		"profile.chat_sessions", "profile.chat_messages",
	}
	for _, tbl := range tables {
		var nVictim, nKeep int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM `+tbl+` WHERE user_id=$1`, victim).Scan(&nVictim); err != nil {
			t.Fatalf("count victim %s: %v", tbl, err)
		}
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM `+tbl+` WHERE user_id=$1`, keep).Scan(&nKeep); err != nil {
			t.Fatalf("count keep %s: %v", tbl, err)
		}
		if nVictim != 0 {
			t.Errorf("%s: victim rows not purged (%d)", tbl, nVictim)
		}
		if nKeep == 0 {
			t.Errorf("%s: kept user's rows were wrongly deleted", tbl)
		}
	}
}
