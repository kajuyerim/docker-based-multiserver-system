package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	dto "github.com/prometheus/client_model/go"
	"github.com/redis/go-redis/v9"
)

func TestMetrics_CountsStatusesAndDurationsWithBoundedRoutes(t *testing.T) {
	srv, _ := newTestServer(t)
	handler := srv.HandlerWithAuth("test-token")
	requests := []struct {
		target, token, route, status string
	}{
		{"/", "test-token", "/", "200"},
		{"/get?key=", "test-token", "/get", "400"},
		{"/missing/private-value?token=secret", "test-token", "unmatched", "404"},
		{"/health", "", "/health", "401"},
		{"/get?key=unavailable", "test-token", "/get", "500"},
	}
	for _, request := range requests {
		if request.status == "500" {
			if err := srv.reader.Close(); err != nil {
				t.Fatal(err)
			}
		}
		req := httptest.NewRequest(http.MethodGet, request.target, nil)
		if request.token != "" {
			req.Header.Set("Authorization", "Bearer "+request.token)
		}
		handler.ServeHTTP(httptest.NewRecorder(), req)
	}
	families := gatherMetrics(t, srv)
	for _, request := range requests {
		labels := map[string]string{"route": request.route, "status": request.status, "server_id": "app1"}
		counter := findMetric(t, families["multiserver_http_requests_total"], labels)
		if got := counter.GetCounter().GetValue(); got != 1 {
			t.Errorf("%v request count: got %v, want 1", labels, got)
		}
		histogram := findMetric(t, families["multiserver_http_request_duration_seconds"], labels).GetHistogram()
		if histogram.GetSampleCount() != 1 || histogram.GetSampleSum() <= 0 || len(histogram.GetBucket()) == 0 {
			t.Errorf("%v duration: got %v, want one positive observation with buckets", labels, histogram)
		}
	}
	for _, family := range families {
		for _, metric := range family.GetMetric() {
			for _, label := range metric.GetLabel() {
				if strings.Contains(label.GetValue(), "private-value") || strings.Contains(label.GetValue(), "secret") {
					t.Errorf("request data leaked into a metric label: %v", label)
				}
			}
		}
	}
}

func TestMetrics_ProtectedFormatAndNoCounterMutation(t *testing.T) {
	srv, primary := newTestServer(t)
	handler := srv.HandlerWithAuth("test-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized metrics: got %d, want 401", rec.Code)
	}
	assertCommonHeaders(t, rec, "app1")
	if rec.Header().Get("WWW-Authenticate") != "Bearer" {
		t.Error("metrics authentication challenge missing")
	}
	if primary.CommandCount() != 0 {
		t.Error("unauthorized metrics request reached Redis")
	}
	for range 2 {
		req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
		req.Header.Set("Authorization", "Bearer test-token")
		rec = httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/plain;") {
			t.Fatalf("metrics response: status %d, type %q", rec.Code, rec.Header().Get("Content-Type"))
		}
		if rec.Header().Get("X-Server-Id") != "app1" || rec.Header().Get("X-Request-Id") == "" || !strings.Contains(rec.Body.String(), "# HELP multiserver_local_count") {
			t.Fatalf("metrics headers or exposition missing: %v", rec.Header())
		}
		if !strings.Contains(rec.Body.String(), `multiserver_in_flight_requests{server_id="app1"} 1`) {
			t.Error("idle scrape did not count itself as the single in-flight request")
		}
	}
	if primary.Exists("global_count") || srv.localCnt.Load() != 0 {
		t.Error("metrics scraping changed the business counters")
	}
	families := gatherMetrics(t, srv)
	metric := findMetric(t, families["multiserver_http_requests_total"], map[string]string{"route": "/metrics", "status": "200", "server_id": "app1"})
	if got := metric.GetCounter().GetValue(); got != 2 {
		t.Errorf("completed scrape count: got %v, want 2", got)
	}
}

