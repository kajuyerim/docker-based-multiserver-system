package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHealthEndpoint(t *testing.T) {
	srv := NewServer("app1")

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()

	srv.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200", rec.Code)
	}

	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type: got %q, want application/json", got)
	}

	if got := rec.Header().Get("X-Server-Id"); got != "app1" {
		t.Errorf("X-Server-Id: got %q, want app1", got)
	}

	var body struct {
		Status   string `json:"status"`
		ServerID string `json:"server_id"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode body: %v", err)
	}

	if body.Status != "ok" {
		t.Errorf("status field: got %q, want ok", body.Status)
	}
	if body.ServerID != "app1" {
		t.Errorf("server_id field: got %q, want app1", body.ServerID)
	}
}
