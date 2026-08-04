// Package prompts holds the shared review prompt templates used by every
// reviewer (anthropic, gemini, …). The text is the same regardless of
// provider — only the transport differs.
package prompts

import _ "embed"

//go:embed system.txt
var System string

// SystemLines asks for the same proofreading in a line format: only the
// segments that changed, plus the sentence-end idx. It exists because the
// JSON contract billed the caller for two things it discarded — the text of
// every unchanged segment, and the full membership of each sentence group,
// of which BuildEndSet keeps only the last idx.
//
//go:embed system.lines.txt
var SystemLines string

//go:embed user.txt
var User string
