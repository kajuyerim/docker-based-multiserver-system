package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
)

// Server holds per-replica state and exposes the backend HTTP handlers.
type Server struct {
	serverID string
	primary  *redis.Client
	reader   *redis.Client
	localCnt atomic.Int64
	inFlight atomic.Int64
	logger   *slog.Logger
	sleep    func(time.Duration)
	metrics  *serverMetrics
}

// NewServer constructs a Server; a nil reader uses the primary for reads.
func NewServer(serverID string, primary, reader *redis.Client) *Server {
	if reader == nil {
		reader = primary
	}
	s := &Server{
		serverID: serverID,
		primary:  primary,
		reader:   reader,
		logger:   slog.Default(),
		sleep:    time.Sleep,
	}
	s.metrics = newServerMetrics(s)
	return s
}

// Handler returns the root http.Handler with the middleware chain applied.
func (s *Server) Handler() http.Handler {
	return s.HandlerWithAuth("")
}

// HandlerWithAuth requires a bearer token on every request when token is nonempty.
func (s *Server) HandlerWithAuth(token string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/store", s.handleStore)
	mux.HandleFunc("/get", s.handleGet)
	mux.HandleFunc("/slow", s.handleSlow)
	mux.Handle("/metrics", s.metrics.handler)
	mux.HandleFunc("/", s.handleRoot)
	return chain(mux, s.withInFlight, s.withResponseHeaders, s.withMetrics, s.withAuth(token))
}

func (s *Server) withAuth(token string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		if token == "" {
			return next
		}
		expected := []byte(token)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			headers := r.Header.Values("Authorization")
			scheme, credential, separated := strings.Cut(r.Header.Get("Authorization"), " ")
			credential = strings.TrimLeft(credential, " ")
			if len(headers) != 1 || !separated || !strings.EqualFold(scheme, "Bearer") || subtle.ConstantTimeCompare([]byte(credential), expected) != 1 {
				w.Header().Set("WWW-Authenticate", "Bearer")
				s.writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "unauthorized"})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// InFlight reports the number of requests currently being served.
func (s *Server) InFlight() int64 {
	return s.inFlight.Load()
}

// chain wraps h in the given middleware; the first middleware is outermost
// (runs first on the way in, last on the way out).
func chain(h http.Handler, mw ...func(http.Handler) http.Handler) http.Handler {
	for i := len(mw) - 1; i >= 0; i-- {
		h = mw[i](h)
	}
	return h
}

func (s *Server) withInFlight(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.inFlight.Add(1)
		defer s.inFlight.Add(-1)
		next.ServeHTTP(w, r)
	})
}

func (s *Server) withResponseHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestID := r.Header.Get("X-Request-Id")
		if requestID == "" {
			requestID = newRequestID()
			r.Header.Set("X-Request-Id", requestID)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Server-Id", s.serverID)
		w.Header().Set("X-Request-Id", requestID)

		s.logger.Info("request",
			"request_id", requestID,
			"server_id", s.serverID,
			"method", r.Method,
			"path", r.URL.Path,
		)

		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	s.writeJSON(w, http.StatusOK, healthResponse{
		Status:   "ok",
		ServerID: s.serverID,
	})
}

func (s *Server) handleRoot(w http.ResponseWriter, r *http.Request) {
	// ServeMux funnels every unrouted path to "/"; only the exact root counts.
	if r.URL.Path != "/" {
		s.writeJSON(w, http.StatusNotFound, errorResponse{Error: "not found"})
		return
	}

	local := s.localCnt.Add(1)
	global, err := s.primary.Incr(r.Context(), "global_count").Result()
	if err != nil {
		s.logger.Error("redis INCR failed", "err", err)
		s.writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "redis incr failed"})
		return
	}

	s.writeJSON(w, http.StatusOK, rootResponse{
		ServerID:    s.serverID,
		LocalCount:  local,
		GlobalCount: global,
	})
}

func (s *Server) handleStore(w http.ResponseWriter, r *http.Request) {
	key := r.URL.Query().Get("key")
	value := r.URL.Query().Get("value")
	if key == "" || value == "" {
		s.writeJSON(w, http.StatusBadRequest, errorResponse{Error: "key and value are required"})
		return
	}
	if err := s.primary.Set(r.Context(), key, value, 0).Err(); err != nil {
		s.logger.Error("redis SET failed", "key", key, "err", err)
		s.writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "redis set failed"})
		return
	}
	s.writeJSON(w, http.StatusOK, storeResponse{
		Stored:   true,
		Key:      key,
		Value:    value,
		ServerID: s.serverID,
	})
}

func (s *Server) handleGet(w http.ResponseWriter, r *http.Request) {
	key := r.URL.Query().Get("key")
	if key == "" {
		s.writeJSON(w, http.StatusBadRequest, errorResponse{Error: "key is required"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	val, err := s.reader.Get(ctx, key).Result()
	switch {
	case errors.Is(err, redis.Nil):
		s.writeJSON(w, http.StatusOK, getResponse{
			ServerID: s.serverID,
			Key:      key,
			Value:    nil,
		})
	case err != nil:
		s.logger.Error("redis GET failed", "key", key, "err", err)
		s.writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "redis get failed"})
	default:
		v := val
		s.writeJSON(w, http.StatusOK, getResponse{
			ServerID: s.serverID,
			Key:      key,
			Value:    &v,
		})
	}
}

func (s *Server) handleSlow(w http.ResponseWriter, r *http.Request) {
	secondsStr := r.URL.Query().Get("seconds")
	if secondsStr == "" {
		s.writeJSON(w, http.StatusBadRequest, errorResponse{Error: "seconds is required"})
		return
	}
	requested, err := strconv.Atoi(secondsStr)
	if err != nil {
		s.writeJSON(w, http.StatusBadRequest, errorResponse{Error: "seconds must be an integer"})
		return
	}
	seconds := clampSlowSeconds(requested)
	s.sleep(time.Duration(seconds) * time.Second)
	s.writeJSON(w, http.StatusOK, slowResponse{
		ServerID: s.serverID,
		Slept:    seconds,
	})
}

func (s *Server) writeJSON(w http.ResponseWriter, status int, body any) {
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// clampSlowSeconds keeps the request's seconds parameter inside [0, 10] per spec.
func clampSlowSeconds(s int) int {
	if s < 0 {
		return 0
	}
	if s > 10 {
		return 10
	}
	return s
}

func newRequestID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// --- response types (explicit structs guarantee deterministic JSON key order) ---

type healthResponse struct {
	Status   string `json:"status"`
	ServerID string `json:"server_id"`
}

type rootResponse struct {
	ServerID    string `json:"server_id"`
	LocalCount  int64  `json:"local_count"`
	GlobalCount int64  `json:"global_count"`
}

type storeResponse struct {
	Stored   bool   `json:"stored"`
	Key      string `json:"key"`
	Value    string `json:"value"`
	ServerID string `json:"server_id"`
}

type getResponse struct {
	ServerID string  `json:"server_id"`
	Key      string  `json:"key"`
	Value    *string `json:"value"`
}

type slowResponse struct {
	ServerID string `json:"server_id"`
	Slept    int    `json:"slept"`
}

type errorResponse struct {
	Error string `json:"error"`
}
