package handler

import (
	"time"

	"github.com/jiva-studio/shruti/discovery/internal/store"
)

// collectionOut is a collection as the operator console lists it.
type collectionOut struct {
	ID          int64                 `json:"id"`
	SourceID    string                `json:"source,omitempty"`
	URL         string                `json:"url,omitempty"`
	Title       string                `json:"title"`
	Description string                `json:"description,omitempty"`
	Author      string                `json:"author,omitempty"`
	MemberCount int                   `json:"member_count"`
	Members     []collectionMemberOut `json:"members"`
	Pending     int                   `json:"pending,omitempty"`
}

type collectionMemberOut struct {
	Ordinal    int        `json:"ordinal"`
	ItemID     *int64     `json:"item_id,omitempty"`
	PageURL    string     `json:"page_url,omitempty"`
	Title      string     `json:"title,omitempty"`
	MediaURL   string     `json:"media_url,omitempty"`
	RecordedOn *time.Time `json:"recorded_on,omitempty"`
}

// authorOut is a person as the operator console lists them.
type authorOut struct {
	ID       int64    `json:"id"`
	Name     string   `json:"name"`
	Keys     []string `json:"keys,omitempty"`
	Variants []string `json:"variants,omitempty"`
	Items    int      `json:"items"`
}

func collectionsFrom(views []store.CollectionView) []collectionOut {
	if views == nil {
		return nil
	}
	out := make([]collectionOut, 0, len(views))
	for _, v := range views {
		out = append(out, collectionOut{
			ID:          v.ID,
			SourceID:    v.SourceID,
			URL:         v.URL,
			Title:       v.Title,
			Description: v.Description,
			Author:      v.Author,
			MemberCount: v.MemberCount,
			Members:     membersFrom(v.Members),
			Pending:     v.Pending,
		})
	}
	return out
}

func membersFrom(members []store.CollectionMember) []collectionMemberOut {
	if members == nil {
		return nil
	}
	out := make([]collectionMemberOut, 0, len(members))
	for _, m := range members {
		out = append(out, collectionMemberOut{
			Ordinal:    m.Ordinal,
			ItemID:     m.ItemID,
			PageURL:    m.PageURL,
			Title:      m.Title,
			MediaURL:   m.MediaURL,
			RecordedOn: m.RecordedOn,
		})
	}
	return out
}

func authorsFrom(authors []store.Author) []authorOut {
	if authors == nil {
		return nil
	}
	out := make([]authorOut, 0, len(authors))
	for _, a := range authors {
		out = append(out, authorOut{
			ID:       a.ID,
			Name:     a.Name,
			Keys:     a.Keys,
			Variants: a.Variants,
			Items:    a.Items,
		})
	}
	return out
}
