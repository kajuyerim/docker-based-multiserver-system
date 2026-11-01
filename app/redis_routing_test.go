package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func newSplitTestServer(t *testing.T) (*Server, *miniredis.Miniredis, *miniredis.Miniredis) {
	t.Helper()
	srv, primary := newTestServer(t)
	reader := miniredis.RunT(t)
	readerClient := redis.NewClient(&redis.Options{Addr: reader.Addr(), ContextTimeoutEnabled: true})
	t.Cleanup(func() { _ = readerClient.Close() })
	return NewServer("app1", srv.primary, readerClient), primary, reader
}

func TestGet_UsesReader(t *testing.T) {
	srv, primary, reader := newSplitTestServer(t)
	primary.Set("route", "primary-value")
	reader.Set("route", "reader-value")

	rec := do(t, srv, http.MethodGet, "/get?key=route")
	if rec.Code != http.StatusOK {
		t.Fatalf("status: %d, want 200", rec.Code)
	}
	assertCommonHeaders(t, rec, "app1")
	var body getResponse
	decode(t, rec, &body)
	if body.Key != "route" || body.Value == nil || *body.Value != "reader-value" {
		t.Fatalf("get body: %+v, want reader-value", body)
	}
}

func TestWrites_UseOnlyPrimary(t *testing.T) {
	srv, primary, reader := newSplitTestServer(t)
	reader.Set("global_count", "50")

	for _, path := range []string{"/store?key=route&value=stored", "/"} {
		if rec := do(t, srv, http.MethodGet, path); rec.Code != http.StatusOK {
			t.Fatalf("%s status: %d, want 200", path, rec.Code)
		}
	}
	if got, err := primary.Get("route"); err != nil || got != "stored" {
		t.Errorf("primary value: %q, %v; want stored", got, err)
	}
	if reader.Exists("route") {
		t.Error("store wrote to the reader")
	}
	if got, err := primary.Get("global_count"); err != nil || got != "1" {
		t.Errorf("primary counter: %q, %v; want 1", got, err)
	}
	if got, err := reader.Get("global_count"); err != nil || got != "50" {
		t.Errorf("reader counter: %q, %v; want unchanged 50", got, err)
	}
}

func TestGet_MissingReaderKeyDoesNotFallBack(t *testing.T) {
	srv, primary, _ := newSplitTestServer(t)
	primary.Set("pending", "primary-only")

	rec := do(t, srv, http.MethodGet, "/get?key=pending")
	if rec.Code != http.StatusOK {
		t.Fatalf("status: %d, want 200", rec.Code)
	}
	var body getResponse
	decode(t, rec, &body)
	if body.Key != "pending" || body.Value != nil {
		t.Fatalf("body: %+v, want null value while reader is behind", body)
	}
}

func TestGet_ReaderFailureDoesNotBlockPrimaryWrites(t *testing.T) {
	srv, primary, _ := newSplitTestServer(t)
	primary.Set("present", "primary-value")
	if err := srv.reader.Close(); err != nil {
		t.Fatal(err)
	}

	rec := do(t, srv, http.MethodGet, "/get?key=present")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("get status: %d, want 500", rec.Code)
	}
	assertCommonHeaders(t, rec, "app1")
	var body errorResponse
	decode(t, rec, &body)
	if body.Error != "redis get failed" {
		t.Errorf("error: %q", body.Error)
	}
	for _, path := range []string{"/store?key=during-outage&value=stored", "/"} {
		if rec := do(t, srv, http.MethodGet, path); rec.Code != http.StatusOK {
			t.Fatalf("%s status: %d, want 200", path, rec.Code)
		}
	}
	if got, err := primary.Get("during-outage"); err != nil || got != "stored" {
		t.Errorf("primary value: %q, %v; want stored", got, err)
	}
	if got, err := primary.Get("global_count"); err != nil || got != "1" {
		t.Errorf("primary counter: %q, %v; want 1", got, err)
	}
}

func TestGet_RespectsRequestCancellation(t *testing.T) {
	srv, _, reader := newSplitTestServer(t)
	reader.Set("present", "reader-value")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	req := httptest.NewRequestWithContext(ctx, http.MethodGet, "/get?key=present", nil)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status: %d, want 500 for canceled request", rec.Code)
	}
	var body errorResponse
	decode(t, rec, &body)
	if body.Error != "redis get failed" {
		t.Errorf("error: %q", body.Error)
	}
}

func TestGet_BoundsReadDeadline(t *testing.T) {
	for _, parentTimeout := range []time.Duration{0, time.Second} {
		t.Run(parentTimeout.String(), func(t *testing.T) {
			srv, _, _ := newSplitTestServer(t)
			ctx := context.Background()
			if parentTimeout != 0 {
				var cancel context.CancelFunc
				ctx, cancel = context.WithTimeout(ctx, parentTimeout)
				defer cancel()
			}
			observed := false
			srv.reader.AddHook(readDeadlineHook{check: func(ctx context.Context) {
				observed = true
				deadline, ok := ctx.Deadline()
				if !ok {
					t.Fatal("Redis GET context has no deadline")
				}
				limit := 2 * time.Second
				if parentTimeout != 0 {
					limit = parentTimeout
				}
				if remaining := time.Until(deadline); remaining <= 0 || remaining > limit {
					t.Errorf("read deadline remaining: %v, want between zero and %v", remaining, limit)
				}
			}})
			req := httptest.NewRequestWithContext(ctx, http.MethodGet, "/get?key=missing", nil)
			rec := httptest.NewRecorder()
			srv.Handler().ServeHTTP(rec, req)
			if !observed || rec.Code != http.StatusOK {
				t.Fatalf("Redis GET observed: %t, status: %d", observed, rec.Code)
			}
		})
	}
}

type readDeadlineHook struct {
	check func(context.Context)
}

func (h readDeadlineHook) DialHook(next redis.DialHook) redis.DialHook { return next }

func (h readDeadlineHook) ProcessHook(next redis.ProcessHook) redis.ProcessHook {
	return func(ctx context.Context, cmd redis.Cmder) error {
		if cmd.Name() == "get" {
			h.check(ctx)
		}
		return next(ctx, cmd)
	}
}

func (h readDeadlineHook) ProcessPipelineHook(next redis.ProcessPipelineHook) redis.ProcessPipelineHook {
	return next
}
