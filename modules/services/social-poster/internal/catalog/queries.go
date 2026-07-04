package catalog

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/jiva-studio/shruti-social-poster/internal/config"
)

// errNotLoaded is returned when a query runs before a successful Refresh.
var errNotLoaded = fmt.Errorf("catalog not loaded")

// Wisdom returns the pool of daily_wisdom candidates for a language,
// optionally narrowed to a topic. Ordering / picking is the selector's job.
func (c *Catalog) Wisdom(ctx context.Context, lang, topicID string) ([]Candidate, error) {
	db := c.currentDB()
	if db == nil {
		return nil, errNotLoaded
	}
	q := `
SELECT dw.id, dw.track_id, dw.language, dw.start_ms, dw.end_ms, dw.text,
       tv.title, tv.audio_path, COALESCE(tv.audio_duration,0),
       dw.topic_id, COALESCE(tp.full_name,''),
       COALESCE(a.full_name,''), COALESCE(l.full_name,''),
       COALESCE(t.date,''),
       COALESCE((SELECT MAX(weight) FROM track_topics tt WHERE tt.track_id=dw.track_id),0)
FROM daily_wisdom dw
JOIN track_variants tv ON tv.track_id=dw.track_id AND tv.language=dw.language
JOIN tracks t          ON t.id=dw.track_id
LEFT JOIN topics tp    ON tp.id=dw.topic_id AND tp.language=dw.language
LEFT JOIN authors a    ON a.id=t.author_id  AND a.language=dw.language
LEFT JOIN locations l  ON l.id=t.location_id AND l.language=dw.language
WHERE dw.language=? AND tv.audio_path IS NOT NULL AND t.hidden=0`
	args := []any{lang}
	if topicID != "" {
		q += " AND dw.topic_id=?"
		args = append(args, topicID)
	}
	return c.scanWisdom(ctx, db, q, args)
}

// Lectures returns the pool of lecture candidates for a language,
// optionally narrowed to a month-day ("MM-DD", for on-this-day) and/or a
// topic id.
func (c *Catalog) Lectures(ctx context.Context, lang, monthDay, topicID string) ([]Candidate, error) {
	db := c.currentDB()
	if db == nil {
		return nil, errNotLoaded
	}
	q := `
SELECT t.id, tv.language, tv.title, COALESCE(tv.description,''),
       tv.audio_path, COALESCE(tv.audio_duration,0),
       COALESCE(a.full_name,''), COALESCE(l.full_name,''), COALESCE(t.date,''),
       COALESCE((SELECT MAX(weight) FROM track_topics tt WHERE tt.track_id=t.id),0)
FROM tracks t
JOIN track_variants tv ON tv.track_id=t.id
LEFT JOIN authors a    ON a.id=t.author_id  AND a.language=tv.language
LEFT JOIN locations l  ON l.id=t.location_id AND l.language=tv.language
WHERE tv.language=? AND tv.audio_path IS NOT NULL AND t.hidden=0`
	args := []any{lang}
	if monthDay != "" {
		q += " AND substr(t.date,6,5)=?"
		args = append(args, monthDay)
	}
	if topicID != "" {
		q += " AND EXISTS (SELECT 1 FROM track_topics tt WHERE tt.track_id=t.id AND tt.topic_id=?)"
		args = append(args, topicID)
	}
	rows, err := db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("query lectures: %w", err)
	}
	defer rows.Close()
	var out []Candidate
	for rows.Next() {
		var c Candidate
		c.Kind = config.ContentLecture
		if err := rows.Scan(&c.TrackID, &c.Language, &c.Title, &c.Text,
			&c.AudioPath, &c.DurationMs, &c.Author, &c.Location, &c.Date, &c.Weight); err != nil {
			return nil, fmt.Errorf("scan lecture: %w", err)
		}
		c.ID = c.TrackID
		out = append(out, c)
	}
	return out, rows.Err()
}

func (c *Catalog) scanWisdom(ctx context.Context, db *sql.DB, q string, args []any) ([]Candidate, error) {
	rows, err := db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("query wisdom: %w", err)
	}
	defer rows.Close()
	var out []Candidate
	for rows.Next() {
		var c Candidate
		c.Kind = config.ContentDailyWisdom
		if err := rows.Scan(&c.ID, &c.TrackID, &c.Language, &c.StartMs, &c.EndMs, &c.Text,
			&c.Title, &c.AudioPath, &c.DurationMs, &c.TopicID, &c.TopicName,
			&c.Author, &c.Location, &c.Date, &c.Weight); err != nil {
			return nil, fmt.Errorf("scan wisdom: %w", err)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
