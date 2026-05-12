// Package server implements the HTTP API for transcriber.
package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/akdasa-studios/lectorium/modules/tools/transcriber-service/internal/job"
	"github.com/akdasa-studios/lectorium/modules/tools/transcriber-service/internal/store"
	"github.com/akdasa-studios/lectorium/modules/tools/transcriber-service/internal/worker"
)

// Config wires server dependencies.
type Config struct {
	Addr            string
	AudioDir        string
	TranscriptsDir  string
	DefaultLanguage string
	Workers         int
	MaxUploadBytes  int64
	Store           *store.Store
	Worker          *worker.Worker
	StartedAt       time.Time
}

// Server is the HTTP entrypoint.
type Server struct {
	cfg Config
	mux *http.ServeMux
}

// New builds the HTTP server but does not start listening.
func New(cfg Config) *Server {
	if cfg.MaxUploadBytes == 0 {
		cfg.MaxUploadBytes = 1 << 30 // 1 GB default
	}
	s := &Server{cfg: cfg, mux: http.NewServeMux()}
	s.routes()
	return s
}

// Handler returns the http.Handler. CORS is open (LAN-only by deployment).
func (s *Server) Handler() http.Handler {
	return cors(s.mux)
}

func (s *Server) routes() {
	s.mux.HandleFunc("/healthz", s.handleHealth)
	s.mux.HandleFunc("/jobs", s.handleJobsCollection)
	s.mux.HandleFunc("/jobs/", s.handleJobItem)
}

// --- /healthz ---

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	q, run, done, fail, err := s.cfg.Store.Counts()
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("counts: %v", err))
		return
	}
	writeJSON(w, http.StatusOK, job.HealthResponse{
		Workers:     s.cfg.Workers,
		Queued:      q,
		Running:     run,
		Done:        done,
		Failed:      fail,
		ModelLoaded: s.cfg.Worker.ModelLoaded(),
		UptimeS:     int64(time.Since(s.cfg.StartedAt).Seconds()),
	})
}

// --- POST /jobs and GET /jobs ---

func (s *Server) handleJobsCollection(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		s.createJob(w, r)
	case http.MethodGet:
		s.listJobs(w, r)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) createJob(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, s.cfg.MaxUploadBytes)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("parse multipart: %v", err))
		return
	}

	file, hdr, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "missing file field")
		return
	}
	defer file.Close()

	jobID := uuid.NewString()
	clientName := r.FormValue("filename")
	if clientName == "" && hdr != nil {
		clientName = hdr.Filename
	}
	language := strings.ToLower(strings.TrimSpace(r.FormValue("language")))
	if language == "" {
		language = s.cfg.DefaultLanguage
	}

	// Save MP3 as <id>.mp3 in audio dir.
	audioPath := filepath.Join(s.cfg.AudioDir, jobID+".mp3")
	out, err := os.Create(audioPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("create audio: %v", err))
		return
	}
	if _, err := io.Copy(out, file); err != nil {
		out.Close()
		_ = os.Remove(audioPath)
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("write audio: %v", err))
		return
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(audioPath)
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("close audio: %v", err))
		return
	}

	j := &job.Job{
		JobID:      jobID,
		Filename:   clientName,
		Language:   language,
		Status:     job.StatusQueued,
		UploadedAt: time.Now().UnixMilli(),
	}
	if err := s.cfg.Store.Insert(j); err != nil {
		_ = os.Remove(audioPath)
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("insert: %v", err))
		return
	}

	s.cfg.Worker.Submit(jobID)
	log.Printf("server: queued %s (%s, lang=%s, size=%d)", jobID, clientName, language, hdr.Size)

	writeJSON(w, http.StatusCreated, job.CreateResponse{
		JobID: jobID, Status: job.StatusQueued, Filename: clientName,
	})
}

func (s *Server) listJobs(w http.ResponseWriter, r *http.Request) {
	status := r.URL.Query().Get("status")
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	jobs, err := s.cfg.Store.List(status, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("list: %v", err))
		return
	}
	if jobs == nil {
		jobs = []*job.Job{}
	}
	writeJSON(w, http.StatusOK, jobs)
}

// --- /jobs/{id} and /jobs/{id}/transcript ---

func (s *Server) handleJobItem(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/jobs/")
	parts := strings.SplitN(rest, "/", 2)
	jobID := parts[0]
	if jobID == "" {
		writeError(w, http.StatusBadRequest, "missing job id")
		return
	}
	tail := ""
	if len(parts) == 2 {
		tail = parts[1]
	}

	switch {
	case tail == "" && r.Method == http.MethodGet:
		s.getJob(w, r, jobID)
	case tail == "" && r.Method == http.MethodDelete:
		s.deleteJob(w, r, jobID)
	case tail == "transcript" && r.Method == http.MethodGet:
		s.getTranscript(w, r, jobID)
	default:
		writeError(w, http.StatusNotFound, "not found")
	}
}

func (s *Server) getJob(w http.ResponseWriter, _ *http.Request, jobID string) {
	j, err := s.cfg.Store.Get(jobID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("get: %v", err))
		return
	}
	if j == nil {
		writeError(w, http.StatusNotFound, "job not found")
		return
	}
	writeJSON(w, http.StatusOK, j)
}

func (s *Server) deleteJob(w http.ResponseWriter, _ *http.Request, jobID string) {
	j, err := s.cfg.Store.Get(jobID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("get: %v", err))
		return
	}
	if j == nil {
		writeError(w, http.StatusNotFound, "job not found")
		return
	}
	if j.Status == job.StatusRunning {
		writeError(w, http.StatusConflict, "cannot delete a running job")
		return
	}
	transcriptPath := filepath.Join(s.cfg.TranscriptsDir, jobID+".json")
	audioPath := filepath.Join(s.cfg.AudioDir, jobID+".mp3")
	for _, p := range []string{transcriptPath, audioPath} {
		if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
			log.Printf("server: remove %s: %v", p, err)
		}
	}
	if err := s.cfg.Store.Delete(jobID); err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("delete: %v", err))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) getTranscript(w http.ResponseWriter, _ *http.Request, jobID string) {
	j, err := s.cfg.Store.Get(jobID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("get: %v", err))
		return
	}
	if j == nil {
		writeError(w, http.StatusNotFound, "job not found")
		return
	}
	if j.Status != job.StatusDone {
		writeError(w, http.StatusConflict, fmt.Sprintf("transcript not ready (status=%s)", j.Status))
		return
	}
	transcriptPath := filepath.Join(s.cfg.TranscriptsDir, jobID+".json")
	f, err := os.Open(transcriptPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("open transcript: %v", err))
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, f)
}

// --- helpers ---

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