func TestMetrics_AtomicGaugesAndPrimaryCounter(t *testing.T) {
	srv, primary, reader := newSplitTestServer(t)
	primary.Set("global_count", "41")
	reader.Set("global_count", "999")
	if rec := do(t, srv, http.MethodGet, "/"); rec.Code != http.StatusOK {
		t.Fatalf("root status: %d", rec.Code)
	}
	families := gatherMetrics(t, srv)
	assertGauge(t, families, "multiserver_local_count", 1)
	assertGauge(t, families, "multiserver_global_count", 42)
	assertGauge(t, families, "multiserver_global_count_scrape_success", 1)
	assertGauge(t, families, "multiserver_in_flight_requests", 0)
	primary.Set("global_count", "50")
	assertGauge(t, gatherMetrics(t, srv), "multiserver_global_count", 50)
	if count, err := primary.Get("global_count"); err != nil || count != "50" {
		t.Errorf("scrape changed an existing primary counter: got %q, err %v", count, err)
	}
}

func TestMetrics_ConcurrentScrapesAndCounters(t *testing.T) {
	srv, primary := newTestServer(t)
	handler := srv.Handler()
	const requests = 40
	start := make(chan struct{})
	errors := make(chan error, requests*2)
	var wg sync.WaitGroup
	for range requests {
		for _, path := range []string{"/", "/metrics"} {
			wg.Go(func() {
				<-start
				rec := httptest.NewRecorder()
				handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
				if rec.Code != http.StatusOK {
					errors <- fmt.Errorf("%s status: got %d, want 200", path, rec.Code)
				}
			})
		}
	}
	close(start)
	wg.Wait()
	close(errors)
	for err := range errors {
		t.Error(err)
	}
	if count, err := primary.Get("global_count"); err != nil || count != "40" || srv.localCnt.Load() != requests {
		t.Errorf("mixed traffic counters: global %q, local %d, err %v", count, srv.localCnt.Load(), err)
	}
	families := gatherMetrics(t, srv)
	for _, route := range []string{"/", "/metrics"} {
		metric := findMetric(t, families["multiserver_http_requests_total"], map[string]string{"route": route, "status": "200", "server_id": "app1"})
		if got := metric.GetCounter().GetValue(); got != requests {
			t.Errorf("%s request count: got %v, want %d", route, got, requests)
		}
	}
}

func TestMetrics_InFlightIncludesScrape(t *testing.T) {
	srv, _ := newTestServer(t)
	started := make(chan struct{})
	release := make(chan struct{})
	done := make(chan struct{})
	srv.sleep = func(time.Duration) {
		close(started)
		<-release
	}
	go func() {
		srv.Handler().ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/slow?seconds=10", nil))
		close(done)
	}()
	defer func() { close(release); <-done }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("slow request did not enter the handler")
	}
	assertGauge(t, gatherMetrics(t, srv), "multiserver_in_flight_requests", 1)
	rec := do(t, srv, http.MethodGet, "/metrics")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `multiserver_in_flight_requests{server_id="app1"} 2`) {
		t.Fatalf("scrape did not include both active requests: %s", rec.Body.String())
	}
}

func TestMetrics_GlobalCounterZeroAndFailures(t *testing.T) {
	for _, scenario := range []string{"missing", "invalid", "unavailable"} {
		t.Run(scenario, func(t *testing.T) {
			srv, primary := newTestServer(t)
			switch scenario {
			case "invalid":
				primary.Set("global_count", "not-a-number")
			case "unavailable":
				if err := srv.primary.Close(); err != nil {
					t.Fatal(err)
				}
			}
			families := gatherMetrics(t, srv)
			if scenario == "missing" {
				assertGauge(t, families, "multiserver_global_count", 0)
				assertGauge(t, families, "multiserver_global_count_scrape_success", 1)
			} else {
				assertGauge(t, families, "multiserver_global_count_scrape_success", 0)
				if _, exists := families["multiserver_global_count"]; exists {
					t.Error("failed Redis collection emitted a misleading counter value")
				}
			}
			if rec := do(t, srv, http.MethodGet, "/metrics"); rec.Code != http.StatusOK {
				t.Fatalf("metrics lost process metrics during Redis failure: status %d", rec.Code)
			}
		})
	}
}

