package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

func TestEventsAcrossReplicasAndShutdown(t *testing.T) {
	subscriber, mr := newTestServer(t)
	publisher := NewServer("app2", subscriber.primary, nil)
	defer publisher.stopEvents()
	httpServer := httptest.NewServer(subscriber.Handler())
	defer httpServer.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	conn, response, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(httpServer.URL, "http")+"/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	if response.Header.Get("X-Server-Id") != "app1" || response.Header.Get("X-Request-Id") == "" {
		t.Fatal("upgrade lost identity headers")
	}
	if mr.Exists("global_count") {
		t.Fatal("subscribing changed the counter")
	}
	for i := int64(1); i <= 3; i++ {
		do(t, publisher, http.MethodGet, "/health")
		rec := do(t, publisher, http.MethodGet, "/")
		if rec.Code != http.StatusOK {
			t.Fatalf("root status: %d", rec.Code)
		}
		var event counterEvent
		if err := wsjson.Read(ctx, conn, &event); err != nil {
			t.Fatal(err)
		}
		if event.GlobalCount != i {
			t.Fatalf("event: %+v, want global_count %d", event, i)
		}
	}
	subscriber.stopEvents()
	if _, _, err := conn.Read(ctx); err == nil {
		t.Fatal("shutdown left WebSocket open")
	}
	for subscriber.InFlight() != 0 && ctx.Err() == nil {
		time.Sleep(time.Millisecond)
	}
	if subscriber.InFlight() != 0 {
		t.Fatal("shutdown did not finish event handler")
	}
	if got := subscriber.primary.PubSubNumSub(ctx, counterChannel).Val()[counterChannel]; got != 0 {
		t.Fatalf("subscription leaked after shutdown: %d", got)
	}
}

func TestEventsAuthenticationAndOrigin(t *testing.T) {
	srv, mr := newTestServer(t)
	httpServer := httptest.NewServer(srv.HandlerWithAuth("test-token"))
	defer httpServer.Close()
	for _, tc := range []struct {
		name, token, origin string
		status              int
	}{
		{"missing token", "", "", 401},
		{"wrong token", "wrong", "", 401},
		{"cross origin", "test-token", "https://other.example", 403},
		{"same origin", "test-token", httpServer.URL, 101},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
			defer cancel()
			headers := http.Header{"Authorization": {"Bearer " + tc.token}}
			if tc.origin != "" {
				headers.Set("Origin", tc.origin)
			}
			conn, response, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(httpServer.URL, "http")+"/events", &websocket.DialOptions{HTTPHeader: headers})
			if response == nil || response.StatusCode != tc.status {
				t.Fatalf("response %v, error %v; want %d", response, err, tc.status)
			}
			if conn != nil {
				conn.CloseNow()
			} else if err == nil {
				t.Fatal("rejected handshake had no error")
			}
		})
	}
	if mr.Exists("global_count") {
		t.Fatal("handshakes changed counter")
	}
}

func TestEventsSubscribeFailure(t *testing.T) {
	srv, mr := newTestServer(t)
	mr.Close()
	rec := do(t, srv, http.MethodGet, "/events")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status: %d", rec.Code)
	}
	assertCommonHeaders(t, rec, "app1")
}

func TestEventsConcurrentCounters(t *testing.T) {
	srv, _ := newTestServer(t)
	httpServer := httptest.NewServer(srv.Handler())
	defer httpServer.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(httpServer.URL, "http")+"/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	var workers sync.WaitGroup
	for range 20 {
		workers.Go(func() {
			recorder := httptest.NewRecorder()
			srv.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/", nil))
			if recorder.Code != http.StatusOK {
				t.Errorf("root status: %d", recorder.Code)
			}
		})
	}
	workers.Wait()
	seen := map[int64]bool{}
	for range 20 {
		var event counterEvent
		if err := wsjson.Read(ctx, conn, &event); err != nil {
			t.Fatal(err)
		}
		if seen[event.GlobalCount] || event.GlobalCount < 1 || event.GlobalCount > 20 {
			t.Fatalf("invalid or duplicate event: %+v", event)
		}
		seen[event.GlobalCount] = true
	}
}

func TestRootOnlyCountsGET(t *testing.T) {
	srv, mr := newTestServer(t)
	for _, method := range []string{http.MethodPost, http.MethodHead, http.MethodPut, http.MethodDelete} {
		rec := do(t, srv, method, "/")
		if rec.Code != http.StatusMethodNotAllowed || rec.Header().Get("Allow") != http.MethodGet {
			t.Fatalf("%s: status %d, Allow %q", method, rec.Code, rec.Header().Get("Allow"))
		}
	}
	if srv.localCnt.Load() != 0 || mr.Exists("global_count") {
		t.Fatal("non-GET request changed counters")
	}
}
