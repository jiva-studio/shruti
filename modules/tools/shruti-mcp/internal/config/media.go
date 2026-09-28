package config

type FFmpeg struct {
	Bin string `yaml:"bin"`
}

func (f *FFmpeg) applyDefaults() {
	if f.Bin == "" {
		f.Bin = "ffmpeg"
	}
}

// Denoiser configures the audio-denoiser subprocess used by track.audio.denoise.
type Denoiser struct {
	PythonBin string `yaml:"python_bin"` // interpreter with the denoise deps; default "python3"
	Script    string `yaml:"script"`     // path to audio-denoiser/denoise_mp3.py
}

func (d *Denoiser) applyDefaults() {
	if d.PythonBin == "" {
		d.PythonBin = "python3"
	}
}

// Transcribe configures the transcription stage. Multiple providers can be
// listed; the one named in `default` is used when transcript_create is
// invoked without an explicit `provider` argument.
type Transcribe struct {
	Default   string                        `yaml:"default"`
	Providers map[string]TranscribeProvider `yaml:"providers"`
}

// TranscribeProvider is a discriminated union — `kind` selects which
// adapter to instantiate; the other fields are kind-specific.
type TranscribeProvider struct {
	Kind     string `yaml:"kind"`               // "transcriber-service" | "deepgram"
	Model    string `yaml:"model,omitempty"`    // optional model override
	APIKey   string `yaml:"api_key,omitempty"`  // deepgram (env-substituted)
	Endpoint string `yaml:"endpoint,omitempty"` // transcriber-service
	Language string `yaml:"language,omitempty"` // deepgram; empty = multi
	Diarize  *bool  `yaml:"diarize,omitempty"`  // deepgram; unset follows multi
}

func (t *Transcribe) applyDefaults() {
	if t.Default == "" {
		t.Default = "transcriber-service"
	}
	if t.Providers == nil {
		t.Providers = map[string]TranscribeProvider{}
	}
}
