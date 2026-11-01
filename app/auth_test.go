package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestAuth_ProtectsEveryRoute(t *testing.T) {
	routes := []string{"/", "/health", "/store?key=guarded&value=secret", "/get?key=guarded", "/slow?seconds=10", "/does-not-exist"}
	cases := []struct {
		name    string
		headers []string
	}{
		{"missing", nil},
		{"wrong token", []string{"Bearer wrong"}},
		{"missing token", []string{"Bearer "}},
		{"wrong scheme", []string{"Basic test-token"}},
		{"wrong token case", []string{"Bearer TEST-TOKEN"}},
		{"trailing whitespace", []string{"Bearer test-token "}},
		{"tab separator", []string{"Bearer\ttest-token"}},
		{"tab in credential", []string{"Bearer \ttest-token"}},
		{"extra suffix", []string{"Bearer test-token-more"}},
		{"duplicate header", []string{"Bearer test-token", "Bearer wrong"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv, mr := newTestServer(t)
			slept := false
			srv.sleep = func(time.Duration) { slept = true }
			handler := srv.HandlerWithAuth("test-token")
			for _, route := range routes {
				req := httptest.NewRequest(http.MethodGet, route, nil)
				req.Header.Set("X-Request-Id", "auth-test-request")
				for _, value := range tc.headers {
					req.Header.Add("Authorization", value)
				}
				rec := httptest.NewRecorder()
				handler.ServeHTTP(rec, req)
				if rec.Code != http.StatusUnauthorized {
					t.Fatalf("%s status: got %d, want 401", route, rec.Code)
				}
				assertCommonHeaders(t, rec, "app1")
				if got := rec.Header().Get("WWW-Authenticate"); got != "Bearer" {
					t.Errorf("%s challenge: got %q, want Bearer", route, got)
				}
				if got := rec.Header().Get("X-Request-Id"); got != "auth-test-request" {
					t.Errorf("%s request ID: got %q", route, got)
				}
				var body errorResponse
				decode(t, rec, &body)
				if body.Error != "unauthorized" {
					t.Errorf("%s error: got %q", route, body.Error)
				}
			}
			if mr.Exists("guarded") || mr.Exists("global_count") || srv.localCnt.Load() != 0 || slept {
				t.Error("unauthorized requests performed endpoint work")
			}
			if srv.InFlight() != 0 {
				t.Errorf("in-flight after rejected requests: got %d, want 0", srv.InFlight())
			}
		})
	}
}

func TestAuth_ValidTokenPreservesHandlers(t *testing.T) {
	for _, authorization := range []string{"Bearer test-token", "bearer test-token", "bEaReR test-token", "Bearer   test-token"} {
		t.Run(authorization, func(t *testing.T) {
			testValidTokenPreservesHandlers(t, authorization)
		})
	}
}

func testValidTokenPreservesHandlers(t *testing.T, authorization string) {
	t.Helper()
	srv, mr := newTestServer(t)
	handler := srv.HandlerWithAuth("test-token")
	routes := []struct {
		path   string
		status int
	}{
		{"/health", http.StatusOK},
		{"/store?key=guarded&value=allowed", http.StatusOK},
		{"/get?key=guarded", http.StatusOK},
		{"/slow?seconds=0", http.StatusOK},
		{"/get", http.StatusBadRequest},
		{"/does-not-exist", http.StatusNotFound},
		{"/", http.StatusOK},
	}
	for _, route := range routes {
		req := httptest.NewRequest(http.MethodGet, route.path, nil)
		req.Header.Set("Authorization", authorization)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != route.status {
			t.Fatalf("%s status: got %d, want %d", route.path, rec.Code, route.status)
		}
		assertCommonHeaders(t, rec, "app1")
		if rec.Header().Get("WWW-Authenticate") != "" {
			t.Errorf("%s sent an authentication challenge for a valid token", route.path)
		}
	}
	if value, err := mr.Get("guarded"); err != nil || value != "allowed" {
		t.Errorf("stored value: got %q, err %v", value, err)
	}
	if value, err := mr.Get("global_count"); err != nil || value != "1" || srv.localCnt.Load() != 1 {
		t.Errorf("root counter: global %q, local %d, err %v", value, srv.localCnt.Load(), err)
	}
}

func TestAuth_EmptyTokenKeepsEveryRoutePublic(t *testing.T) {
	for _, authorization := range []string{"", "Bearer ignored", "Basic ignored"} {
		t.Run(authorization, func(t *testing.T) {
			srv, _ := newTestServer(t)
			handler := srv.HandlerWithAuth("")
			for _, route := range []string{"/health", "/store?key=public&value=allowed", "/get?key=public", "/slow?seconds=0", "/"} {
				req := httptest.NewRequest(http.MethodGet, route, nil)
				if authorization != "" {
					req.Header.Set("Authorization", authorization)
				}
				rec := httptest.NewRecorder()
				handler.ServeHTTP(rec, req)
				if rec.Code != http.StatusOK {
					t.Fatalf("%s status: got %d, want 200", route, rec.Code)
				}
				assertCommonHeaders(t, rec, "app1")
			}
		})
	}
}
