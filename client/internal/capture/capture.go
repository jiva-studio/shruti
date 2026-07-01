// Package capture records two independent live audio streams as raw
// s16le / 16 kHz / mono PCM using PipeWire (pw-record) or PulseAudio (parec):
//
//   - system: the default sink's monitor — everything the apps play ("они").
//   - mic:    the default source — the local microphone ("я").
//
// Each stream is exposed as a <-chan []byte carrying raw PCM frames exactly as
// captured; call Stop to tear both subprocesses down.
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

// frameBytes is the read chunk size: 100 ms of audio at the frozen format
// (16000 Hz * 2 bytes * 0.1 s = 3200 bytes). Small enough for low latency,
// large enough to avoid excessive syscalls/channel traffic.
const frameBytes = v1.SampleRate * v1.BytesPerFrame / 10

// Devices are the resolved capture endpoints for the two streams.
type Devices struct {
	// SystemTarget is the pw-record/parec target for the system audio.
	// For pw-record this is the sink's NUMERIC NODE ID (name-based targets race
	// when two pw-record run concurrently — both bind the same node); for parec
	// it is "<sink>.monitor".
	SystemTarget string
	// MicTarget is the target for the microphone: the numeric node id for
	// pw-record, or the source device name for parec.
	MicTarget string
	// SystemName / MicName are the human-readable node names (for logging).
	SystemName string
	MicName    string
	// Backend is "pipewire" (pw-record) or "pulse" (parec).
	Backend string
}

// Capture is a pair of running capture subprocesses.
type Capture struct {
	system chan []byte
	mic    chan []byte

	cancel context.CancelFunc
	wg     sync.WaitGroup

	devices Devices
}

// System returns the channel of raw PCM frames from the system audio (sink
// monitor). It is closed when the capture stops.
func (c *Capture) System() <-chan []byte { return c.system }

// Mic returns the channel of raw PCM frames from the microphone. It is closed
// when the capture stops.
func (c *Capture) Mic() <-chan []byte { return c.mic }

// Devices reports the resolved devices/backend, for logging and verification.
func (c *Capture) Devices() Devices { return c.devices }

// Start detects the default devices, spawns one capture subprocess per channel,
// and begins streaming PCM frames. Call Stop to release resources.
func Start(ctx context.Context) (*Capture, error) {
	devs, err := DetectDevices(ctx)
	if err != nil {
		return nil, fmt.Errorf("capture: detect devices: %w", err)
	}

	ctx, cancel := context.WithCancel(ctx)
	c := &Capture{
		system:  make(chan []byte, 32),
		mic:     make(chan []byte, 32),
		cancel:  cancel,
		devices: devs,
	}

	if err := c.spawn(ctx, devs.SystemTarget, v1.ChannelSystem, c.system); err != nil {
		cancel()
		return nil, fmt.Errorf("capture: start system stream: %w", err)
	}
	if err := c.spawn(ctx, devs.MicTarget, v1.ChannelMic, c.mic); err != nil {
		cancel()
		return nil, fmt.Errorf("capture: start mic stream: %w", err)
	}
	return c, nil
}

// Stop terminates both subprocesses and closes the two channels.
func (c *Capture) Stop() {
	c.cancel()
	c.wg.Wait()
}

// spawn launches a single capture subprocess reading raw PCM from its stdout
// and forwards fixed-size frames onto out. out is closed when the process exits.
func (c *Capture) spawn(ctx context.Context, target, label string, out chan<- []byte) error {
	name, args := c.devices.command(target)
	cmd := exec.CommandContext(ctx, name, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	// Drop stderr; the subprocess is chatty on start-up.
	cmd.Stderr = io.Discard
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
				// EOF / short read on shutdown, or process killed.
				return
			}
		}
	}()
	return nil
}

// command builds the subprocess argv for a capture target, depending on the
// detected backend. Both back-ends emit raw s16le/16k/mono PCM to stdout ("-").
func (d Devices) command(target string) (string, []string) {
	switch d.Backend {
	case "pulse":
		return "parec", []string{
			"--device=" + target,
			"--rate=16000",
			"--channels=1",
			"--format=s16le",
		}
	default: // pipewire
		return "pw-record", []string{
			"--target", target,
			"--rate", "16000",
			"--channels", "1",
			"--format", "s16",
			"-",
		}
	}
}

// DetectDevices resolves the default sink monitor and default source. It prefers
// PulseAudio's pactl when available (deriving "<sink>.monitor"), and otherwise
// falls back to PipeWire's pw-metadata (using the sink node name as the
// pw-record monitor target).
func DetectDevices(ctx context.Context) (Devices, error) {
	if _, err := exec.LookPath("pactl"); err == nil {
		if d, err := detectPulse(ctx); err == nil {
			return d, nil
		}
	}
	return detectPipeWire(ctx)
}

func detectPulse(ctx context.Context) (Devices, error) {
	sink, err := runTrim(ctx, "pactl", "get-default-sink")
	if err != nil {
		return Devices{}, err
	}
	src, err := runTrim(ctx, "pactl", "get-default-source")
	if err != nil {
		return Devices{}, err
	}
	if sink == "" || src == "" {
		return Devices{}, fmt.Errorf("pactl returned empty default device")
	}
	return Devices{
		SystemTarget: sink + ".monitor",
		MicTarget:    src,
		SystemName:   sink + ".monitor",
		MicName:      src,
		Backend:      "pulse",
	}, nil
}

func detectPipeWire(ctx context.Context) (Devices, error) {
	out, err := runTrim(ctx, "pw-metadata", "-n", "default")
	if err != nil {
		return Devices{}, fmt.Errorf("pw-metadata: %w", err)
	}
	sink := extractMetaName(out, "default.audio.sink")
	src := extractMetaName(out, "default.audio.source")
	if sink == "" || src == "" {
		return Devices{}, fmt.Errorf("could not resolve default sink/source from pw-metadata")
	}
	// Resolve names to NUMERIC node IDs. pw-record --target by NAME races when
	// two instances run concurrently (both end up bound to the same node —
	// system and mic capture identical audio); targeting by node id is stable.
	// pw-record on a sink's id captures that sink's monitor (the system audio).
	nodes, err := listNodes(ctx)
	if err != nil {
		return Devices{}, err
	}
	sinkID, ok := nodes[sink]
	if !ok {
		return Devices{}, fmt.Errorf("sink node %q not found in pw-dump", sink)
	}
	srcID, ok := nodes[src]
	if !ok {
		return Devices{}, fmt.Errorf("source node %q not found in pw-dump", src)
	}
	return Devices{
		SystemTarget: sinkID,
		MicTarget:    srcID,
		SystemName:   sink,
		MicName:      src,
		Backend:      "pipewire",
	}, nil
}

// listNodes returns a map of node.name → numeric node id from `pw-dump`.
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
