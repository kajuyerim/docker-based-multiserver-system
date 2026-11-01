package main

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/redis/go-redis/extra/redisotel/v9"
	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
	"go.opentelemetry.io/otel/trace/noop"
)

type requestIDContextKey struct{}

type tracingSetup struct {
	provider trace.TracerProvider
	shutdown func(context.Context) error
}

func newTracing(ctx context.Context, serverID, endpoint string) (tracingSetup, error) {
	if endpoint == "" {
		return tracingSetup{provider: noop.NewTracerProvider(), shutdown: func(context.Context) error { return nil }}, nil
	}
	u, err := url.Parse(endpoint)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.RawQuery != "" || u.User != nil || u.Fragment != "" {
		return tracingSetup{}, fmt.Errorf("OTEL_EXPORTER_OTLP_ENDPOINT must be an HTTP(S) URL without credentials, query, or fragment")
	}
	exporter, err := otlptracehttp.New(ctx, otlptracehttp.WithEndpointURL(u.JoinPath("v1/traces").String()), otlptracehttp.WithTimeout(time.Second))
	if err != nil {
		return tracingSetup{}, fmt.Errorf("create OTLP HTTP trace exporter: %w", err)
	}
	processor := sdktrace.NewBatchSpanProcessor(exporter, sdktrace.WithBatchTimeout(time.Second), sdktrace.WithExportTimeout(time.Second))
	provider := newRequestTracerProvider(serverID, processor)
	return tracingSetup{provider: provider, shutdown: provider.Shutdown}, nil
}

func newRequestTracerProvider(serverID string, processor sdktrace.SpanProcessor) *sdktrace.TracerProvider {
	return sdktrace.NewTracerProvider(
		sdktrace.WithResource(resource.NewSchemaless(
			attribute.String("service.name", "multiserver-backend"),
			attribute.String("service.instance.id", serverID),
		)),
		sdktrace.WithSampler(requestSampler{sdktrace.ParentBased(sdktrace.AlwaysSample())}),
		sdktrace.WithSpanProcessor(requestIDSpanProcessor{processor}),
	)
}

func instrumentRedisTracing(provider trace.TracerProvider, clients ...*redis.Client) error {
	seen := make(map[*redis.Client]bool, len(clients))
	for _, client := range clients {
		if seen[client] {
			continue
		}
		seen[client] = true
		if err := redisotel.InstrumentTracing(client,
			redisotel.WithTracerProvider(provider), redisotel.WithDBStatement(false),
			redisotel.WithCallerEnabled(false), redisotel.WithDialFilter(true),
			redisotel.WithCommandFilter(tracingCommandFiltered),
			redisotel.WithCommandsFilter(func(commands []redis.Cmder) bool {
				for _, command := range commands {
					if !tracingCommandFiltered(command) {
						return false
					}
				}
				return true
			}),
		); err != nil {
			return fmt.Errorf("instrument Redis tracing: %w", err)
		}
	}
	return nil
}

func tracingCommandFiltered(command redis.Cmder) bool {
	switch command.Name() {
	case "auth", "hello", "client":
		return true
	default:
		return redisotel.DefaultCommandFilter(command)
	}
}

func (s *Server) withTracing(next http.Handler) http.Handler {
	withRoute := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		trace.SpanFromContext(r.Context()).SetAttributes(attribute.String("http.route", metricRoute(r.URL.Path)))
		next.ServeHTTP(w, r)
	})
	traced := otelhttp.NewHandler(withRoute, "backend",
		otelhttp.WithTracerProvider(s.tracerProvider),
		otelhttp.WithPropagators(propagation.TraceContext{}),
		otelhttp.WithFilter(func(r *http.Request) bool { return r.URL.Path != "/health" && r.URL.Path != "/metrics" }),
		otelhttp.WithSpanNameFormatter(func(_ string, r *http.Request) string { return r.Method + " " + metricRoute(r.URL.Path) }),
	)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := context.WithValue(r.Context(), requestIDContextKey{}, r.Header.Get("X-Request-Id"))
		traced.ServeHTTP(w, r.WithContext(ctx))
	})
}

type requestSampler struct{ sdktrace.Sampler }

func (s requestSampler) ShouldSample(p sdktrace.SamplingParameters) sdktrace.SamplingResult {
	if id, _ := p.ParentContext.Value(requestIDContextKey{}).(string); id == "" {
		return sdktrace.SamplingResult{Decision: sdktrace.Drop}
	}
	return s.Sampler.ShouldSample(p)
}

func (s requestSampler) Description() string {
	return "RequestContext(" + s.Sampler.Description() + ")"
}

type requestIDSpanProcessor struct{ sdktrace.SpanProcessor }

func (p requestIDSpanProcessor) OnStart(ctx context.Context, span sdktrace.ReadWriteSpan) {
	if id, _ := ctx.Value(requestIDContextKey{}).(string); id != "" {
		span.SetAttributes(attribute.String("request.id", id))
	}
	p.SpanProcessor.OnStart(ctx, span)
}
