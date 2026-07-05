package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/profile/internal/wire"
)

// Collections is the whitelist of syncable collections. Each maps 1:1 to a
// typed state table. A push for any other collection is rejected.
var Collections = map[string]bool{
	"playlist_items":     true,
	"listening_sessions": true,
	"notes":              true,
	"chat_sessions":      true,
	"chat_messages":      true,
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
}

// --- typed row shapes (json tags == user.db / DDL column names) -----------

type playlistItemRow struct {
	TrackID      string     `json:"track_id"`
	AddedAt      *time.Time `json:"added_at"`
	ArchivedAt   *time.Time `json:"archived_at"`
	CollectionID *string    `json:"collection_id"`
}

type listeningSessionRow struct {
	ItemID        *string    `json:"item_id"`
	TrackID       *string    `json:"track_id"`
	StartedAt     *time.Time `json:"started_at"`
	EndedAt       *time.Time `json:"ended_at"`
	FromPositionS *int       `json:"from_position_s"`
	ToPositionS   *int       `json:"to_position_s"`
}

type noteRow struct {
	TrackID    *string         `json:"track_id"`
	Body       *string         `json:"body"`
	TimeStartS *int            `json:"time_start_s"`
	TimeEndS   *int            `json:"time_end_s"`
	CreatedAt  *time.Time      `json:"created_at"`
	UpdatedAt  *time.Time      `json:"updated_at"`
	Meta       json.RawMessage `json:"meta"`
}

type chatSessionRow struct {
	Title     *string    `json:"title"`
	TrackID   *string    `json:"track_id"`
	CreatedAt *time.Time `json:"created_at"`
	UpdatedAt *time.Time `json:"updated_at"`
}

type chatMessageRow struct {
	SessionID string          `json:"session_id"`
	Role      *string         `json:"role"`
	Content   *string         `json:"content"`
	Meta      json.RawMessage `json:"meta"`
	CreatedAt *time.Time      `json:"created_at"`
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
		userID, it.DocID, trackID, row.AddedAt, row.ArchivedAt, row.CollectionID,
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
		     (user_id, doc_id, item_id, track_id, started_at, ended_at, from_position_s, to_position_s)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		 ON CONFLICT (user_id, doc_id) DO UPDATE SET
		     item_id         = EXCLUDED.item_id,
		     track_id        = EXCLUDED.track_id,
		     started_at      = EXCLUDED.started_at,
		     ended_at        = EXCLUDED.ended_at,
		     from_position_s = EXCLUDED.from_position_s,
		     to_position_s   = EXCLUDED.to_position_s`,
		userID, it.DocID, row.ItemID, row.TrackID, row.StartedAt, row.EndedAt, row.FromPositionS, row.ToPositionS,
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
		     (user_id, doc_id, track_id, body, time_start_s, time_end_s, created_at, updated_at, meta)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		 ON CONFLICT (user_id, doc_id) DO UPDATE SET
		     track_id     = EXCLUDED.track_id,
		     body         = EXCLUDED.body,
		     time_start_s = EXCLUDED.time_start_s,
		     time_end_s   = EXCLUDED.time_end_s,
		     created_at   = EXCLUDED.created_at,
		     updated_at   = EXCLUDED.updated_at,
		     meta         = EXCLUDED.meta`,
		userID, it.DocID, row.TrackID, row.Body, row.TimeStartS, row.TimeEndS,
		row.CreatedAt, row.UpdatedAt, jsonbArg(row.Meta),
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
		userID, it.DocID, row.Title, row.TrackID, row.CreatedAt, row.UpdatedAt,
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
		userID, it.DocID, row.SessionID, row.Role, row.Content, jsonbArg(row.Meta), row.CreatedAt,
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
