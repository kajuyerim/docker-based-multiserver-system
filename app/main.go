// Command app starts the multiserver backend HTTP service.
//
// Environment:
//   - SERVER_ID: replica identifier surfaced via the X-Server-Id response header.
//   - PORT: TCP port to listen on (defaults to 8080).
package main

import (
	"log"
	"net/http"
	"os"
)

func main() {
	serverID := envOrDefault("SERVER_ID", "app1")
	port := envOrDefault("PORT", "8080")

	srv := NewServer(serverID)

	addr := ":" + port
	log.Printf("backend starting server_id=%s addr=%s", serverID, addr)
	if err := http.ListenAndServe(addr, srv.Handler()); err != nil {
		log.Fatalf("server exited: %v", err)
	}
}

func envOrDefault(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return def
}
