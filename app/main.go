// Command app starts the multiserver backend HTTP service.
//
// Environment:
//   - SERVER_ID:  replica identifier surfaced via the X-Server-Id response header.
//   - PORT:       TCP port to listen on (defaults to 8080).
//   - REDIS_ADDR: host:port of the shared Redis store (defaults to localhost:6379).
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

	rdb := redis.NewClient(&redis.Options{Addr: redisAddr})
	defer rdb.Close()

	pingCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := rdb.Ping(pingCtx).Err(); err != nil {
		logger.Error("redis ping failed", "addr", redisAddr, "err", err)
		os.Exit(1)
	}

	srv := NewServer(serverID, rdb)

	addr := ":" + port
	httpSrv := &http.Server{
		Addr:              addr,
		Handler:           srv.Handler(),
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

	logger.Info("backend starting", "server_id", serverID, "addr", addr, "redis", redisAddr)

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
	defer cancel()
	if err := httpSrv.Shutdown(shutdownCtx); err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			logger.Error("shutdown drain timed out, connections aborted", "in_flight", srv.InFlight())
		} else {
			logger.Error("shutdown failed", "err", err)
		}
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
