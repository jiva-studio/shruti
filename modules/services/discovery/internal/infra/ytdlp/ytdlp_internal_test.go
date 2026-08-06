package ytdlp

import "testing"

// A dead video and a site refusing us look the same to the reader — one exit
// status and a line of text — and they must not be treated the same. Five dead
// links in a row is an ordinary channel; five refusals is a site to leave alone.
func TestGoneTellsADeadVideoFromARefusal(t *testing.T) {
	dead := []string{
		"ERROR: [youtube] abc: Video unavailable",
		"ERROR: [youtube] abc: Video unavailable. This video has been removed by the uploader",
		"ERROR: [youtube] abc: Private video. Sign in if you've been granted access to this video",
		"ERROR: [youtube] abc: Join this channel to get access to members-only content",
		"ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users",
	}
	for _, s := range dead {
		if !gone(s) {
			t.Errorf("not recognised as a dead video: %q", s)
		}
	}

	refusals := []string{
		"ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies-from-browser",
		"ERROR: unable to download video data: HTTP Error 429: Too Many Requests",
		"ERROR: Unable to connect to proxy",
	}
	for _, s := range refusals {
		if gone(s) {
			t.Errorf("a refusal must still count against the host: %q", s)
		}
	}
}

// A talk whose streams we cannot touch is still a talk. Its title, date and
// captions are all readable, and writing it off as gone loses the recording.
func TestGoneIgnoresFormatTroubles(t *testing.T) {
	for _, s := range []string{
		"ERROR: [youtube] abc: This video is not available",
		"ERROR: [youtube] abc: This video is DRM protected",
		"ERROR: [youtube] abc: Requested format is not available",
	} {
		if gone(s) {
			t.Errorf("a format problem is not a missing recording: %q", s)
		}
	}
}
