package transcript

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

const (
	speechKitRecognizeURL  = "https://stt.api.cloud.yandex.net/stt/v3/recognizeFileAsync"
	speechKitOperationsURL = "https://operation.api.cloud.yandex.net/operations"
	speechKitPollTimeout   = 5 * time.Minute
	speechKitPollInterval  = 2 * time.Second
)

type speechKit struct {
	apiKey      string
	s3c         *s3.Client
	presigner   *s3.PresignClient
	bucket      string
	scratchPref string
	httpc       *http.Client
}

func newSpeechKit(d Deps) *speechKit {
	return &speechKit{
		apiKey:      d.SpeechKitKey,
		s3c:         d.S3,
		presigner:   d.S3Presigner,
		bucket:      d.Bucket,
		scratchPref: strings.TrimRight(d.ScratchPrefix, "/"),
		httpc: &http.Client{
			Timeout: 5 * time.Minute,
		},
	}
}

type speechKitStartReq struct {
	URI              string `json:"uri"`
	RecognitionModel struct {
		Model       string `json:"model"`
		AudioFormat struct {
			ContainerAudio struct {
				ContainerAudioType string `json:"containerAudioType"`
			} `json:"containerAudio"`
		} `json:"audioFormat"`
		TextNormalization struct {
			TextNormalization string `json:"textNormalization"`
			ProfanityFilter   bool   `json:"profanityFilter"`
			LiteratureText    bool   `json:"literatureText"`
		} `json:"textNormalization"`
		LanguageRestriction struct {
			RestrictionType string   `json:"restrictionType"`
			LanguageCode    []string `json:"languageCode"`
		} `json:"languageRestriction"`
	} `json:"recognitionModel"`
}

type speechKitOpResp struct {
	ID       string          `json:"id"`
	Done     bool            `json:"done"`
	Error    json.RawMessage `json:"error,omitempty"`
	Response json.RawMessage `json:"response,omitempty"`
}

type speechKitChunk struct {
	Alternatives []struct {
		Text  string `json:"text"`
		Words []struct {
			Word      string `json:"word"`
			StartTime string `json:"startTime"`
			EndTime   string `json:"endTime"`
		} `json:"words"`
	} `json:"alternatives"`
}

type speechKitFileResp struct {
	Chunks []speechKitChunk `json:"chunks"`
}

func (sk *speechKit) Transcribe(ctx context.Context, audioPath string, opts Options) (Result, error) {
	body, err := os.ReadFile(audioPath)
	if err != nil {
		return Result{}, fmt.Errorf("read %s: %w", audioPath, err)
	}

	scratchKey := fmt.Sprintf("%s/%s.mp3", sk.scratchPref, randHex16())

	if _, err := sk.s3c.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(sk.bucket),
		Key:         aws.String(scratchKey),
		Body:        bytes.NewReader(body),
		ContentType: aws.String("audio/mpeg"),
	}); err != nil {
		return Result{}, fmt.Errorf("upload scratch: %w", err)
	}
	defer func() {
		// Best-effort cleanup; don't fail the whole transcription on this.
		_, _ = sk.s3c.DeleteObject(context.Background(), &s3.DeleteObjectInput{
			Bucket: aws.String(sk.bucket),
			Key:    aws.String(scratchKey),
		})
	}()

	presign, err := sk.presigner.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(sk.bucket),
		Key:    aws.String(scratchKey),
	}, s3.WithPresignExpires(10*time.Minute))
	if err != nil {
		return Result{}, fmt.Errorf("presign: %w", err)
	}

	var startReq speechKitStartReq
	startReq.URI = presign.URL
	startReq.RecognitionModel.Model = "general"
	startReq.RecognitionModel.AudioFormat.ContainerAudio.ContainerAudioType = "MP3"
	startReq.RecognitionModel.TextNormalization.TextNormalization = "TEXT_NORMALIZATION_ENABLED"
	startReq.RecognitionModel.LanguageRestriction.RestrictionType = "WHITELIST"
	startReq.RecognitionModel.LanguageRestriction.LanguageCode = []string{toYCLocale(opts.Language)}

	reqBody, _ := json.Marshal(startReq)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, speechKitRecognizeURL, bytes.NewReader(reqBody))
	if err != nil {
		return Result{}, fmt.Errorf("build start request: %w", err)
	}
	req.Header.Set("Authorization", "Api-Key "+sk.apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := sk.httpc.Do(req)
	if err != nil {
		return Result{}, fmt.Errorf("speechkit start: %w", err)
	}
	startBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return Result{}, fmt.Errorf("speechkit start http %d: %s", resp.StatusCode, string(startBody))
	}

	var op speechKitOpResp
	if err := json.Unmarshal(startBody, &op); err != nil {
		return Result{}, fmt.Errorf("decode start response: %w", err)
	}
	if op.ID == "" {
		return Result{}, fmt.Errorf("speechkit: no operation id in response: %s", string(startBody))
	}

	deadline := time.Now().Add(speechKitPollTimeout)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return Result{}, ctx.Err()
		case <-time.After(speechKitPollInterval):
		}
		preq, err := http.NewRequestWithContext(ctx, http.MethodGet, speechKitOperationsURL+"/"+op.ID, nil)
		if err != nil {
			return Result{}, fmt.Errorf("build poll request: %w", err)
		}
		preq.Header.Set("Authorization", "Api-Key "+sk.apiKey)
		presp, err := sk.httpc.Do(preq)
		if err != nil {
			return Result{}, fmt.Errorf("speechkit poll: %w", err)
		}
		pbody, _ := io.ReadAll(io.LimitReader(presp.Body, 16<<20))
		presp.Body.Close()
		if presp.StatusCode/100 != 2 {
			return Result{}, fmt.Errorf("speechkit poll http %d: %s", presp.StatusCode, string(pbody))
		}
		var pop speechKitOpResp
		if err := json.Unmarshal(pbody, &pop); err != nil {
			return Result{}, fmt.Errorf("decode poll response: %w", err)
		}
		if pop.Done {
			if len(pop.Error) > 0 && string(pop.Error) != "null" {
				return Result{}, fmt.Errorf("speechkit error: %s", string(pop.Error))
			}
			return parseSpeechKitFileResp(pop.Response)
		}
	}
	return Result{}, fmt.Errorf("speechkit: operation timed out after %s", speechKitPollTimeout)
}

