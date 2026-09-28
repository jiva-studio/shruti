package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/profile/internal/application/repair"
	"github.com/jiva-studio/shruti/profile/internal/config"
	"github.com/jiva-studio/shruti/profile/internal/infra/postgres"
)

// runRepairSync is `profile repair-sync [--apply] [--user <uuid>]`: it lists
// every server-owned document whose change log would lead installed clients
// to the wrong state and, with --apply, appends one corrective row per
// document. Without --apply it only reads.
func runRepairSync(args []string, out io.Writer) int {
	fs := flag.NewFlagSet("repair-sync", flag.ContinueOnError)
	apply := fs.Bool("apply", false, "write corrective rows (default: dry run, read-only)")
	user := fs.String("user", "", "limit the scan to one user id")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	var userID *uuid.UUID
	if *user != "" {
		id, err := uuid.Parse(*user)
		if err != nil {
			slog.Error("bad --user", "err", err)
			return 2
		}
		userID = &id
	}

	cfg, err := config.Load()
	if err != nil {
		slog.Error("config load failed", "err", err)
		return 2
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := postgres.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		slog.ErrorContext(ctx, "db_connect_failed", "err", err.Error())
		return 1
	}
	defer pool.Close()
	st := postgres.NewStore(pool)
	if err := st.SchemaReady(ctx); err != nil {
		slog.ErrorContext(ctx, "schema_not_ready", "err", err.Error())
		return 1
	}

	r, err := repair.New(st, st, userID)
	if err != nil {
		slog.ErrorContext(ctx, "wiring_failed", "err", err.Error())
		return 1
	}
	plans, err := r.Scan(ctx)
	if err != nil {
		slog.ErrorContext(ctx, "repair_scan_failed", "err", err.Error())
		return 1
	}
	mode := "dry-run"
	if *apply {
		mode = "apply"
	}
	writePlans(out, mode, "planned", plans)
	if !*apply {
		return 0
	}
	applied, err := r.Apply(ctx, plans)
	writePlans(out, mode, "applied", applied)
	if err != nil {
		slog.ErrorContext(ctx, "repair_apply_failed", "err", err.Error())
		return 1
	}
	return 0
}

// writePlans prints one tab-separated line per plan and a summary line. Only
// status and origin are shown from the data, never titles or keys.
func writePlans(out io.Writer, mode, verb string, plans []repair.Plan) {
	for _, p := range plans {
		fmt.Fprintf(out, "%s\t%s\t%s\t%s\t%s\tnewest=%d@%s\tmaster=%d@%s\trepair=%s@%s\t%s\n",
			verb, p.Reason, p.UserID, p.Collection, p.DocID,
			p.Newest.Seq, p.Newest.HLC, p.Master.Seq, p.Master.HLC,
			p.Op, p.HLC, summary(p.Newest.Op, p.Newest.Data)+" -> "+summary(p.Op, p.Data))
	}
	fmt.Fprintf(out, "%s: %d document(s) %s\n", mode, len(plans), verb)
}

func summary(op string, data json.RawMessage) string {
	if op == "delete" {
		return "deleted"
	}
	var d struct {
		Status *string `json:"status"`
		Origin *string `json:"origin"`
	}
	if err := json.Unmarshal(data, &d); err != nil {
		return "undecodable"
	}
	return fmt.Sprintf("status=%s,origin=%s", deref(d.Status), deref(d.Origin))
}

func deref(s *string) string {
	if s == nil {
		return "-"
	}
	return *s
}
