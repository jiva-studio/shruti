package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/jiva-studio/lectorium/profile/internal/wire"
)

// epochTime decodes a timestamp from either an epoch NUMBER (the mobile
// user.db stores `Date.now()` milliseconds; seconds are tolerated when the
// value is small) or an RFC3339 STRING. The client wire ships numbers, so a
// plain `time.Time` (which only accepts a quoted RFC3339 string) fails with
// "input is not a JSON string". Use *epochTime for every timestamp field and
// bind it to pgx via tsArg.
type epochTime struct{ time.Time }

func (t *epochTime) UnmarshalJSON(b []byte) error {
	s := strings.TrimSpace(string(b))
	if s == "" || s == "null" {
		return nil
	}
	if s[0] == '"' { // RFC3339 string
		return t.Time.UnmarshalJSON(b)
	}
	f, err := strconv.ParseFloat(s, 64) // epoch number (ms or s)
	if err != nil {
		return fmt.Errorf("timestamp %q: %w", s, err)
	}
	n := int64(f)
	if n >= 1_000_000_000_000 { // >= ~2001 in ms → milliseconds
		t.Time = time.UnixMilli(n).UTC()
	} else {
		t.Time = time.Unix(n, 0).UTC()
	}
	return nil
}

// tsArg binds an optional timestamp to a pgx arg — time.Time, or nil for SQL
// NULL when the field was absent/null.
func tsArg(t *epochTime) any {
	if t == nil {
		return nil
	}
	return t.Time
}

// Collections is the whitelist of syncable collections. Each maps 1:1 to a
// typed state table. A push for any other collection is rejected.
var Collections = map[string]bool{
	"playlist_items":     true,
	"listening_sessions": true,
	"notes":              true,
	"chat_sessions":      true,
	"chat_messages":      true,
	// library_items is server-owned: written ONLY via the server-authored path
	// (Service.ApplyServerChange). Whitelisted here so ApplyState / pull treat
	// it as a first-class collection; clients pull it but never push it.
	"library_items": true,
}

// ServerOwned is the subset of Collections whose documents are authored ONLY by
// the server (Service.ApplyServerChange) and are pull-only for clients. The
// client Push path REJECTS these so a device can never forge or overwrite
// server-owned state; ApplyServerChange and the pull/projection paths still
// accept them. Every key here MUST also be in Collections.
var ServerOwned = map[string]bool{
	"library_items": true,
}

// ApplyState projects one already-validated change onto its typed state
// table inside the caller's transaction. Upserts convert the wire snapshot
// (client-native user.db row) into real columns; deletes tombstone the row.
//
// The wire→state conversion lives ONLY here (the push path) — pull ships the
// stored data blob back untouched and never reads a state table.
func ApplyState(ctx context.Context, q querier, userID uuid.UUID, it wire.PushItem) error {
	if it.Op == "delete" {
		return deleteState(ctx, q, userID, it.Collection, it.DocID)
	}
	switch it.Collection {
	case "playlist_items":
		return upsertPlaylistItem(ctx, q, userID, it)
	case "listening_sessions":
		return upsertListeningSession(ctx, q, userID, it)
	case "notes":
		return upsertNote(ctx, q, userID, it)
	case "chat_sessions":
		return upsertChatSession(ctx, q, userID, it)
	case "chat_messages":
		return upsertChatMessage(ctx, q, userID, it)
	case "library_items":
		return upsertLibraryItem(ctx, q, userID, it)
	default:
		return fmt.Errorf("unknown collection %q", it.Collection)
	}
}

// deleteState tombstones a document in its state table. For chat_sessions the
// composite FK cascade removes the session's chat_messages too.
func deleteState(ctx context.Context, q querier, userID uuid.UUID, collection, docID string) error {
	table, ok := stateTable[collection]
	if !ok {
		return fmt.Errorf("unknown collection %q", collection)
	}
	_, err := q.Exec(ctx,
		fmt.Sprintf(`DELETE FROM %s WHERE user_id = $1 AND doc_id = $2`, table),
		userID, docID,
	)
	return err
}

