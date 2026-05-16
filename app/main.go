// Command app starts the multiserver backend HTTP service.
//
// Environment:
//   - SERVER_ID:  replica identifier surfaced via the X-Server-Id response header.
//   - PORT:       TCP port to listen on (defaults to 8080).
//   - REDIS_ADDR: host:port of the shared Redis store (defaults to localhost:6379).
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
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
	logger.Info("backend starting", "server_id", serverID, "addr", addr, "redis", redisAddr)
	if err := http.ListenAndServe(addr, srv.Handler()); err != nil {
		logger.Error("server exited", "err", err)
		os.Exit(1)
	}
}

func envOrDefault(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return def
}
