package promote_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/shruti/publish/internal/application/promote"
	"github.com/jiva-studio/shruti/publish/internal/domain"
	"github.com/jiva-studio/shruti/publish/internal/pending"
	"github.com/jiva-studio/shruti/publish/internal/ports"
	"github.com/jiva-studio/shruti/publish/internal/store"
)

// These run against a real Postgres, because what they check is a property of
// the database: which rows one reconciliation flips and what it leaves in the
// outbox beside them.
//
// Without SHRUTI_PUBLISH_TEST_DATABASE_URL they skip locally and fail in CI,
// which always provides the database.
func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("SHRUTI_PUBLISH_TEST_DATABASE_URL")
	if dsn == "" {
		if os.Getenv("CI") != "" {
			t.Fatal("SHRUTI_PUBLISH_TEST_DATABASE_URL must be set in CI")
		}
		t.Skip("SHRUTI_PUBLISH_TEST_DATABASE_URL not set")
	}
	ctx := t.Context()
	pool, err := store.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(ctx, `DROP SCHEMA IF EXISTS publish CASCADE`); err != nil {
		t.Fatalf("drop schema: %v", err)
	}
	if err := store.Migrate(ctx, pool); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return pool
}

type catalogIDs []string

func (c catalogIDs) PublishedTrackIDs(context.Context) ([]string, error) { return c, nil }

type upload struct{ puts int }

func (u *upload) Put(context.Context, string, []byte, string) error { u.puts++; return nil }

type outboxRow struct {
	Topic   string
	Payload promote.PublishedEvent
}

func outbox(t *testing.T, pool *pgxpool.Pool) []outboxRow {
	t.Helper()
	rows, err := pool.Query(t.Context(), `SELECT topic, payload FROM publish.outbox ORDER BY seq`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []outboxRow
	for rows.Next() {
		var r outboxRow
		var raw []byte
		if err := rows.Scan(&r.Topic, &raw); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(raw, &r.Payload); err != nil {
			t.Fatal(err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func published(t *testing.T, pool *pgxpool.Pool) map[string]bool {
	t.Helper()
	rows, err := pool.Query(t.Context(), `SELECT track_id, published FROM publish.tracks`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var id string
		var p bool
		if err := rows.Scan(&id, &p); err != nil {
			t.Fatal(err)
		}
		out[id] = p
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// A reconciliation flips exactly the unpublished tracks the catalog now holds,
// and announces each in the outbox — once, under both owner keys.
func TestAReconciliationPublishesAndAnnouncesTogether(t *testing.T) {
	pool := testPool(t)
	ctx := t.Context()
	repo := store.New(pool)
	for _, tr := range []domain.Track{
		{TrackID: "t1", OwnerID: "o1"},
		{TrackID: "t2", OwnerID: "o2"},
		{TrackID: "t3", OwnerID: "o3"},
	} {
		if err := repo.Upsert(ctx, tr); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `UPDATE publish.tracks SET published = true WHERE track_id = 't3'`); err != nil {
		t.Fatal(err)
	}

	up := &upload{}
	p := promote.New(promote.Deps{
		Ledger:          repo,
		Catalog:         catalogIDs{"t1", "t3", "elsewhere"},
		Blob:            up,
		Pending:         pending.NewExporter(pool),
		PublishedStream: "track.published",
		PendingKey:      "public/db/pending.db",
	})
	if err := p.RunOnce(ctx); err != nil {
		t.Fatal(err)
	}

	got := published(t, pool)
	if !got["t1"] || got["t2"] || !got["t3"] {
		t.Errorf("published = %v, want t1 and t3 only", got)
	}
	announced := outbox(t, pool)
	if len(announced) != 1 {
		t.Fatalf("outbox = %+v, want one announcement", announced)
	}
	want := promote.PublishedEvent{Type: "track.published", TrackID: "t1", OwnerID: "o1", UserID: "o1"}
	if announced[0].Topic != "track.published" || announced[0].Payload != want {
		t.Errorf("announcement = %+v", announced[0])
	}
	if up.puts != 1 {
		t.Errorf("pending.db uploaded %d times", up.puts)
	}

	// Nothing new in the catalog: the next cycle announces nothing again.
	if err := p.RunOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if n := len(outbox(t, pool)); n != 1 {
		t.Errorf("outbox holds %d rows after a quiet cycle, want 1", n)
	}
}

// A unit of work that fails after flipping a track leaves neither the flip nor
// any announcement behind.
func TestAFailedUnitOfWorkLeavesTheLedgerAlone(t *testing.T) {
	pool := testPool(t)
	ctx := t.Context()
	repo := store.New(pool)
	if err := repo.Upsert(ctx, domain.Track{TrackID: "t1", OwnerID: "o1"}); err != nil {
		t.Fatal(err)
	}

	boom := errors.New("boom")
	err := repo.WithinTx(ctx, func(tx ports.PromotionTx) error {
		flipped, err := tx.MarkPublished(ctx, []string{"t1"})
		if err != nil {
			return err
		}
		if len(flipped) != 1 {
			t.Errorf("flipped = %+v inside the unit of work", flipped)
		}
		if err := tx.Enqueue(ctx, "track.published", []byte(`{"track_id":"t1"}`)); err != nil {
			return err
		}
		return boom
	})
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want the unit of work's own failure", err)
	}
	if got := published(t, pool); got["t1"] {
		t.Error("the flip survived a rolled-back unit of work")
	}
	if n := len(outbox(t, pool)); n != 0 {
		t.Errorf("outbox holds %d rows after a rollback", n)
	}
}
