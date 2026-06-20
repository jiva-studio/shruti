package catalog

// KeyValuePair is one row of the general-purpose `key_value` settings store.
// Value is opaque to the store (typically a JSON document); meaning is owned
// by the config registry that validates each key.
type KeyValuePair struct {
	Key       string `json:"key"`
	Value     string `json:"value"`
	UpdatedAt int64  `json:"updated_at"`
}
