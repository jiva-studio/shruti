package ws

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	v1 "github.com/jiva-studio/shruti/proto/v1"
)

// fakeFluidPath is the compiled test double for fluidstreamd. Built once in
// TestMain because fluidstreamd itself only builds on macOS.
var fakeFluidPath string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "streamd-test")
	if err != nil {
		panic(err)
	}
	defer os.RemoveAll(dir)

	fakeFluidPath = filepath.Join(dir, "fakefluid")
	build := exec.Command("go", "build", "-o", fakeFluidPath, "../engine/testdata/fakefluid")
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		panic("building fake fluidstreamd: " + err.Error())
	}

	os.Exit(m.Run())
}

func TestStreamRelaysUpdatesWithChannelStamped(t *testing.T) {
	srv := httptest.NewServer(Handler(fakeFluidPath))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	url := "ws" + strings.TrimPrefix(srv.URL, "http") + v1.StreamPath + "?channel=mic&lang=en"
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.CloseNow()

	// Send some live PCM (binary frame), then ask to close the session.
	pcm := make([]byte, 5120) // ~160 ms of s16le mono @ 16 kHz
	if err := conn.Write(ctx, websocket.MessageBinary, pcm); err != nil {
		t.Fatalf("write PCM: %v", err)
	}
	ctrl, _ := json.Marshal(v1.Control{Type: v1.CtrlClose})
	if err := conn.Write(ctx, websocket.MessageText, ctrl); err != nil {
		t.Fatalf("write control: %v", err)
	}

	// Read Updates until the server closes the connection.
	var got []v1.Update
	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			break // server closed gracefully after the final.
		}
		if typ != websocket.MessageText {
			t.Fatalf("expected text frame, got %v", typ)
		}
		var u v1.Update
		if err := json.Unmarshal(data, &u); err != nil {
			t.Fatalf("unmarshal update: %v", err)
		}
		got = append(got, u)
	}

	if len(got) == 0 {
		t.Fatal("received no updates")
	}
	var sawPartial, sawFinal bool
	for _, u := range got {
		if u.Channel != v1.ChannelMic {
			t.Errorf("update Channel = %q, want %q: %+v", u.Channel, v1.ChannelMic, u)
		}
		switch u.Type {
		case v1.TypePartial:
			sawPartial = true
		case v1.TypeFinal:
			sawFinal = true
		default:
			t.Errorf("unexpected update type %q", u.Type)
		}
	}
	if !sawPartial {
		t.Error("never received a partial update")
	}
	if !sawFinal {
		t.Error("never received a final update")
	}
}

func TestBadChannelRejected(t *testing.T) {
	srv := httptest.NewServer(Handler(fakeFluidPath))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Missing/invalid channel must be rejected before any WS upgrade.
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + v1.StreamPath + "?channel=bogus"
	conn, resp, err := websocket.Dial(ctx, url, nil)
	if err == nil {
		conn.CloseNow()
		t.Fatal("expected dial to fail for invalid channel")
	}
	if resp == nil || resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected HTTP 400, got resp=%v", resp)
	}
}
