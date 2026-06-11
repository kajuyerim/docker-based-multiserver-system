package main

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func TestMain(m *testing.M) {
	// Silence slog during the test suite so the output stays readable.
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
	os.Exit(m.Run())
}

func newTestServer(t *testing.T) (*Server, *miniredis.Miniredis) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	t.Cleanup(mr.Close)

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })

	srv := NewServer("app1", rdb)
	// No-op sleep so /slow handler tests run instantly.
	srv.sleep = func(time.Duration) {}
	return srv, mr
}

func TestHealth(t *testing.T) {
	srv, _ := newTestServer(t)
	rec := do(t, srv, http.MethodGet, "/health")
	if rec.Code != http.StatusOK {
		t.Fatalf("status: %d", rec.Code)
	}
	assertCommonHeaders(t, rec, "app1")
	var body healthResponse
	decode(t, rec, &body)
	if body.Status != "ok" || body.ServerID != "app1" {
		t.Errorf("body: %+v", body)
	}
}

func TestRoot_IncrementsBothCounters(t *testing.T) {
	srv, _ := newTestServer(t)
	for i := int64(1); i <= 3; i++ {
		rec := do(t, srv, http.MethodGet, "/")
		if rec.Code != http.StatusOK {
			t.Fatalf("call %d status: %d", i, rec.Code)
		}
		var body rootResponse
		decode(t, rec, &body)
		if body.LocalCount != i {
			t.Errorf("call %d local_count: got %d, want %d", i, body.LocalCount, i)
		}
		if body.GlobalCount != i {
			t.Errorf("call %d global_count: got %d, want %d", i, body.GlobalCount, i)
		}
		if body.ServerID != "app1" {
			t.Errorf("server_id: %q", body.ServerID)
		}
	}
}

func TestRoot_NonRootPath_Returns404(t *testing.T) {
	srv, _ := newTestServer(t)
	rec := do(t, srv, http.MethodGet, "/does-not-exist")
	if rec.Code != http.StatusNotFound {
		t.Errorf("status: %d, want 404", rec.Code)
	}
}

func TestStore_AndGet_RoundTrip(t *testing.T) {
	srv, _ := newTestServer(t)

	rec := do(t, srv, http.MethodGet, "/store?key=course&value=distsys")
	if rec.Code != http.StatusOK {
		t.Fatalf("store status: %d", rec.Code)
	}
	var sb storeResponse
	decode(t, rec, &sb)
	if !sb.Stored || sb.Key != "course" || sb.Value != "distsys" || sb.ServerID != "app1" {
		t.Errorf("store body: %+v", sb)
	}

	rec = do(t, srv, http.MethodGet, "/get?key=course")
	if rec.Code != http.StatusOK {
		t.Fatalf("get status: %d", rec.Code)
	}
	var gb getResponse
	decode(t, rec, &gb)
	if gb.Value == nil || *gb.Value != "distsys" {
		t.Errorf("get body: %+v", gb)
	}
}

func TestGet_MissingKey_ReturnsNullValue(t *testing.T) {
	srv, _ := newTestServer(t)
	rec := do(t, srv, http.MethodGet, "/get?key=ghost")
	if rec.Code != http.StatusOK {
		t.Fatalf("status: %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"value":null`) {
		t.Errorf("expected JSON null for missing key; body=%q", rec.Body.String())
	}
}

func TestStore_MissingValue_Returns400(t *testing.T) {
	srv, _ := newTestServer(t)
	rec := do(t, srv, http.MethodGet, "/store?key=onlykey")
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status: %d, want 400", rec.Code)
	}
}

func TestStore_MissingKey_Returns400(t *testing.T) {
	srv, _ := newTestServer(t)
	rec := do(t, srv, http.MethodGet, "/store?value=onlyval")
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status: %d, want 400", rec.Code)
	}
}

func TestGet_MissingKeyParam_Returns400(t *testing.T) {
	srv, _ := newTestServer(t)
	rec := do(t, srv, http.MethodGet, "/get")
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status: %d, want 400", rec.Code)
	}
}