var stateTable = map[string]string{
	"playlist_items":     "profile.playlist_items",
	"listening_sessions": "profile.listening_sessions",
	"notes":              "profile.notes",
	"chat_sessions":      "profile.chat_sessions",
	"chat_messages":      "profile.chat_messages",
	"library_items":      "profile.library_items",
}

// --- typed row shapes (json tags == user.db / DDL column names) -----------

type playlistItemRow struct {
	TrackID      string     `json:"track_id"`
	AddedAt      *epochTime `json:"added_at"`
	ArchivedAt   *epochTime `json:"archived_at"`
	CollectionID *string    `json:"collection_id"`
}

type listeningSessionRow struct {
	ItemID       *string    `json:"item_id"`
	TrackID      *string    `json:"track_id"`
	StartedAt    *epochTime `json:"started_at"`
	EndedAt      *epochTime `json:"ended_at"`
	FromPosition *int       `json:"from_position"`
	ToPosition   *int       `json:"to_position"`
}

type noteRow struct {
	TrackID   *string         `json:"track_id"`
	Text      *string         `json:"text"`
	TimeStart *int            `json:"time_start"`
	TimeEnd   *int            `json:"time_end"`
	CreatedAt *epochTime      `json:"created_at"`
	Meta      json.RawMessage `json:"meta"`
}

type chatSessionRow struct {
	Title     *string    `json:"title"`
	TrackID   *string    `json:"track_id"`
	CreatedAt *epochTime `json:"created_at"`
	UpdatedAt *epochTime `json:"updated_at"`
}

type chatMessageRow struct {
	SessionID string          `json:"session_id"`
	Role      *string         `json:"role"`
	Content   *string         `json:"content"`
	Meta      json.RawMessage `json:"meta"`
	CreatedAt *epochTime      `json:"created_at"`
}

// libraryItemRow is the server-authored Personal Library projection. Every
// field is server-owned; json tags match the library_items columns the
// server-authored path ships in its data blob (there is no client user.db
// counterpart — the client only reads this collection).
type libraryItemRow struct {
	TrackID        *string    `json:"track_id"` // nullable until fetched
	Status         *string    `json:"status"`
	Origin         *string    `json:"origin"`
	Error          *string    `json:"error"`
	TitleRaw       *string    `json:"title_raw"`
	AuthorRaw      *string    `json:"author_raw"`
	LocationRaw    *string    `json:"location_raw"`
	DateRaw        *string    `json:"date_raw"`
	LangHint       *string    `json:"lang_hint"`
	AuthorID       *string    `json:"author_id"`
	LocationID     *string    `json:"location_id"`
	Date           *string    `json:"date"`
	DatePrecision  *string    `json:"date_precision"`
	Lang           *string    `json:"lang"`
	LangConfidence *float64   `json:"lang_confidence"`
	AudioKey       *string    `json:"audio_key"`
	TranscriptKey  *string    `json:"transcript_key"`
	CoverKey       *string    `json:"cover_key"`
	Duration       *int       `json:"duration"` // milliseconds
	AddedAt        *epochTime `json:"added_at"`
}

func decode(it wire.PushItem, dst any) error {
	if len(it.Data) == 0 {
		return fmt.Errorf("upsert of %s/%s has no data", it.Collection, it.DocID)
	}
	if err := json.Unmarshal(it.Data, dst); err != nil {
		return fmt.Errorf("decode %s/%s: %w", it.Collection, it.DocID, err)
	}
	return nil
}

