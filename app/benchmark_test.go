package main

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

var benchmarkRootResponseBytes int
var benchmarkClampResult int

// BenchmarkHandleRoot includes recorder allocation, JSON, and a miniredis TCP
// round trip; it excludes HTTP transport, middleware, TLS, and Redis disk I/O.
func BenchmarkHandleRoot(b *testing.B) {
	primary := miniredis.RunT(b)
	client := redis.NewClient(&redis.Options{Addr: primary.Addr(), ContextTimeoutEnabled: true})
	b.Cleanup(func() { _ = client.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	if err := client.Ping(ctx).Err(); err != nil {
		cancel()
		b.Fatal(err)
	}
	cancel()
	server := NewServer("benchmark", client, nil)
	server.logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	var recorder *httptest.ResponseRecorder
	b.ReportAllocs()
	for b.Loop() {
		recorder = httptest.NewRecorder()
		server.handleRoot(recorder, request)
		if recorder.Code != http.StatusOK {
			b.Fatalf("root status: %d, body: %s", recorder.Code, recorder.Body.String())
		}
	}
	benchmarkRootResponseBytes = recorder.Body.Len()
}

// BenchmarkClampSlowSeconds cycles inputs below, inside, and above the range.
func BenchmarkClampSlowSeconds(b *testing.B) {
	inputs := [8]int{-5, -1, 0, 1, 5, 10, 11, 100}
	index, total := 0, 0
	b.ReportAllocs()
	for b.Loop() {
		total += clampSlowSeconds(inputs[index])
		index = (index + 1) & 7
	}
	benchmarkClampResult = total
}
