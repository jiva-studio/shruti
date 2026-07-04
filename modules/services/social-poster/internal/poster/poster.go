// Package poster resolves a target's poster image URL from its config.
// v1 supports prebuilt (pick from a Bunny-hosted pool) and brand_static
// (one fixed image); render (drawing text over a template) is a later add.
package poster

import (
	"fmt"
	"math/rand"

	"github.com/jiva-studio/lectorium-social-poster/internal/config"
)

// Resolve returns the poster image URL for a post, or "" when the target
// carries no image (mode none). rng picks from the prebuilt pool.
func Resolve(p config.Poster, rng *rand.Rand) (string, error) {
	switch p.Mode {
	case "", "none":
		return "", nil
	case "brand_static":
		if p.Image == "" {
			return "", fmt.Errorf("poster mode brand_static requires image")
		}
		return p.Image, nil
	case "prebuilt":
		if len(p.Images) == 0 {
			return "", fmt.Errorf("poster mode prebuilt requires a non-empty images list")
		}
		return p.Images[rng.Intn(len(p.Images))], nil
	case "render":
		return "", fmt.Errorf("poster mode render is not implemented yet")
	default:
		return "", fmt.Errorf("unknown poster mode %q", p.Mode)
	}
}
