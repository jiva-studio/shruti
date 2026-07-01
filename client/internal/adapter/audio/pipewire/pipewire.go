// Package pipewire implements port.AudioSource on top of PipeWire's pw-record /
// pw-dump / pw-metadata CLIs. Each capture subprocess emits raw s16le/16k/mono
// PCM to stdout; sources are targeted by PipeWire object.serial (see ListDevices
// for why the pw-dump object id must NOT be used).
package pipewire

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

	"github.com/jiva-studio/shruti/client/internal/domain"
	"github.com/jiva-studio/shruti/client/internal/port"
)

// frameBytes is the read chunk size: 100 ms at the frozen format.
const frameBytes = domain.SampleRate * domain.BytesPerFrame / 10

// Adapter is the PipeWire audio source.
type Adapter struct{}

// New returns a PipeWire audio adapter.
func New() *Adapter { return &Adapter{} }

var _ port.AudioSource = (*Adapter)(nil)

// Devices enumerates sinks (system output — captured via monitor), sources
// (mics) and live application streams for the UI dropdowns.
func (a *Adapter) Devices(ctx context.Context) ([]domain.Device, error) {
	out, err := exec.CommandContext(ctx, "pw-dump").Output()
	if err != nil {
		return nil, fmt.Errorf("pw-dump: %w", err)
	}
	objs, err := parseNodes(out)
	if err != nil {
		return nil, err
	}
	var devs []domain.Device
	for _, o := range objs {
		p := o.Info.Props
		var kind string
		switch str(p, "media.class") {
		case "Audio/Sink":
			kind = "sink"
		case "Audio/Source":
			kind = "source"
		case "Stream/Output/Audio":
			kind = "app"
		default:
			continue
		}
		name := str(p, "node.name")
		if name == "" {
			continue
		}
		label := firstNonEmpty(str(p, "node.description"), str(p, "node.nick"))
		if kind == "app" {
			appName, media := str(p, "application.name"), str(p, "media.name")
			switch {
			case appName != "" && media != "" && media != appName:
				label = appName + " — " + media
			case appName != "":
				label = appName
			case media != "":
				label = media
			}
		}
		if label == "" {
			label = name
		}
		// Target pw-record by object.serial — NOT the pw-dump object id, which
		// --target does not accept (concurrent captures would then alias onto the
		// same default node and record identical audio).
		serial := str(p, "object.serial")
		if serial == "" {
			serial = strconv.Itoa(o.ID)
		}
		devs = append(devs, domain.Device{ID: serial, Name: name, Label: label, Kind: kind})
	}
	markDefaults(ctx, devs)
	return devs, nil
}

// Capture starts one pw-record per plan source, keyed by source channel index.
func (a *Adapter) Capture(ctx context.Context, plan domain.CapturePlan) (port.Capture, error) {
	if len(plan.Sources) == 0 {
		return nil, fmt.Errorf("pipewire: capture plan has no sources")
	}
	ctx, cancel := context.WithCancel(ctx)
	c := &capture{
		sources: plan.Sources,
		out:     make(map[int]chan []byte, len(plan.Sources)),
		cancel:  cancel,
	}
	for _, src := range plan.Sources {
		ch := make(chan []byte, 32)
		c.out[src.Channel] = ch
		if err := c.spawn(ctx, src, ch); err != nil {
			cancel()
			return nil, fmt.Errorf("pipewire: start channel %d: %w", src.Channel, err)
		}
	}
	return c, nil
}

// capture is a running multi-channel PipeWire capture.
type capture struct {
	sources []domain.Source
	out     map[int]chan []byte
	cancel  context.CancelFunc
	wg      sync.WaitGroup
}

func (c *capture) Sources() []domain.Source     { return c.sources }
func (c *capture) Frames(ch int) <-chan []byte  { return c.out[ch] }

func (c *capture) Stop() {
	c.cancel()
	c.wg.Wait()
}

// spawn launches one pw-record subprocess and forwards fixed-size frames to out.
func (c *capture) spawn(ctx context.Context, s domain.Source, out chan<- []byte) error {
	cmd := exec.CommandContext(ctx, "pw-record",
		"--target", s.Target, "--rate", "16000", "--channels", "1", "--format", "s16", "-")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = io.Discard // chatty on start-up
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

// --- pw-dump / pw-metadata parsing helpers ---

type pwNode struct {
	ID   int    `json:"id"`
	Type string `json:"type"`
	Info struct {
		State string                     `json:"state"`
		Props map[string]json.RawMessage `json:"props"`
	} `json:"info"`
}

func parseNodes(out []byte) ([]pwNode, error) {
	var objs []pwNode
	if err := json.Unmarshal(out, &objs); err != nil {
		return nil, fmt.Errorf("pw-dump parse: %w", err)
	}
	nodes := objs[:0]
	for _, o := range objs {
		if o.Type == "PipeWire:Interface:Node" {
			nodes = append(nodes, o)
		}
	}
	return nodes, nil
}

// markDefaults flags the current default sink/source so the UI can preselect them.
func markDefaults(ctx context.Context, devs []domain.Device) {
	out, err := exec.CommandContext(ctx, "pw-metadata", "-n", "default").Output()
	if err != nil {
		return
	}
	meta := string(out)
	defSink := extractMetaName(meta, "default.audio.sink")
	defSrc := extractMetaName(meta, "default.audio.source")
	for i := range devs {
		if (devs[i].Kind == "sink" && devs[i].Name == defSink) ||
			(devs[i].Kind == "source" && devs[i].Name == defSrc) {
			devs[i].Default = true
		}
	}
}

func str(m map[string]json.RawMessage, k string) string {
	raw, ok := m[k]
	if !ok {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var n json.Number
	if json.Unmarshal(raw, &n) == nil {
		return n.String()
	}
	return ""
}

func firstNonEmpty(vs ...string) string {
	for _, v := range vs {
		if v != "" {
			return v
		}
	}
	return ""
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
