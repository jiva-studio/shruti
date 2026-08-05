package gemini

import "strconv"

// The wire shapes below mirror what the endpoint actually returns, including
// two quirks worth knowing: batchStats counts arrive as strings, and the
// replies sit under metadata.output on a finished job while the operation
// envelope carries them under response.

type wirePart struct {
	Text string `json:"text,omitempty"`
}

type wireContent struct {
	Parts []wirePart `json:"parts,omitempty"`
	Role  string     `json:"role,omitempty"`
}

type wireCandidate struct {
	Content      wireContent `json:"content"`
	FinishReason string      `json:"finishReason,omitempty"`
}

type wireUsage struct {
	PromptTokenCount     int64 `json:"promptTokenCount"`
	CandidatesTokenCount int64 `json:"candidatesTokenCount"`
	ThoughtsTokenCount   int64 `json:"thoughtsTokenCount"`
}

type wireResponse struct {
	Candidates    []wireCandidate `json:"candidates"`
	UsageMetadata wireUsage       `json:"usageMetadata"`
	ModelVersion  string          `json:"modelVersion,omitempty"`
}

func (r wireResponse) text() string {
	for _, c := range r.Candidates {
		for _, p := range c.Content.Parts {
			if p.Text != "" {
				return p.Text
			}
		}
	}
	return ""
}

type wireStatus struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type wireInlined struct {
	Response wireResponse `json:"response"`
	Error    *wireStatus  `json:"error,omitempty"`
	Metadata struct {
		Key string `json:"key"`
	} `json:"metadata"`
}

type wireInlinedList struct {
	InlinedResponses []wireInlined `json:"inlinedResponses"`
}

type wireOutput struct {
	InlinedResponses wireInlinedList `json:"inlinedResponses"`
}

type wireStats struct {
	RequestCount    string `json:"requestCount"`
	PendingCount    string `json:"pendingRequestCount"`
	SuccessfulCount string `json:"successfulRequestCount"`
	FailedCount     string `json:"failedRequestCount"`
}

type wireJob struct {
	Name     string `json:"name"`
	Done     bool   `json:"done"`
	Metadata struct {
		State  string     `json:"state"`
		Stats  wireStats  `json:"batchStats"`
		Output wireOutput `json:"output"`
	} `json:"metadata"`
	Response wireOutput `json:"response"`
}

func (w wireJob) job(fallbackName string) Job {
	name := w.Name
	if name == "" {
		name = fallbackName
	}
	return Job{
		Name:  name,
		State: State(w.Metadata.State),
		Stats: Stats{
			Total:      atoi(w.Metadata.Stats.RequestCount),
			Pending:    atoi(w.Metadata.Stats.PendingCount),
			Successful: atoi(w.Metadata.Stats.SuccessfulCount),
			Failed:     atoi(w.Metadata.Stats.FailedCount),
		},
	}
}

func atoi(s string) int {
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0
	}
	return n
}

type wireItem struct {
	Request  wireItemRequest `json:"request"`
	Metadata struct {
		Key string `json:"key"`
	} `json:"metadata"`
}

type wireItemRequest struct {
	Contents          []wireContent   `json:"contents"`
	SystemInstruction *wireContent    `json:"systemInstruction,omitempty"`
	GenerationConfig  wireGenerateCfg `json:"generationConfig"`
}

// GenerationConfig deliberately has no thinkingConfig: gemini-flash-lite
// rejects thinkingBudget=0 outright, and measured on real review chunks it
// spends no thinking tokens anyway.
type wireGenerateCfg struct {
	Temperature     float64 `json:"temperature"`
	MaxOutputTokens int     `json:"maxOutputTokens,omitempty"`
}

func buildItem(r Request) wireItem {
	item := wireItem{
		Request: wireItemRequest{
			Contents: []wireContent{{
				Role:  "user",
				Parts: []wirePart{{Text: r.User}},
			}},
			GenerationConfig: wireGenerateCfg{
				Temperature:     r.Temperature,
				MaxOutputTokens: r.MaxTokens,
			},
		},
	}
	if r.System != "" {
		item.Request.SystemInstruction = &wireContent{Parts: []wirePart{{Text: r.System}}}
	}
	item.Metadata.Key = r.Key
	return item
}
