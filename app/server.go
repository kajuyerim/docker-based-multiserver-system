package main

import (
	"encoding/json"
	"net/http"
)

// Server holds per-replica state and exposes the backend HTTP handlers.
type Server struct {
	serverID string
}

// NewServer constructs a Server with the given replica identifier.
func NewServer(serverID string) *Server {
	return &Server{serverID: serverID}
}

// Handler returns the root http.Handler with response-header middleware applied.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.handleHealth)
	return s.withResponseHeaders(mux)
}

func (s *Server) withResponseHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Server-Id", s.serverID)
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	s.writeJSON(w, http.StatusOK, map[string]any{
		"status":    "ok",
		"server_id": s.serverID,
	})
}

func (s *Server) writeJSON(w http.ResponseWriter, status int, body any) {
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
