package integration

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	pullcase "github.com/jiva-studio/shruti/profile/internal/application/pull"
	"github.com/jiva-studio/shruti/profile/internal/application/repair"
	"github.com/jiva-studio/shruti/profile/internal/domain/changes"
	"github.com/jiva-studio/shruti/profile/internal/domain/hlc"
)

var clock = hlc.NewClock()

func row(seq int64, stamp, data string) repair.Row {
	r := repair.Row{Seq: seq, Op: "upsert", HLC: stamp}
	if data == "" {
		r.Op = "delete"
	} else {
		r.Data = json.RawMessage(data)
	}
	return r
}

// seed appends rows straight into the change log, bypassing the write gate,
// and projects the highest-hlc upsert the way a server write does.
func seed(t *testing.T, pool *pgxpool.Pool, uid uuid.UUID, collection, docID string, rows ...repair.Row) {
	t.Helper()
	var master *repair.Row
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
	applyState(t, pool, uid, changes.Change{Collection: collection, DocID: docID, Op: master.Op, Data: master.Data, HLC: master.HLC})
}

func totalChangeCount(t *testing.T, pool *pgxpool.Pool) int {
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
	svc := serviceOn(pool, 500)

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

	r := newRepairer(t, pool, nil)
	before := totalChangeCount(t, pool)
	plans, err := r.Scan(ctx)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if totalChangeCount(t, pool) != before {
		t.Fatal("scan must not write")
	}
	reasons := map[string]string{}
	for _, p := range plans {
		reasons[p.DocID] = p.Reason
	}
	if len(plans) != 2 || reasons["lib-m"] != repair.ReasonMisordered || reasons["lib-p"] != repair.ReasonStalePublish {
		t.Fatalf("want lib-m misordered and lib-p stale_publish, got %v", reasons)
	}

	applied, err := r.Apply(ctx, plans)
	if err != nil || len(applied) != 2 {
		t.Fatalf("apply: %d applied, err %v", len(applied), err)
	}
	if totalChangeCount(t, pool) != before+2 {
		t.Fatalf("apply must append exactly one row per document")
	}

	for uid, want := range map[uuid.UUID]map[string]string{
		misordered: {"status": "ready"},
		published:  {"status": "ready", "origin": "published", "audio_key": "k2"},
	} {
		page, err := svc.Pull(ctx, uid, pullcase.Request{Limit: 100})
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
		master, _, err := svc.Changes.Latest(ctx, uid, "library_items", last.DocID)
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
	if totalChangeCount(t, pool) != before+2 {
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
	plans, err := newRepairer(t, pool, &a).Scan(t.Context())
	if err != nil || len(plans) != 1 || plans[0].UserID != a {
		t.Fatalf("want one plan for %s, got %+v (%v)", a, plans, err)
	}
}