func upsertPlaylistItem(ctx context.Context, q querier, userID uuid.UUID, it wire.PushItem) error {
	var row playlistItemRow
	if err := decode(it, &row); err != nil {
		return err
	}
	// doc_id is the natural key = track_id; fall back to it if the payload
	// omitted track_id (they are the same value by construction).
	trackID := row.TrackID
	if trackID == "" {
		trackID = it.DocID
	}
	_, err := q.Exec(ctx,
		`INSERT INTO profile.playlist_items (user_id, doc_id, track_id, added_at, archived_at, collection_id)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 ON CONFLICT (user_id, doc_id) DO UPDATE SET
		     track_id      = EXCLUDED.track_id,
		     added_at      = EXCLUDED.added_at,
		     archived_at   = EXCLUDED.archived_at,
		     collection_id = EXCLUDED.collection_id`,
		userID, it.DocID, trackID, tsArg(row.AddedAt), tsArg(row.ArchivedAt), row.CollectionID,
	)
	return err
}

func upsertListeningSession(ctx context.Context, q querier, userID uuid.UUID, it wire.PushItem) error {
	var row listeningSessionRow
	if err := decode(it, &row); err != nil {
		return err
	}
	_, err := q.Exec(ctx,
		`INSERT INTO profile.listening_sessions
		     (user_id, doc_id, item_id, track_id, started_at, ended_at, from_position, to_position)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		 ON CONFLICT (user_id, doc_id) DO UPDATE SET
		     item_id       = EXCLUDED.item_id,
		     track_id      = EXCLUDED.track_id,
		     started_at    = EXCLUDED.started_at,
		     ended_at      = EXCLUDED.ended_at,
		     from_position = EXCLUDED.from_position,
		     to_position   = EXCLUDED.to_position`,
		userID, it.DocID, row.ItemID, row.TrackID, tsArg(row.StartedAt), tsArg(row.EndedAt), row.FromPosition, row.ToPosition,
	)
	return err
}

func upsertNote(ctx context.Context, q querier, userID uuid.UUID, it wire.PushItem) error {
	var row noteRow
	if err := decode(it, &row); err != nil {
		return err
	}
	_, err := q.Exec(ctx,
		`INSERT INTO profile.notes
		     (user_id, doc_id, track_id, text, time_start, time_end, created_at, meta)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		 ON CONFLICT (user_id, doc_id) DO UPDATE SET
		     track_id   = EXCLUDED.track_id,
		     text       = EXCLUDED.text,
		     time_start = EXCLUDED.time_start,
		     time_end   = EXCLUDED.time_end,
		     created_at = EXCLUDED.created_at,
		     meta       = EXCLUDED.meta`,
		userID, it.DocID, row.TrackID, row.Text, row.TimeStart, row.TimeEnd,
		tsArg(row.CreatedAt), jsonbArg(row.Meta),
	)
	return err
}

func upsertChatSession(ctx context.Context, q querier, userID uuid.UUID, it wire.PushItem) error {
	var row chatSessionRow
	if err := decode(it, &row); err != nil {
		return err
	}
	_, err := q.Exec(ctx,
		`INSERT INTO profile.chat_sessions (user_id, doc_id, title, track_id, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 ON CONFLICT (user_id, doc_id) DO UPDATE SET
		     title      = EXCLUDED.title,
		     track_id   = EXCLUDED.track_id,
		     created_at = EXCLUDED.created_at,
		     updated_at = EXCLUDED.updated_at`,
		userID, it.DocID, row.Title, row.TrackID, tsArg(row.CreatedAt), tsArg(row.UpdatedAt),
	)
	return err
}

// upsertChatMessage guards on parent existence via WHERE EXISTS so an orphan
// message (its session already tombstoned) is dropped from the state table
// rather than aborting the transaction on a FK violation. The change-log row
// is still appended by the caller, so it replicates and each receiving device
// applies its own orphan-drop rule.
func upsertChatMessage(ctx context.Context, q querier, userID uuid.UUID, it wire.PushItem) error {
	var row chatMessageRow
	if err := decode(it, &row); err != nil {
		return err
	}
	_, err := q.Exec(ctx,
		`INSERT INTO profile.chat_messages (user_id, doc_id, session_id, role, content, meta, created_at)
		 SELECT $1, $2, $3, $4, $5, $6, $7
		  WHERE EXISTS (SELECT 1 FROM profile.chat_sessions WHERE user_id = $1 AND doc_id = $3)
		 ON CONFLICT (user_id, doc_id) DO UPDATE SET
		     role       = EXCLUDED.role,
		     content    = EXCLUDED.content,
		     meta       = EXCLUDED.meta,
		     created_at = EXCLUDED.created_at`,
		userID, it.DocID, row.SessionID, row.Role, row.Content, jsonbArg(row.Meta), tsArg(row.CreatedAt),
	)
	return err
}

