package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
)

// Server holds per-replica state and exposes the backend HTTP handlers.
type Server struct {
	serverID string
	rdb      *redis.Client
	localCnt atomic.Int64
	logger   *slog.Logger
	sleep    func(time.Duration)
}

// NewServer constructs a Server with the given replica id and Redis client.
func NewServer(serverID string, rdb *redis.Client) *Server {
	return &Server{
		serverID: serverID,
		rdb:      rdb,
		logger:   slog.Default(),
		sleep:    time.Sleep,
	}
}

// Handler returns the root http.Handler with response-header middleware applied.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/store", s.handleStore)
	mux.HandleFunc("/get", s.handleGet)
	mux.HandleFunc("/slow", s.handleSlow)
	mux.HandleFunc("/", s.handleRoot)
	return s.withResponseHeaders(mux)
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
	global, err := s.rdb.Incr(r.Context(), "global_count").Result()
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
	if err := s.rdb.Set(r.Context(), key, value, 0).Err(); err != nil {
		s.logger.Error("redis SET failed", "key", key, "err", err)
		s.writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "redis set failed"})
		return
	}
	s.writeJSON(w, http.StatusOK, storeResponse{
		ServerID: s.serverID,
		Key:      key,
		Value:    value,
	})
}

func (s *Server) handleGet(w http.ResponseWriter, r *http.Request) {
	key := r.URL.Query().Get("key")
	if key == "" {
		s.writeJSON(w, http.StatusBadRequest, errorResponse{Error: "key is required"})
		return
	}

	val, err := s.rdb.Get(r.Context(), key).Result()
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
	ServerID string `json:"server_id"`
	Key      string `json:"key"`
	Value    string `json:"value"`
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
