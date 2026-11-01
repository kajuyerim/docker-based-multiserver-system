package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
	collectortrace "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/proto"
)

func newTracedTestServer(t *testing.T) (*Server, *miniredis.Miniredis, *tracetest.InMemoryExporter) {
	t.Helper()
	srv, primary := newTestServer(t)
	exporter := tracetest.NewInMemoryExporter()
	provider := newRequestTracerProvider(srv.serverID, sdktrace.NewSimpleSpanProcessor(exporter))
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if err := provider.Shutdown(ctx); err != nil {
			t.Errorf("shut down test tracer: %v", err)
		}
	})
	srv.tracerProvider = provider
	if err := instrumentRedisTracing(provider, srv.primary, srv.reader); err != nil {
		t.Fatal(err)
	}
	return srv, primary, exporter
}

func TestTracing_ContinuesW3CParentAndLinksRedis(t *testing.T) {
	srv, _, exporter := newTracedTestServer(t)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
	req.Header.Set("X-Request-Id", "traced-request")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("root status: %d", rec.Code)
	}
	spans := exporter.GetSpans()
	if len(spans) != 2 {
		t.Fatalf("exported spans: got %d, want one server and one Redis client; %v", len(spans), spans)
	}
	server := spanByKind(t, spans, trace.SpanKindServer)
	client := spanByKind(t, spans, trace.SpanKindClient)
	if server.SpanContext.TraceID().String() != "4bf92f3577b34da6a3ce929d0e0e4736" || server.Parent.SpanID().String() != "00f067aa0ba902b7" || !server.Parent.IsRemote() {
		t.Errorf("incoming parent was not continued: trace %s, parent %v", server.SpanContext.TraceID(), server.Parent)
	}
	if client.SpanContext.TraceID() != server.SpanContext.TraceID() || client.Parent.SpanID() != server.SpanContext.SpanID() {
		t.Error("Redis client span is not the direct child of the HTTP server span")
	}
	if server.Name != "GET /" || client.Name != "incr" {
		t.Errorf("span names: server %q, client %q", server.Name, client.Name)
	}
	for _, span := range spans {
		if got := spanAttribute(span.Attributes, "request.id"); got != "traced-request" {
			t.Errorf("%s request.id: got %q", span.Name, got)
		}
	}
	if got := spanAttribute(server.Attributes, "http.route"); got != "/" {
		t.Errorf("server route: got %q", got)
	}
}

func TestTracing_InvalidParentsStartNewTrace(t *testing.T) {
	for _, parent := range []string{
		"not-a-traceparent",
		"00-00000000000000000000000000000000-00f067aa0ba902b7-01",
		"00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
		"ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
		"00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01",
	} {
		t.Run(parent, func(t *testing.T) {
			srv, _, exporter := newTracedTestServer(t)
			req := httptest.NewRequest(http.MethodGet, "/slow?seconds=0", nil)
			req.Header.Set("Traceparent", parent)
			srv.Handler().ServeHTTP(httptest.NewRecorder(), req)
			spans := exporter.GetSpans()
			if len(spans) != 1 || spans[0].Parent.IsValid() || !spans[0].SpanContext.IsValid() {
				t.Fatalf("invalid incoming context did not create a new root: %v", spans)
			}
		})
	}
}

func TestTracing_RespectsUnsampledParent(t *testing.T) {
	srv, primary, exporter := newTracedTestServer(t)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || len(exporter.GetSpans()) != 0 {
		t.Fatalf("unsampled request status %d, exported %d spans", rec.Code, len(exporter.GetSpans()))
	}
	if count, err := primary.Get("global_count"); err != nil || count != "1" {
		t.Errorf("unsampled request changed handler behavior: %q, %v", count, err)
	}
}

func TestTracing_DoesNotExportQueryOrCredentials(t *testing.T) {
	srv, _, exporter := newTracedTestServer(t)
	const key, value, token = "private-trace-key", "private-trace-value", "private-auth-token"
	handler := srv.HandlerWithAuth(token)
	for _, path := range []string{"/store?key=" + key + "&value=" + value, "/get?key=" + key} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s status: %d", path, rec.Code)
		}
	}
	spans := exporter.GetSpans()
	if len(spans) != 4 {
		t.Fatalf("got %d spans, want server+Redis for both store/get", len(spans))
	}
	for _, span := range spans {
		recorded := span.Name + fmt.Sprint(span.Attributes, span.Events)
		for _, secret := range []string{key, value, token} {
			if strings.Contains(recorded, secret) {
				t.Errorf("%s span leaked %q", span.Name, secret)
			}
		}
		for _, forbidden := range []string{"db.statement", "url.query", "url.full", "http.target", "http.request.header.authorization"} {
			if spanAttribute(span.Attributes, forbidden) != "" {
				t.Errorf("%s span contains sensitive attribute %s", span.Name, forbidden)
			}
		}
	}
}

func TestTracing_ExcludesMonitoringAndBackgroundRedis(t *testing.T) {
	srv, _, exporter := newTracedTestServer(t)
	if err := srv.primary.Ping(context.Background()).Err(); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/health", "/metrics", "/metrics"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("Traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s status: %d", path, rec.Code)
		}
	}
	if spans := exporter.GetSpans(); len(spans) != 0 {
		t.Errorf("monitoring or background work exported spans: %v", spans)
	}
}

