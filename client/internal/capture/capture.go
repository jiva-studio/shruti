// Package capture records independent live audio streams as raw s16le / 16 kHz
// / mono PCM using PipeWire (pw-record) or PulseAudio (parec).
//
// It resolves a list of Sources — by default the system output (the default
// sink's monitor, "они") and the microphone (the default source, "я") — and
// runs one capture subprocess per source. Each source's frames are exposed on
// its own channel keyed by Source.Channel. Add more sources (a second mic, a
// specific app's output) by extending DetectSources; nothing else changes.
package capture

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"
	"sync"

	v1 "github.com/jiva-studio/shruti/proto/v1"
)

// frameBytes is the read chunk size: 100 ms at the frozen format
// (16000 Hz * 2 bytes * 0.1 s = 3200 bytes).
const frameBytes = v1.SampleRate * v1.BytesPerFrame / 10

// Source is one resolved capture endpoint.
type Source struct {
	// Channel labels the stream, e.g. v1.ChannelSystem / v1.ChannelMic.
	Channel string
	// Target is the capture argument: the numeric PipeWire node id for
	// pw-record (name-based targets race when two instances run concurrently —
	// both bind the same node), or the device name for parec.
	Target string
	// Name is the human-readable node name, for logging.
	Name string
}

// Capture runs one subprocess per Source, each streaming PCM frames on its own
// channel.
type Capture struct {
	sources []Source
	backend string // "pipewire" (pw-record) or "pulse" (parec)
	out     map[string]chan []byte

	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// Sources reports the resolved sources (for logging/verification).
func (c *Capture) Sources() []Source { return c.sources }

// Backend reports the capture backend in use.
func (c *Capture) Backend() string { return c.backend }

// Frames returns the PCM frame channel for a source's Channel label (nil if
// absent). The channel is closed when capture stops.
func (c *Capture) Frames(channel string) <-chan []byte { return c.out[channel] }

// Device is a selectable audio endpoint for the UI dropdowns.
type Device struct {
	ID    string `json:"id"`    // numeric PipeWire node id (pw-record --target)
	Name  string `json:"name"`  // node.name (stable-ish identifier)
	Label string `json:"label"` // human description for the dropdown
	Kind  string `json:"kind"`  // "sink" (system output → capture its monitor) | "source" (mic)
}

// ListDevices enumerates audio sinks (system-output options — captured via their
// monitor) and sources (microphones) so the UI can offer explicit choices.
func ListDevices(ctx context.Context) ([]Device, error) {
	out, err := exec.CommandContext(ctx, "pw-dump").Output()
	if err != nil {
		return nil, fmt.Errorf("pw-dump: %w", err)
	}
	var objs []struct {
		ID   int    `json:"id"`
		Type string `json:"type"`
		Info struct {
			Props map[string]json.RawMessage `json:"props"`
		} `json:"info"`
	}
	if err := json.Unmarshal(out, &objs); err != nil {
		return nil, fmt.Errorf("pw-dump parse: %w", err)
	}
	str := func(m map[string]json.RawMessage, k string) string {
		if raw, ok := m[k]; ok {
			var s string
			if json.Unmarshal(raw, &s) == nil {
				return s
			}
		}
		return ""
	}
	var devs []Device
	for _, o := range objs {
		if o.Type != "PipeWire:Interface:Node" {
			continue
		}
		p := o.Info.Props
		class := str(p, "media.class")
		var kind string
		switch class {
		case "Audio/Sink":
			kind = "sink"
		case "Audio/Source":
			kind = "source"
		default:
			continue
		}
		name := str(p, "node.name")
		if name == "" {
			continue
		}
		label := str(p, "node.description")
		if label == "" {
			label = str(p, "node.nick")
		}
		if label == "" {
			label = name
		}
		devs = append(devs, Device{ID: strconv.Itoa(o.ID), Name: name, Label: label, Kind: kind})
	}
	return devs, nil
}

// Start resolves the default sources, spawns one subprocess each, and streams
// frames. Call Stop to release resources.
func Start(ctx context.Context) (*Capture, error) {
	sources, backend, err := DetectSources(ctx)
	if err != nil {
		return nil, fmt.Errorf("capture: detect sources: %w", err)
	}
	return StartOn(ctx, sources, backend)
}

// StartOn streams from an explicit set of sources (e.g. user-chosen devices).
func StartOn(ctx context.Context, sources []Source, backend string) (*Capture, error) {
	ctx, cancel := context.WithCancel(ctx)
	c := &Capture{
		sources: sources,
		backend: backend,
		out:     make(map[string]chan []byte, len(sources)),
		cancel:  cancel,
	}
	for _, s := range sources {
		ch := make(chan []byte, 32)
		c.out[s.Channel] = ch
		if err := c.spawn(ctx, s, ch); err != nil {
			cancel()
			return nil, fmt.Errorf("capture: start %s stream: %w", s.Channel, err)
		}
	}
	return c, nil
}

// Stop terminates all subprocesses and closes every frame channel.
func (c *Capture) Stop() {
	c.cancel()
	c.wg.Wait()
}

// spawn launches one capture subprocess and forwards fixed-size frames onto out,
// which is closed when the process exits.
func (c *Capture) spawn(ctx context.Context, s Source, out chan<- []byte) error {
	name, args := command(c.backend, s.Target)
	cmd := exec.CommandContext(ctx, name, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = io.Discard // the subprocess is chatty on start-up
	if err := cmd.Start(); err != nil {
		return err
	}

	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		defer close(out)
		defer func() { _ = cmd.Wait() }()

		r := bufio.NewReaderSize(stdout, frameBytes*4)
		for {
			buf := make([]byte, frameBytes)
			n, err := io.ReadFull(r, buf)
			if n > 0 {
				select {
				case out <- buf[:n]:
				case <-ctx.Done():
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()
	return nil
}

// command builds the subprocess argv for a target on a backend. Both back-ends
// emit raw s16le/16k/mono PCM to stdout ("-").
func command(backend, target string) (string, []string) {
	switch backend {
	case "pulse":
		return "parec", []string{
			"--device=" + target, "--rate=16000", "--channels=1", "--format=s16le",
		}
	default: // pipewire
		return "pw-record", []string{
			"--target", target, "--rate", "16000", "--channels", "1", "--format", "s16", "-",
		}
	}
}

// DetectSources resolves the default system-output and microphone sources and
// the backend. Prefers PulseAudio's pactl (deriving "<sink>.monitor") and
// otherwise uses PipeWire (numeric node ids via pw-dump).
func DetectSources(ctx context.Context) ([]Source, string, error) {
	if _, err := exec.LookPath("pactl"); err == nil {
		if s, err := detectPulse(ctx); err == nil {
			return s, "pulse", nil
		}
	}
	s, err := detectPipeWire(ctx)
	return s, "pipewire", err
}

func detectPulse(ctx context.Context) ([]Source, error) {
	sink, err := runTrim(ctx, "pactl", "get-default-sink")
	if err != nil {
		return nil, err
	}
	src, err := runTrim(ctx, "pactl", "get-default-source")
	if err != nil {
		return nil, err
	}
	if sink == "" || src == "" {
		return nil, fmt.Errorf("pactl returned empty default device")
	}
	return []Source{
		{Channel: v1.ChannelSystem, Target: sink + ".monitor", Name: sink + ".monitor"},
		{Channel: v1.ChannelMic, Target: src, Name: src},
	}, nil
}

func detectPipeWire(ctx context.Context) ([]Source, error) {
	out, err := runTrim(ctx, "pw-metadata", "-n", "default")
	if err != nil {
		return nil, fmt.Errorf("pw-metadata: %w", err)
	}
	sink := extractMetaName(out, "default.audio.sink")
	src := extractMetaName(out, "default.audio.source")
	if sink == "" || src == "" {
		return nil, fmt.Errorf("could not resolve default sink/source from pw-metadata")
	}
	// pw-record captures a sink's monitor when targeted by the sink's id.
	nodes, err := listNodes(ctx)
	if err != nil {
		return nil, err
	}
	sinkID, ok := nodes[sink]
	if !ok {
		return nil, fmt.Errorf("sink node %q not found in pw-dump", sink)
	}
	srcID, ok := nodes[src]
	if !ok {
		return nil, fmt.Errorf("source node %q not found in pw-dump", src)
	}
	return []Source{
		{Channel: v1.ChannelSystem, Target: sinkID, Name: sink},
		{Channel: v1.ChannelMic, Target: srcID, Name: src},
	}, nil
}

// listNodes maps node.name → numeric node id from `pw-dump`.
func listNodes(ctx context.Context) (map[string]string, error) {
	out, err := exec.CommandContext(ctx, "pw-dump").Output()
	if err != nil {
		return nil, fmt.Errorf("pw-dump: %w", err)
	}
	var objs []struct {
		ID   int    `json:"id"`
		Type string `json:"type"`
		Info struct {
			Props map[string]json.RawMessage `json:"props"`
		} `json:"info"`
	}
	if err := json.Unmarshal(out, &objs); err != nil {
		return nil, fmt.Errorf("pw-dump parse: %w", err)
	}
	names := make(map[string]string)
	for _, o := range objs {
		if o.Type != "PipeWire:Interface:Node" {
			continue
		}
		raw, ok := o.Info.Props["node.name"]
		if !ok {
			continue
		}
		var name string
		if json.Unmarshal(raw, &name) == nil && name != "" {
			names[name] = strconv.Itoa(o.ID)
		}
	}
	return names, nil
}

// extractMetaName pulls the node name for a pw-metadata key. Lines look like:
//
//	update: id:0 key:'default.audio.sink' value:'{"name":"alsa_output..."}' type:...
func extractMetaName(out, key string) string {
	for _, line := range strings.Split(out, "\n") {
		if !strings.Contains(line, "key:'"+key+"'") {
			continue
		}
		const marker = `"name":"`
		i := strings.Index(line, marker)
		if i < 0 {
			return ""
		}
		rest := line[i+len(marker):]
		if j := strings.IndexByte(rest, '"'); j >= 0 {
			return rest[:j]
		}
	}
	return ""
}

func runTrim(ctx context.Context, name string, args ...string) (string, error) {
	out, err := exec.CommandContext(ctx, name, args...).Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}
