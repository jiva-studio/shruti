// Package pgvector formats a float32 slice as a pgvector literal so it can be
// bound into SQL as `$n::vector` without registering a custom pgx type.
package pgvector

import (
	"fmt"
	"strconv"
	"strings"
)

// Literal renders [0.1,0.2,...] in the textual form pgvector accepts.
func Literal(v []float32) string {
	var b strings.Builder
	b.WriteByte('[')
	for i, f := range v {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(strconv.FormatFloat(float64(f), 'f', -1, 32))
	}
	b.WriteByte(']')
	return b.String()
}

// Parse reads back what Literal wrote. Vectors only came out of this database
// through a distance operator until the cache started keeping them.
func Parse(s string) ([]float32, error) {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "[")
	s = strings.TrimSuffix(s, "]")
	if s == "" {
		return nil, nil
	}
	parts := strings.Split(s, ",")
	out := make([]float32, len(parts))
	for i, p := range parts {
		f, err := strconv.ParseFloat(strings.TrimSpace(p), 32)
		if err != nil {
			return nil, fmt.Errorf("vector element %d: %w", i, err)
		}
		out[i] = float32(f)
	}
	return out, nil
}
