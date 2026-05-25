// Package logging wires slog's JSON handler with the base fields the
// Datadog log pipeline auto-parses (service / env / version / level /
// timestamp / message). Same shape as the auth service so the Datadog
// pipeline doesn't need a per-service variant.
package logging

import (
	"log/slog"
	"os"
)

// Setup builds a JSON slog logger with `service`/`env`/`version` always
// present and installs it as slog.Default. Call once at boot.
func Setup(serviceName, env, version string) {
	h := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
		ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
			// slog default key is "msg"; Datadog standard attribute is
			// "message". Same with "time" → "timestamp".
			if a.Key == slog.MessageKey {
				a.Key = "message"
			}
			if a.Key == slog.TimeKey {
				a.Key = "timestamp"
			}
			return a
		},
	}).WithAttrs([]slog.Attr{
		slog.String("service", serviceName),
		slog.String("env", env),
		slog.String("version", version),
	})
	slog.SetDefault(slog.New(h))
}
