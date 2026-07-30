// Package prompts holds the shared review prompt templates used by every
// reviewer (anthropic, gemini, …). The text is the same regardless of
// provider — only the transport differs.
package prompts

import _ "embed"

//go:embed system.txt
var System string

//go:embed user.txt
var User string