func TestTracing_GeneratedRequestIDAndReplicaResource(t *testing.T) {
	srv, _, exporter := newTracedTestServer(t)
	rec := do(t, srv, http.MethodGet, "/get?key=missing")
	id := rec.Header().Get("X-Request-Id")
	if rec.Code != http.StatusOK || id == "" {
		t.Fatalf("response: status %d, request ID %q", rec.Code, id)
	}
	for _, span := range exporter.GetSpans() {
		if got := spanAttribute(span.Attributes, "request.id"); got != id {
			t.Errorf("%s request.id: got %q, want generated ID %q", span.Name, got, id)
		}
		if got := spanAttribute(span.Resource.Attributes(), "service.name"); got != "multiserver-backend" {
			t.Errorf("service.name: got %q", got)
		}
		if got := spanAttribute(span.Resource.Attributes(), "service.instance.id"); got != "app1" {
			t.Errorf("service.instance.id: got %q", got)
		}
	}
}

func TestTracing_DisabledAndInvalidConfiguration(t *testing.T) {
	setup, err := newTracing(context.Background(), "app1", "")
	if err != nil || setup.provider == nil || setup.shutdown(context.Background()) != nil {
		t.Fatalf("disabled tracing: setup %+v, err %v", setup, err)
	}
	for _, endpoint := range []string{"jaeger:4318", "file:///tmp/traces", "http://secret@jaeger:4318", "http://jaeger:4318?token=secret", "http://jaeger:4318#fragment"} {
		if _, err := newTracing(context.Background(), "app1", endpoint); err == nil {
			t.Errorf("accepted invalid OTLP HTTP endpoint %q", endpoint)
		}
	}
}

func TestTracing_ExportsOTLPHTTPAndFlushes(t *testing.T) {
	received := make(chan *collectortrace.ExportTraceServiceRequest, 1)
	errors := make(chan error, 1)
	collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/traces" || r.Header.Get("Content-Type") != "application/x-protobuf" {
			errors <- fmt.Errorf("unexpected OTLP request: %s %s %v", r.Method, r.URL.Path, r.Header)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		body, err := io.ReadAll(r.Body)
		message := new(collectortrace.ExportTraceServiceRequest)
		if err == nil {
			err = proto.Unmarshal(body, message)
		}
		if err != nil {
			errors <- err
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		received <- message
		w.Header().Set("Content-Type", "application/x-protobuf")
	}))
	defer collector.Close()
	setup, err := newTracing(context.Background(), "app1", collector.URL)
	if err != nil {
		t.Fatal(err)
	}
	srv, _ := newTestServer(t)
	srv.tracerProvider = setup.provider
	if err := instrumentRedisTracing(setup.provider, srv.primary, srv.reader); err != nil {
		t.Fatal(err)
	}
	if rec := do(t, srv, http.MethodGet, "/"); rec.Code != http.StatusOK {
		t.Fatalf("root status: %d", rec.Code)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := setup.shutdown(ctx); err != nil {
		t.Fatalf("flush and shut down OTLP exporter: %v", err)
	}
	select {
	case err := <-errors:
		t.Fatal(err)
	case message := <-received:
		spans := make(map[string]*tracepb.Span)
		for _, resource := range message.GetResourceSpans() {
			for _, scope := range resource.GetScopeSpans() {
				for _, span := range scope.GetSpans() {
					spans[span.GetName()] = span
				}
			}
		}
		if len(spans) != 2 || spans["GET /"] == nil || spans["incr"] == nil {
			t.Fatalf("OTLP payload missing expected spans: %v", spans)
		}
		if string(spans["incr"].GetParentSpanId()) != string(spans["GET /"].GetSpanId()) {
			t.Error("exported OTLP Redis span lost its server parent")
		}
	default:
		t.Fatal("shutdown returned without exporting the completed spans")
	}
}

func TestTracing_ShutdownIsBoundedDuringCollectorFailure(t *testing.T) {
	collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer collector.Close()
	setup, err := newTracing(context.Background(), "app1", collector.URL)
	if err != nil {
		t.Fatal(err)
	}
	srv, _ := newTestServer(t)
	srv.tracerProvider = setup.provider
	do(t, srv, http.MethodGet, "/slow?seconds=0")
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	started := time.Now()
	if err := setup.shutdown(ctx); err == nil {
		t.Error("collector failure did not surface during bounded shutdown")
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Errorf("tracing shutdown ignored its deadline: %v", elapsed)
	}
}

func spanByKind(t *testing.T, spans tracetest.SpanStubs, kind trace.SpanKind) tracetest.SpanStub {
	t.Helper()
	for _, span := range spans {
		if span.SpanKind == kind {
			return span
		}
	}
	t.Fatalf("no span with kind %s", kind)
	return tracetest.SpanStub{}
}

func spanAttribute(attributes []attribute.KeyValue, key string) string {
	for _, attr := range attributes {
		if string(attr.Key) == key {
			return attr.Value.AsString()
		}
	}
	return ""
}
