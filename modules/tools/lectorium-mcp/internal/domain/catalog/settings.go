package catalog

// Setting is one row of the general-purpose `settings` settings store.
// Value is opaque to the store (typically a JSON document); meaning is owned
// by the config registry that validates each key.
type Setting struct {
	Key       string `json:"key"`
	Value     string `json:"value"`
	UpdatedAt int64  `json:"updated_at"`
}
