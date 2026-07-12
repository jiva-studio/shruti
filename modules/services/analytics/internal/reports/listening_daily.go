package reports

import (
	"context"
	"fmt"
	"net/url"
	"time"
)

// dateLayout is the wire format for the from/to params and each day key.
const dateLayout = "2006-01-02"

// maxRangeDays bounds a single request. Kept here as a hard ceiling; the
// service config's MAX_RANGE_DAYS can only tighten it further via the handler
// if wired, but this constant is the safety net inside the report itself.
const maxRangeDays = 400

// dayPoint is one raw data point: listening seconds bucketed to a calendar day.
type dayPoint struct {
	Date    string `json:"date"`
	Seconds int64  `json:"seconds"`
}

// listeningDailyResult is pure data — no rate, no total, no derived fields.
// The client sums / computes velocity / formats hours+minutes itself.
type listeningDailyResult struct {
	From string     `json:"from"`
	To   string     `json:"to"`
	Tz   string     `json:"tz"`
	Days []dayPoint `json:"days"`
}

// listeningDailyQuery buckets listening spans by local calendar day in the
// requested timezone, over a dense from..to series (missing days -> 0). The
// span formula mirrors the per-user report: GREATEST(0, to-from) seconds, NULL
// endpoints excluded. Bucketing is by ended_at (the projection's last-touch
// time) — see the report doc for the multi-day-session approximation caveat.
const listeningDailyQuery = `
SELECT to_char(g::date, 'YYYY-MM-DD') AS date,
       COALESCE(t.secs, 0)::bigint    AS seconds
FROM generate_series($1::date, $2::date, interval '1 day') AS g
LEFT JOIN (
    SELECT ((ended_at AT TIME ZONE $3)::date) AS day,
           SUM(GREATEST(0, to_position - from_position)) AS secs
    FROM profile.listening_sessions
    WHERE from_position IS NOT NULL
      AND to_position   IS NOT NULL
      AND ended_at >= (($1::date)::timestamp AT TIME ZONE $3)
      AND ended_at <  ((($2::date + 1))::timestamp AT TIME ZONE $3)
    GROUP BY day
) AS t ON t.day = g::date
ORDER BY g`

// ListeningDaily implements the listening_daily report.
//
//	GET /analytics/reports/listening_daily?from=YYYY-MM-DD&to=YYYY-MM-DD[&tz=IANA]
func ListeningDaily(ctx context.Context, deps Deps, q url.Values) (any, map[string]any, error) {
	fromStr := q.Get("from")
	toStr := q.Get("to")
	if fromStr == "" || toStr == "" {
		return nil, nil, BadParam("from and to are required (YYYY-MM-DD)")
	}
	from, err := time.Parse(dateLayout, fromStr)
	if err != nil {
		return nil, nil, BadParam("from must be YYYY-MM-DD")
	}
	to, err := time.Parse(dateLayout, toStr)
	if err != nil {
		return nil, nil, BadParam("to must be YYYY-MM-DD")
	}
	if to.Before(from) {
		return nil, nil, BadParam("to must be on or after from")
	}
	// Inclusive range width in days.
	spanDays := int(to.Sub(from).Hours()/24) + 1
	if spanDays > maxRangeDays {
		return nil, nil, BadParam(fmt.Sprintf("range too wide: %d days (max %d)", spanDays, maxRangeDays))
	}

	tz := q.Get("tz")
	if tz == "" {
		tz = "UTC"
	}
	if _, err := time.LoadLocation(tz); err != nil {
		return nil, nil, BadParam("tz must be a valid IANA timezone")
	}

	rows, err := deps.Pool.Query(ctx, listeningDailyQuery, fromStr, toStr, tz)
	if err != nil {
		return nil, nil, fmt.Errorf("query listening_daily: %w", err)
	}
	defer rows.Close()

	days := make([]dayPoint, 0, spanDays)
	for rows.Next() {
		var d dayPoint
		if err := rows.Scan(&d.Date, &d.Seconds); err != nil {
			return nil, nil, fmt.Errorf("scan listening_daily: %w", err)
		}
		days = append(days, d)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("iterate listening_daily: %w", err)
	}

	result := listeningDailyResult{From: fromStr, To: toStr, Tz: tz, Days: days}
	params := map[string]any{"from": fromStr, "to": toStr, "tz": tz}
	return result, params, nil
}

func init() {
	Register(Report{
		Name: "listening_daily",
		TTL:  60 * time.Second,
		Fn:   ListeningDaily,
	})
}
