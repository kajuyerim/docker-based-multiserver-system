// Command app starts the multiserver backend HTTP service.
//
// Environment:
//   - SERVER_ID:  replica identifier surfaced via the X-Server-Id response header.
//   - PORT:       TCP port to listen on (defaults to 8080).
//   - REDIS_ADDR: host:port of the shared Redis store (defaults to localhost:6379).
//   - REDIS_READ_ADDR: optional host:port for reads (defaults to REDIS_ADDR).
//   - AUTH_TOKEN: optional bearer token required on all endpoints when set.
//   - OTEL_EXPORTER_OTLP_ENDPOINT: optional OTLP HTTP base URL for request traces.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	serverID := envOrDefault("SERVER_ID", "app1")
	port := envOrDefault("PORT", "8080")
	redisAddr := envOrDefault("REDIS_ADDR", "localhost:6379")
	redisReadAddr := envOrDefault("REDIS_READ_ADDR", redisAddr)
	authToken := os.Getenv("AUTH_TOKEN")
	tracing, err := newTracing(context.Background(), serverID, os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"))
	if err != nil {
		logger.Error("tracing initialization failed", "err", err)
		os.Exit(1)
	}

	rdb := redis.NewClient(&redis.Options{Addr: redisAddr, ContextTimeoutEnabled: true})
	defer rdb.Close()

	reader := rdb
	if redisReadAddr != redisAddr {
		reader = redis.NewClient(&redis.Options{Addr: redisReadAddr, ContextTimeoutEnabled: true})
		defer reader.Close()
	}

	pingCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	err = rdb.Ping(pingCtx).Err()
	cancel()
	if err != nil {
		logger.Error("redis ping failed", "addr", redisAddr, "err", err)
		os.Exit(1)
	}
	if reader != rdb {
		pingCtx, cancel = context.WithTimeout(context.Background(), 5*time.Second)
		err = reader.Ping(pingCtx).Err()
		cancel()
		if err != nil {
			logger.Error("redis reader ping failed", "addr", redisReadAddr, "err", err)
			os.Exit(1)
		}
	}

	srv := NewServer(serverID, rdb, reader)
	srv.tracerProvider = tracing.provider
	if err := instrumentRedisTracing(tracing.provider, rdb, reader); err != nil {
		logger.Error("redis tracing initialization failed", "err", err)
		os.Exit(1)
	}

	addr := ":" + port
	httpSrv := &http.Server{
		Addr:              addr,
		Handler:           srv.HandlerWithAuth(authToken),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		// /slow legitimately runs for up to 10s; the write deadline must
		// clear it (nginx gives up earlier anyway, at proxy_read_timeout 15s).
		WriteTimeout: 20 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()

	errCh := make(chan error, 1)
	go func() {
		errCh <- httpSrv.ListenAndServe()
	}()

	logger.Info("backend starting", "server_id", serverID, "addr", addr,
		"redis", redisAddr, "redis_read", redisReadAddr, "auth_enabled", authToken != "")

	select {
	case err := <-errCh:
		logger.Error("server exited", "err", err)
		os.Exit(1)
	case <-ctx.Done():
	}

	logger.Info("shutdown initiated", "server_id", serverID, "in_flight", srv.InFlight())

	// Drain must clear the longest legal request (/slow caps at 10s) and finish
	// inside compose's stop_grace_period (15s): 10s < 12s < 15s.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	shutdownErr := httpSrv.Shutdown(shutdownCtx)
	cancel()
	if shutdownErr != nil {
		if errors.Is(shutdownErr, context.DeadlineExceeded) {
			logger.Error("shutdown drain timed out, connections aborted", "in_flight", srv.InFlight())
		} else {
			logger.Error("shutdown failed", "err", shutdownErr)
		}
	}
	flushCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	if err := tracing.shutdown(flushCtx); err != nil {
		logger.Error("tracing shutdown failed", "err", err)
	}
	cancel()
	if shutdownErr != nil {
		os.Exit(1)
	}
	logger.Info("shutdown complete", "server_id", serverID)
}

func envOrDefault(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return def
}
