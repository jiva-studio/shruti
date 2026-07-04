// Package publisher defines the platform-agnostic Post and the Publisher
// interface. Concrete backends (telegram, vk, facebook) live alongside.
package publisher

import "context"

// Post is one ready-to-publish item. Not every field applies to every
// platform — see the per-platform matrix in the design doc. Publishers
// use what they support and ignore the rest.
type Post struct {
	ContentID string // wisdom/track id, for logging & idempotency
	Kind      string // daily_wisdom | lecture
	Lang      string

	Text     string // caption / post body, already formatted
	AudioURL string // public mp3 (Telegram sendAudio)
	ImageURL string // poster image (VK / Facebook)
	AudioRef string // VK "audio{owner}_{id}" attachment, optional

	Title  string // audio title (Telegram)
	Artist string // audio performer (Telegram)
}

// Result carries the platform's reference to the created post (message id,
// wall post id, …) for the state log.
type Result struct {
	Ref string
}

// Publisher publishes a Post to one destination.
type Publisher interface {
	// Name is the target name from config (e.g. "telegram_ru").
	Name() string
	// Platform is one of config.Platform*.
	Platform() string
	// Publish sends the post; the returned Result.Ref is stored in state.
	Publish(ctx context.Context, p Post) (Result, error)
}
