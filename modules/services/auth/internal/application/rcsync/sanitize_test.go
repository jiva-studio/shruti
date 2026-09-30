package rcsync

import (
	"errors"
	"strings"
	"testing"
)

func TestSanitizeRCError(t *testing.T) {
	tests := []struct {
		name string
		in   error
		want string
	}{
		{
			name: "nil",
			in:   nil,
			want: "",
		},
		{
			name: "plain rcclient wrap",
			in:   errors.New("rcclient: 502 Bad Gateway"),
			want: "rcclient: 502 Bad Gateway",
		},
		{
			name: "redacts email",
			in:   errors.New("rcclient: 401: invalid user user.name+x@example.co.uk in body"),
			want: "rcclient: 401: invalid user <email> in body",
		},
		{
			name: "redacts phone with plus",
			in:   errors.New("rcclient: 400: bad params +14155552671 rejected"),
			want: "rcclient: 400: bad params <phone> rejected",
		},
		{
			name: "redacts bare digit run",
			in:   errors.New("rcclient: 400: subscriber id 1234567890 not valid"),
			want: "rcclient: 400: subscriber id <phone> not valid",
		},
		{
			name: "preserves short numbers (status codes etc.)",
			in:   errors.New("rcclient: 502 Bad Gateway"),
			want: "rcclient: 502 Bad Gateway",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := SanitizeRCError(tc.in)
			if got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestSanitizeRCErrorTruncatesTo200(t *testing.T) {
	long := strings.Repeat("abc ", 100) // 400 chars
	err := errors.New(long)
	got := SanitizeRCError(err)
	if len(got) > 200 {
		t.Errorf("len: got %d, want <= 200", len(got))
	}
}

func TestSanitizeRCErrorRedactsBothEmailAndPhone(t *testing.T) {
	err := errors.New("rcclient: 400: alice@example.com / +15555555555 invalid")
	got := SanitizeRCError(err)
	if strings.Contains(got, "@example.com") {
		t.Errorf("email leaked: %q", got)
	}
	if strings.Contains(got, "+1555") {
		t.Errorf("phone leaked: %q", got)
	}
}
