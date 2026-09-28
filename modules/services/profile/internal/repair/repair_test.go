package repair

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/shruti/profile/internal/service"
	"github.com/jiva-studio/shruti/profile/internal/store"
	"github.com/jiva-studio/shruti/profile/internal/wire"
)

// testSchemaLockKey is the advisory lock every profile test package holds
// while it resets the shared throwaway schema.
const testSchemaLockKey int64 = 0x70726F66696C65 // "profile" bytes

// freshPool returns a pool on a freshly migrated profile schema, or skips
// without TEST_DATABASE_URL.
func freshPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to run profile integration tests")
	}
	ctx := t.Context()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("lock conn: %v", err)
	}
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock($1)`, testSchemaLockKey); err != nil {
		t.Fatalf("advisory lock: %v", err)
	}
	t.Cleanup(func() {
		if _, err := conn.Exec(t.Context(), `SELECT pg_advisory_unlock($1)`, testSchemaLockKey); err != nil {
			t.Logf("unlock: %v", err)
		}
		if err := conn.Close(t.Context()); err != nil {
			t.Logf("close: %v", err)
		}
	})
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(ctx, `DROP SCHEMA IF EXISTS profile CASCADE`); err != nil {
		t.Fatalf("drop schema: %v", err)
	}
	if err := store.Migrate(ctx, pool); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return pool
}

// seed appends rows straight into the change log, bypassing the service's
// write gate, and projects the highest-hlc upsert the way the service did.
func seed(t *testing.T, pool *pgxpool.Pool, uid uuid.UUID, collection, docID string, rows ...Row) {
	t.Helper()
	var master *Row
	for i := range rows {
		r := rows[i]
		var data any
		if r.Op == "upsert" {
			data = []byte(r.Data)
		}
		if _, err := pool.Exec(t.Context(),
			`INSERT INTO profile.changes (user_id, collection, doc_id, op, data, hlc, device_id)
			 VALUES ($1, $2, $3, $4, $5, $6, 'server:orchestrator')`,
			uid, collection, docID, r.Op, data, r.HLC); err != nil {
			t.Fatalf("seed: %v", err)
		}
		if master == nil || r.HLC > master.HLC {
			master = &rows[i]
		}
	}
	it := wire.PushItem{Collection: collection, DocID: docID, Op: master.Op, Data: master.Data, HLC: master.HLC}
	if err := store.ApplyState(t.Context(), pool, uid, it); err != nil {
		t.Fatalf("seed projection: %v", err)
	}
}

func changeCount(t *testing.T, pool *pgxpool.Pool) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM profile.changes`).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

// Dry run reads only; apply fixes each broken document so the newest pulled
// row is the correct state, leaves consistent and client-owned documents
// alone, and a second run finds and writes nothing.
func TestRepairScanApplyIdempotent(t *testing.T) {
	pool := freshPool(t)
	ctx := t.Context()
	svc := &service.Service{Pool: pool, Changes: &store.ChangesRepo{Pool: pool}, PullMaxLimit: 500}

	misordered, published, healthy := uuid.New(), uuid.New(), uuid.New()
	seed(t, pool, misordered, "library_items", "lib-m",
		row(0, clock.Ranked(0, 1), `{"status":"queued","track_id":"t1"}`),
		row(0, clock.Ranked(0, 3), `{"status":"ready","track_id":"t1"}`),
		row(0, clock.Ranked(0, 2), `{"status":"processing","track_id":"t1"}`),
	)
	seed(t, pool, published, "library_items", "lib-p",
		row(0, clock.Ranked(0, 3), `{"status":"ready","track_id":"t2","audio_key":"k2"}`),
		row(0, clock.Ranked(0, 2), `{"status":"processing","track_id":"t2"}`),
		row(0, clock.Terminal(), `{"status":"processing","track_id":"t2","origin":"published"}`),
	)
	seed(t, pool, healthy, "library_items", "lib-h",
		row(0, clock.Ranked(0, 1), `{"status":"queued"}`),
		row(0, clock.Ranked(0, 3), `{"status":"ready"}`),
	)
	// Client-owned: seq order is the client's order and is never touched.
	seed(t, pool, healthy, "notes", "note-1",
		row(0, "000000000000009:00000:dev", `{"text":"b"}`),
		row(0, "000000000000001:00000:dev", `{"text":"a"}`),
	)

	r := &Repairer{Pool: pool}
	before := changeCount(t, pool)
	plans, err := r.Scan(ctx)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if changeCount(t, pool) != before {
		t.Fatal("scan must not write")
	}
	reasons := map[string]string{}
	for _, p := range plans {
		reasons[p.DocID] = p.Reason
	}
	if len(plans) != 2 || reasons["lib-m"] != ReasonMisordered || reasons["lib-p"] != ReasonStalePublish {
		t.Fatalf("want lib-m misordered and lib-p stale_publish, got %v", reasons)
	}

	applied, err := r.Apply(ctx, plans)
	if err != nil || len(applied) != 2 {
		t.Fatalf("apply: %d applied, err %v", len(applied), err)
	}
	if changeCount(t, pool) != before+2 {
		t.Fatalf("apply must append exactly one row per document")
	}

	for uid, want := range map[uuid.UUID]map[string]string{
		misordered: {"status": "ready"},
		published:  {"status": "ready", "origin": "published", "audio_key": "k2"},
	} {
		page, err := svc.Pull(ctx, uid, wire.PullRequest{Limit: 100})
		if err != nil {
			t.Fatalf("pull: %v", err)
		}
		last := page.Changes[len(page.Changes)-1]
		var got map[string]string
		if err := json.Unmarshal(last.Data, &got); err != nil {
			t.Fatalf("decode: %v", err)
		}
		for k, v := range want {
			if got[k] != v {
				t.Errorf("%s: newest pulled %s=%q, want %q (%s)", uid, k, got[k], v, last.Data)
			}
		}
		master, _, err := svc.Changes.Latest(ctx, pool, uid, "library_items", last.DocID)
		if err != nil || master.HLC != last.HLC {
			t.Errorf("%s: corrective row must be the master, got %s vs %s (%v)", uid, master.HLC, last.HLC, err)
		}
		var status string
		if err := pool.QueryRow(ctx, `SELECT status FROM profile.library_items WHERE user_id=$1`, uid).Scan(&status); err != nil || status != "ready" {
			t.Errorf("%s: projection status %q (%v), want ready", uid, status, err)
		}
	}

	again, err := r.Scan(ctx)
	if err != nil || len(again) != 0 {
		t.Fatalf("second scan must be empty, got %+v (%v)", again, err)
	}
	if applied, err := r.Apply(ctx, plans); err != nil || len(applied) != 0 {
		t.Fatalf("re-applying stale plans must write nothing, got %d (%v)", len(applied), err)
	}
	if changeCount(t, pool) != before+2 {
		t.Fatal("re-run must not append")
	}
}

// --user limits the scan to one user.
func TestRepairScanOneUser(t *testing.T) {
	pool := freshPool(t)
	a, b := uuid.New(), uuid.New()
	for _, uid := range []uuid.UUID{a, b} {
		seed(t, pool, uid, "library_items", "lib",
			row(0, clock.Ranked(0, 3), `{"status":"ready"}`),
			row(0, clock.Ranked(0, 2), `{"status":"processing"}`),
		)
	}
	plans, err := (&Repairer{Pool: pool, User: &a}).Scan(t.Context())
	if err != nil || len(plans) != 1 || plans[0].UserID != a {
		t.Fatalf("want one plan for %s, got %+v (%v)", a, plans, err)
	}
}