func TestMetrics_GlobalCounterReadHasBoundedDeadline(t *testing.T) {
	srv, _ := newTestServer(t)
	observed := make(chan time.Duration, 1)
	srv.primary.AddHook(metricsTimeoutHook{observed: observed})
	started := time.Now()
	families := gatherMetrics(t, srv)
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Errorf("collector took %v, want its 500ms deadline to bound the read", elapsed)
	}
	select {
	case remaining := <-observed:
		if remaining <= 0 || remaining > 500*time.Millisecond {
			t.Errorf("collector deadline remaining: %v, want 0 < remaining <= 500ms", remaining)
		}
	default:
		t.Fatal("collector did not read Redis with a bounded context")
	}
	assertGauge(t, families, "multiserver_global_count_scrape_success", 0)
	if _, exists := families["multiserver_global_count"]; exists {
		t.Error("timed-out collection emitted a counter value")
	}
}

func TestMetrics_RegistriesAreIndependent(t *testing.T) {
	first, _ := newTestServer(t)
	second, _ := newTestServer(t)
	if rec := do(t, first, http.MethodGet, "/"); rec.Code != http.StatusOK {
		t.Fatalf("root status: %d", rec.Code)
	}
	assertGauge(t, gatherMetrics(t, first), "multiserver_local_count", 1)
	assertGauge(t, gatherMetrics(t, second), "multiserver_local_count", 0)
	if _, exists := gatherMetrics(t, second)["multiserver_http_requests_total"]; exists {
		t.Error("one server's request metrics leaked into another registry")
	}
}

func gatherMetrics(t *testing.T, srv *Server) map[string]*dto.MetricFamily {
	t.Helper()
	families, err := srv.metrics.registry.Gather()
	if err != nil {
		t.Fatalf("gather metrics: %v", err)
	}
	result := make(map[string]*dto.MetricFamily, len(families))
	for _, family := range families {
		result[family.GetName()] = family
	}
	return result
}

func findMetric(t *testing.T, family *dto.MetricFamily, labels map[string]string) *dto.Metric {
	t.Helper()
	for _, metric := range family.GetMetric() {
		if len(metric.GetLabel()) != len(labels) {
			continue
		}
		matches := true
		for _, label := range metric.GetLabel() {
			if labels[label.GetName()] != label.GetValue() {
				matches = false
				break
			}
		}
		if matches {
			return metric
		}
	}
	t.Fatalf("metric family %s has no sample with labels %v", family.GetName(), labels)
	return nil
}

func assertGauge(t *testing.T, families map[string]*dto.MetricFamily, name string, want float64) {
	t.Helper()
	metric := findMetric(t, families[name], map[string]string{"server_id": "app1"})
	if got := metric.GetGauge().GetValue(); got != want {
		t.Errorf("%s: got %v, want %v", name, got, want)
	}
}

type metricsTimeoutHook struct {
	observed chan<- time.Duration
}

func (h metricsTimeoutHook) DialHook(next redis.DialHook) redis.DialHook { return next }

func (h metricsTimeoutHook) ProcessHook(next redis.ProcessHook) redis.ProcessHook {
	return func(ctx context.Context, cmd redis.Cmder) error {
		if cmd.Name() != "get" {
			return next(ctx, cmd)
		}
		deadline, _ := ctx.Deadline()
		h.observed <- time.Until(deadline)
		<-ctx.Done()
		return ctx.Err()
	}
}

func (h metricsTimeoutHook) ProcessPipelineHook(next redis.ProcessPipelineHook) redis.ProcessPipelineHook {
	return next
}
