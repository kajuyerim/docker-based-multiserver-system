package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

func TestEventsIntegration(t *testing.T) {
	base := os.Getenv("EVENTS_TEST_URL")
	if base == "" {
		t.Skip("set EVENTS_TEST_URL to the local Compose or kind HTTP origin")
	}
	if base != "http://localhost:8080" && base != "http://localhost:8081" {
		t.Fatal("EVENTS_TEST_URL must be the local Compose or kind HTTP origin")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
	defer cancel()
	headers := http.Header{"Origin": {base}}
	if token := os.Getenv("AUTH_TOKEN"); token != "" {
		headers.Set("Authorization", "Bearer "+token)
		conn, response, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(base, "http")+"/events", nil)
		if conn != nil {
			conn.CloseNow()
		}
		if err == nil || response == nil || response.StatusCode != http.StatusUnauthorized {
			t.Fatalf("unauthenticated WebSocket was not rejected: %v", err)
		}
	}
	conn, response, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(base, "http")+"/events", &websocket.DialOptions{HTTPHeader: headers})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	connectedTo := response.Header.Get("X-Server-Id")
	if connectedTo == "" || response.Header.Get("X-Request-Id") == "" {
		t.Fatal("upgrade lost backend identity headers")
	}
	events := make(chan counterEvent)
	errors := make(chan error, 1)
	go func() {
		for {
			var event counterEvent
			if err := wsjson.Read(ctx, conn, &event); err != nil {
				errors <- err
				return
			}
			select {
			case events <- event:
			case <-ctx.Done():
				return
			}
		}
	}()
	backends := map[string]bool{}
	for i := 0; i < 7; i++ {
		if i == 6 {
			t.Log("Keeping the connection idle for 65 seconds to verify heartbeats through NGINX")
			select {
			case err := <-errors:
				t.Fatalf("idle connection closed: %v", err)
			case <-time.After(65 * time.Second):
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header = headers.Clone()
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		var root rootResponse
		err = json.NewDecoder(response.Body).Decode(&root)
		response.Body.Close()
		if err != nil || response.StatusCode != http.StatusOK {
			t.Fatalf("root status %d, decode: %v", response.StatusCode, err)
		}
		backends[root.ServerID] = true
		select {
		case event := <-events:
			if event.GlobalCount != root.GlobalCount {
				t.Fatalf("event %+v, root %+v", event, root)
			}
			t.Logf("WebSocket on %s received global_count=%d from root served by %s", connectedTo, event.GlobalCount, root.ServerID)
		case err := <-errors:
			t.Fatal(err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	if len(backends) < 3 {
		t.Fatalf("requests reached %d replicas, want at least three", len(backends))
	}
}