// upsertLibraryItem projects a server-authored library_items change. doc_id is
// the library membership id (a uuid), independent of track_id (which stays
// NULL until the track is fetched). Mirrors upsertPlaylistItem's ON CONFLICT
// shape so a re-projection of the same doc is a full overwrite.
// LibraryMembershipsByTrack returns the membership doc_ids whose projected
// library_items row carries this track_id (0, 1, or more — a user may add the
// same source repeatedly, and each add is its own membership). MarkPublished uses
// it to map a promotion (which carries only the content hash) back to the
// membership row(s) to flip to origin='published'.
func LibraryMembershipsByTrack(ctx context.Context, q querier, userID uuid.UUID, trackID string) ([]string, error) {
	rows, err := q.Query(ctx,
		`SELECT doc_id FROM profile.library_items WHERE user_id = $1 AND track_id = $2`,
		userID, trackID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var d string
		if err := rows.Scan(&d); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func upsertLibraryItem(ctx context.Context, q querier, userID uuid.UUID, it wire.PushItem) error {
	var row libraryItemRow
	if err := decode(it, &row); err != nil {
		return err
	}
	_, err := q.Exec(ctx,
		`INSERT INTO profile.library_items
		     (user_id, doc_id, track_id, status, origin, error,
		      title_raw, author_raw, location_raw, date_raw, lang_hint,
		      author_id, location_id, date, date_precision, lang, lang_confidence,
		      audio_key, transcript_key, cover_key, duration, added_at)
		 VALUES ($1, $2, $3, $4, $5, $6,
		         $7, $8, $9, $10, $11,
		         $12, $13, $14, $15, $16, $17,
		         $18, $19, $20, $21, $22)
		 ON CONFLICT (user_id, doc_id) DO UPDATE SET
		     track_id        = EXCLUDED.track_id,
		     status          = EXCLUDED.status,
		     origin          = EXCLUDED.origin,
		     error           = EXCLUDED.error,
		     title_raw       = EXCLUDED.title_raw,
		     author_raw      = EXCLUDED.author_raw,
		     location_raw    = EXCLUDED.location_raw,
		     date_raw        = EXCLUDED.date_raw,
		     lang_hint       = EXCLUDED.lang_hint,
		     author_id       = EXCLUDED.author_id,
		     location_id     = EXCLUDED.location_id,
		     date            = EXCLUDED.date,
		     date_precision  = EXCLUDED.date_precision,
		     lang            = EXCLUDED.lang,
		     lang_confidence = EXCLUDED.lang_confidence,
		     audio_key       = EXCLUDED.audio_key,
		     transcript_key  = EXCLUDED.transcript_key,
		     cover_key       = EXCLUDED.cover_key,
		     duration        = EXCLUDED.duration,
		     added_at        = EXCLUDED.added_at`,
		userID, it.DocID, row.TrackID, row.Status, row.Origin, row.Error,
		row.TitleRaw, row.AuthorRaw, row.LocationRaw, row.DateRaw, row.LangHint,
		row.AuthorID, row.LocationID, row.Date, row.DatePrecision, row.Lang, row.LangConfidence,
		row.AudioKey, row.TranscriptKey, row.CoverKey, row.Duration, tsArg(row.AddedAt),
	)
	return err
}

// jsonbArg converts an optional raw JSON into a value pgx can bind to a jsonb
// column — nil (SQL NULL) when absent.
func jsonbArg(raw json.RawMessage) any {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	return []byte(raw)
}