func parseSpeechKitFileResp(raw json.RawMessage) (Result, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return Result{}, fmt.Errorf("speechkit: empty response")
	}
	var resp speechKitFileResp
	if err := json.Unmarshal(raw, &resp); err != nil {
		return Result{}, fmt.Errorf("decode file response: %w", err)
	}
	var texts []string
	var words []Word
	for _, chunk := range resp.Chunks {
		if len(chunk.Alternatives) == 0 {
			continue
		}
		alt := chunk.Alternatives[0]
		if alt.Text != "" {
			texts = append(texts, alt.Text)
		}
		for _, w := range alt.Words {
			ws := strings.TrimSpace(w.Word)
			if ws == "" {
				continue
			}
			words = append(words, Word{
				Word:  ws,
				Start: parseDurationToSec(w.StartTime),
				End:   parseDurationToSec(w.EndTime),
			})
		}
	}
	return Result{
		Text:  collapseSpaces(strings.Join(texts, " ")),
		Words: words,
	}, nil
}

// parseDurationToSec accepts protobuf duration strings ("12.345s",
// "678ms") as well as plain numbers; returns seconds.
func parseDurationToSec(s string) float64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	if strings.HasSuffix(s, "ms") {
		n, _ := strconv.ParseFloat(strings.TrimSuffix(s, "ms"), 64)
		return n / 1000
	}
	if strings.HasSuffix(s, "s") {
		n, _ := strconv.ParseFloat(strings.TrimSuffix(s, "s"), 64)
		return n
	}
	n, _ := strconv.ParseFloat(s, 64)
	return n
}

func collapseSpaces(s string) string {
	out := strings.Builder{}
	prevSpace := false
	for _, r := range s {
		if r == ' ' || r == '\t' || r == '\n' || r == '\r' {
			if prevSpace {
				continue
			}
			out.WriteByte(' ')
			prevSpace = true
		} else {
			out.WriteRune(r)
			prevSpace = false
		}
	}
	return strings.TrimSpace(out.String())
}

var ycLocale = map[string]string{
	"ru": "ru-RU",
	"en": "en-US",
	"uk": "uk-UA",
	"kk": "kk-KK",
	"tr": "tr-TR",
	"uz": "uz-UZ",
	"de": "de-DE",
}

func toYCLocale(iso string) string {
	if v, ok := ycLocale[strings.ToLower(iso)]; ok {
		return v
	}
	return iso
}

func randHex16() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}
