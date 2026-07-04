// Package pgvector formats a float32 slice as a pgvector literal so it can be
// bound into SQL as `$n::vector` without registering a custom pgx type.
package pgvector

import (
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
