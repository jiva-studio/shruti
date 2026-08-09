package fstopics

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"

	domaintopics "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/topics"
)

// Heading vectors are kept between builds because embedding them is the whole
// cost of a build: 166k distinct headings take about an hour and a half, while
// the clustering that follows runs locally in minutes. Without this, trying a
// different k means paying for the same vectors again — which is why k has
// never been chosen by measurement.
//
// The file is binary on purpose. The same content as JSON is roughly a
// gigabyte; as little-endian float32 it is dim×4 bytes per heading, so 256
// dimensions over 166k headings come to ~170 MB.
//
// Layout: [8-byte big-endian header length][JSON header][float32 payload].
const vectorsKey = "artifacts/topics/heading-vectors.bin"

type vectorsHeader struct {
	Model  string   `json:"model"`
	Dim    int      `json:"dim"`
	Titles []string `json:"titles"`
}

// WriteHeadingVectors stores one vector per title, in order.
func (s *Store) WriteHeadingVectors(ctx context.Context, v domaintopics.HeadingVectors) error {
	if len(v.Titles) != len(v.Vectors) {
		return fmt.Errorf("heading vectors: %d titles but %d vectors", len(v.Titles), len(v.Vectors))
	}
	head, err := json.Marshal(vectorsHeader{Model: v.Model, Dim: v.Dim, Titles: v.Titles})
	if err != nil {
		return fmt.Errorf("marshal heading vectors header: %w", err)
	}
	body := make([]byte, 8+len(head)+len(v.Vectors)*v.Dim*4)
	binary.BigEndian.PutUint64(body, uint64(len(head)))
	copy(body[8:], head)
	at := 8 + len(head)
	for i, vec := range v.Vectors {
		if len(vec) != v.Dim {
			return fmt.Errorf("heading vectors: row %d has %d values, want %d", i, len(vec), v.Dim)
		}
		for _, f := range vec {
			binary.LittleEndian.PutUint32(body[at:], math.Float32bits(f))
			at += 4
		}
	}
	return s.art.Write(ctx, vectorsKey, body)
}

// ReadHeadingVectors loads the cache. Returns os.ErrNotExist when no build has
// written one yet — the caller then embeds everything from scratch.
func (s *Store) ReadHeadingVectors() (domaintopics.HeadingVectors, error) {
	body, err := s.art.Read(vectorsKey)
	if err != nil {
		return domaintopics.HeadingVectors{}, err
	}
	if len(body) < 8 {
		return domaintopics.HeadingVectors{}, fmt.Errorf("heading vectors: file is truncated")
	}
	n := int(binary.BigEndian.Uint64(body))
	if n < 0 || 8+n > len(body) {
		return domaintopics.HeadingVectors{}, fmt.Errorf("heading vectors: header length %d does not fit the file", n)
	}
	var head vectorsHeader
	if err := json.Unmarshal(body[8:8+n], &head); err != nil {
		return domaintopics.HeadingVectors{}, fmt.Errorf("parse heading vectors header: %w", err)
	}
	want := len(head.Titles) * head.Dim * 4
	payload := body[8+n:]
	if head.Dim <= 0 || len(payload) != want {
		return domaintopics.HeadingVectors{}, fmt.Errorf(
			"heading vectors: payload is %d bytes, expected %d for %d titles × %d dims",
			len(payload), want, len(head.Titles), head.Dim)
	}
	vecs := make([][]float32, len(head.Titles))
	at := 0
	for i := range vecs {
		row := make([]float32, head.Dim)
		for j := range row {
			row[j] = math.Float32frombits(binary.LittleEndian.Uint32(payload[at:]))
			at += 4
		}
		vecs[i] = row
	}
	return domaintopics.HeadingVectors{
		Model:   head.Model,
		Dim:     head.Dim,
		Titles:  head.Titles,
		Vectors: vecs,
	}, nil
}
