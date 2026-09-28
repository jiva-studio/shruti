package repair

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/profile/internal/domain/changes"
	"github.com/jiva-studio/shruti/profile/internal/domain/hlc"
)

var (
	clock   = hlc.NewClock()
	testKey = changes.DocKey{UserID: uuid.MustParse("00000000-0000-0000-0000-000000000001"), Collection: "library_items", DocID: "d"}
)

func row(seq int64, stamp, data string) Row {
	r := Row{Seq: seq, Op: "upsert", HLC: stamp}
	if data == "" {
		r.Op = "delete"
	} else {
		r.Data = json.RawMessage(data)
	}
	return r
}

func TestPlanDocConsistentLogNeedsNothing(t *testing.T) {
	for name, rows := range map[string][]Row{
		"empty":     nil,
		"ascending": {row(1, clock.Ranked(0, 1), `{"status":"queued"}`), row(2, clock.Ranked(0, 3), `{"status":"ready"}`)},
		"published": {
			row(1, clock.Ranked(0, 3), `{"status":"ready","track_id":"t"}`),
			row(2, clock.Terminal(), `{"status":"ready","track_id":"t","origin":"published"}`),
		},
		"deleted": {row(1, clock.Ranked(0, 3), `{"status":"ready"}`), row(2, clock.Ranked(0, 4), "")},
	} {
		if p, ok, err := PlanDoc(testKey, rows); err != nil || ok {
			t.Errorf("%s: want no plan, got %+v ok=%v err=%v", name, p, ok, err)
		}
	}
}

// A lower state appended after ready is repaired with ready's data at the
// stamp just above ready — still below the next rank.
func TestPlanDocMisordered(t *testing.T) {
	rows := []Row{
		row(1, clock.Ranked(0, 1), `{"status":"queued"}`),
		row(2, clock.Ranked(0, 3), `{"status":"ready"}`),
		row(3, clock.Ranked(0, 2), `{"status":"processing"}`),
	}
	p, ok, err := PlanDoc(testKey, rows)
	if err != nil || !ok {
		t.Fatalf("want a plan, ok=%v err=%v", ok, err)
	}
	if p.Reason != ReasonMisordered || p.Newest.Seq != 3 || p.Master.Seq != 2 {
		t.Fatalf("wrong plan: %+v", p)
	}
	if string(p.Data) != `{"status":"ready"}` || p.Op != "upsert" {
		t.Errorf("repair must carry the master state, got %s %s", p.Op, p.Data)
	}
	if p.HLC <= clock.Ranked(0, 3) || p.HLC >= clock.Ranked(0, 4) {
		t.Errorf("repair hlc %q must sit between ready and the next rank", p.HLC)
	}
}

// A deleted master is repaired with a delete.
func TestPlanDocMisorderedDelete(t *testing.T) {
	rows := []Row{row(1, clock.Ranked(0, 4), ""), row(2, clock.Ranked(0, 3), `{"status":"ready"}`)}
	p, ok, err := PlanDoc(testKey, rows)
	if err != nil || !ok || p.Op != "delete" || p.Data != nil {
		t.Fatalf("want a delete repair, got %+v ok=%v err=%v", p, ok, err)
	}
}

// A publish flip that merged a stale lower state is rewritten from the ready
// row, at physicalMod-1 counter 1 — the only stamp above Terminal.
func TestPlanDocStalePublish(t *testing.T) {
	rows := []Row{
		row(1, clock.Ranked(0, 3), `{"status":"ready","track_id":"t","audio_key":"k"}`),
		row(2, clock.Ranked(0, 2), `{"status":"processing","track_id":"t"}`),
		row(3, clock.Terminal(), `{"status":"processing","track_id":"t","origin":"published"}`),
	}
	p, ok, err := PlanDoc(testKey, rows)
	if err != nil || !ok {
		t.Fatalf("want a plan, ok=%v err=%v", ok, err)
	}
	if p.Reason != ReasonStalePublish {
		t.Fatalf("reason: want %s, got %s", ReasonStalePublish, p.Reason)
	}
	if want := "999999999999999:00001:" + hlc.ServerNodeID; p.HLC != want {
		t.Errorf("repair hlc: want %q, got %q", want, p.HLC)
	}
	same, err := jsonEqual(p.Data, json.RawMessage(`{"status":"ready","track_id":"t","audio_key":"k","origin":"published"}`))
	if err != nil || !same {
		t.Errorf("repair data must be ready + origin, got %s", p.Data)
	}

	// Re-planning with the corrective row appended finds nothing.
	rows = append(rows, Row{Seq: 4, Op: p.Op, Data: p.Data, HLC: p.HLC})
	if p2, ok, err := PlanDoc(testKey, rows); err != nil || ok {
		t.Fatalf("second plan must be empty, got %+v ok=%v err=%v", p2, ok, err)
	}
}

// A lower state appended after the publish flip is repaired with the flip's
// data above Terminal.
func TestPlanDocMisorderedAfterPublish(t *testing.T) {
	rows := []Row{
		row(1, clock.Ranked(0, 3), `{"status":"ready","track_id":"t"}`),
		row(2, clock.Terminal(), `{"status":"ready","track_id":"t","origin":"published"}`),
		row(3, clock.Ranked(0, 2), `{"status":"processing","track_id":"t"}`),
	}
	p, ok, err := PlanDoc(testKey, rows)
	if err != nil || !ok || p.Reason != ReasonMisordered || p.Master.Seq != 2 {
		t.Fatalf("want a misordered plan on the flip, got %+v ok=%v err=%v", p, ok, err)
	}
	if !hlc.AtTerminal(p.HLC) || p.HLC <= clock.Terminal() {
		t.Errorf("repair hlc %q must be above Terminal", p.HLC)
	}
}

// A flip is judged only against rows written before it: a higher-ranked row
// appended after the flip does not make the flip look stale.
func TestPlanDocFlipJudgedAgainstEarlierRowsOnly(t *testing.T) {
	flip := `{"status":"ready","track_id":"t","origin":"published"}`
	rows := []Row{
		row(1, clock.Ranked(0, 3), `{"status":"ready","track_id":"t"}`),
		row(2, clock.Terminal(), flip),
		row(3, clock.Ranked(1, 1), `{"status":"queued","track_id":"t"}`),
	}
	p, ok, err := PlanDoc(testKey, rows)
	if err != nil || !ok || p.Reason != ReasonMisordered {
		t.Fatalf("want a misordered plan, got %+v ok=%v err=%v", p, ok, err)
	}
	if string(p.Data) != flip {
		t.Errorf("repair must carry the flip's data, got %s", p.Data)
	}
}

// A publish flip over a deleted document has no master to merge, so it is
// never judged stale.
func TestPlanDocFlipOverDeleteIsNotStale(t *testing.T) {
	rows := []Row{
		row(1, clock.Ranked(0, 3), `{"status":"ready","track_id":"t","audio_key":"k"}`),
		row(2, clock.Ranked(0, 4), ""),
		row(3, clock.Terminal(), `{"status":"ready","track_id":"t","audio_key":"k","origin":"published"}`),
	}
	if p, ok, err := PlanDoc(testKey, rows); err != nil || ok {
		t.Fatalf("want no plan, got %+v ok=%v err=%v", p, ok, err)
	}
}