func TestSlow_HappyPath(t *testing.T) {
	srv, _ := newTestServer(t)
	rec := do(t, srv, http.MethodGet, "/slow?seconds=3")
	if rec.Code != http.StatusOK {
		t.Fatalf("status: %d", rec.Code)
	}
	var body slowResponse
	decode(t, rec, &body)
	if body.Slept != 3 {
		t.Errorf("slept: got %d, want 3", body.Slept)
	}
}

func TestSlow_ClampsBeyondTen(t *testing.T) {
	srv, _ := newTestServer(t)
	rec := do(t, srv, http.MethodGet, "/slow?seconds=99")
	if rec.Code != http.StatusOK {
		t.Fatalf("status: %d", rec.Code)
	}
	var body slowResponse
	decode(t, rec, &body)
	if body.Slept != 10 {
		t.Errorf("slept: got %d, want 10 (clamped)", body.Slept)
	}
}

func TestSlow_MissingSeconds_Returns400(t *testing.T) {
	srv, _ := newTestServer(t)
	rec := do(t, srv, http.MethodGet, "/slow")
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status: %d, want 400", rec.Code)
	}
}

func TestSlow_NonNumeric_Returns400(t *testing.T) {
	srv, _ := newTestServer(t)
	rec := do(t, srv, http.MethodGet, "/slow?seconds=banana")
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status: %d, want 400", rec.Code)
	}
}

func TestClampSlowSeconds(t *testing.T) {
	cases := []struct {
		in, want int
	}{
		{-5, 0},
		{0, 0},
		{5, 5},
		{10, 10},
		{11, 10},
		{99, 10},
	}
	for _, c := range cases {
		if got := clampSlowSeconds(c.in); got != c.want {
			t.Errorf("clampSlowSeconds(%d) = %d, want %d", c.in, got, c.want)
		}
	}
}

func TestRequestID_GeneratedWhenAbsent(t *testing.T) {
	srv, _ := newTestServer(t)
	rec := do(t, srv, http.MethodGet, "/health")
	if rec.Header().Get("X-Request-Id") == "" {
		t.Errorf("X-Request-Id missing on response")
	}
}

func TestRequestID_PropagatedFromIncomingHeader(t *testing.T) {
	srv, _ := newTestServer(t)
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.Header.Set("X-Request-Id", "test-12345")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if got := rec.Header().Get("X-Request-Id"); got != "test-12345" {
		t.Errorf("X-Request-Id: got %q, want test-12345", got)
	}
}

// --- helpers ---

func TestInFlight_TracksActiveRequests(t *testing.T) {
	srv, _ := newTestServer(t)

	var during int64
	srv.sleep = func(time.Duration) { during = srv.InFlight() }

	rec := do(t, srv, http.MethodGet, "/slow?seconds=1")
	if rec.Code != http.StatusOK {
		t.Fatalf("status: %d", rec.Code)
	}
	if during != 1 {
		t.Errorf("in-flight during handler: got %d, want 1", during)
	}
	if after := srv.InFlight(); after != 0 {
		t.Errorf("in-flight after response: got %d, want 0", after)
	}
}

func TestChain_FirstMiddlewareIsOutermost(t *testing.T) {
	var order []string
	tag := func(name string) func(http.Handler) http.Handler {
		return func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				order = append(order, name)
				next.ServeHTTP(w, r)
			})
		}
	}
	h := chain(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		order = append(order, "handler")
	}), tag("outer"), tag("inner"))

	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))

	want := []string{"outer", "inner", "handler"}
	for i := range want {
		if i >= len(order) || order[i] != want[i] {
			t.Fatalf("execution order: got %v, want %v", order, want)
		}
	}
}

func do(t *testing.T, srv *Server, method, target string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, nil)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	return rec
}

func assertCommonHeaders(t *testing.T, rec *httptest.ResponseRecorder, sid string) {
	t.Helper()
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type: got %q, want application/json", got)
	}
	if got := rec.Header().Get("X-Server-Id"); got != sid {
		t.Errorf("X-Server-Id: got %q, want %q", got, sid)
	}
}

func decode(t *testing.T, rec *httptest.ResponseRecorder, v any) {
	t.Helper()
	if err := json.NewDecoder(rec.Body).Decode(v); err != nil {
		t.Fatalf("decode: %v", err)
	}
}
