// Package imageutil re-encodes images before they are uploaded.
package imageutil

import (
	"bytes"
	"fmt"
	"image"
	"image/jpeg"
	_ "image/png" // register PNG decoder for image.Decode
)

// JPEG normalises generated or uploaded images to JPEG.
type JPEG struct{}

// Encode decodes a PNG or JPEG image and re-encodes it as JPEG at quality.
func (JPEG) Encode(data []byte, quality int) ([]byte, error) {
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("decode image: %w", err)
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: quality}); err != nil {
		return nil, fmt.Errorf("encode jpeg: %w", err)
	}
	return buf.Bytes(), nil
}
