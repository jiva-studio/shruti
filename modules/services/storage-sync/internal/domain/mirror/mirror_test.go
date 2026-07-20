package mirror

import "testing"

func TestNeedsTransfer(t *testing.T) {
	src := Object{Key: "public/tracks/h/audio/original.mp3", Size: 1024, SHA256: "abc"}

	cases := []struct {
		name string
		dst  MirrorState
		want bool
	}{
		{
			name: "absent from the mirror ships",
			dst:  MirrorState{Exists: false},
			want: true,
		},
		{
			name: "stamped and matching is skipped",
			dst:  MirrorState{Exists: true, Size: 1024, SHA256: "abc"},
			want: false,
		},
		{
			name: "stamped and differing ships (even when the size matches)",
			dst:  MirrorState{Exists: true, Size: 1024, SHA256: "def"},
			want: true,
		},
		{
			name: "legacy unstamped with the same size is kept (no corpus re-ship)",
			dst:  MirrorState{Exists: true, Size: 1024},
			want: false,
		},
		{
			name: "legacy unstamped with a different size ships",
			dst:  MirrorState{Exists: true, Size: 2048},
			want: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := NeedsTransfer(src, tc.dst); got != tc.want {
				t.Fatalf("NeedsTransfer = %v, want %v", got, tc.want)
			}
		})
	}
}

// The checksum stamp must win over size: a same-size but different-content
// object is exactly the case a size-only comparison would silently miss.
func TestNeedsTransferChecksumBeatsSize(t *testing.T) {
	src := Object{Key: "k", Size: 10, SHA256: "aaa"}
	dst := MirrorState{Exists: true, Size: 10, SHA256: "bbb"}
	if !NeedsTransfer(src, dst) {
		t.Fatal("same size but different checksum must ship")
	}
}
