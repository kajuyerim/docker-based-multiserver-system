package main

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

const counterChannel = "counter_updates"

type counterEvent struct {
	GlobalCount int64 `json:"global_count"`
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	subscription := s.primary.Subscribe(r.Context(), counterChannel)
	defer subscription.Close()
	subscribeCtx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	_, err := subscription.Receive(subscribeCtx)
	cancel()
	if err != nil {
		s.logger.Error("counter event subscription failed", "err", err)
		s.writeJSON(w, http.StatusServiceUnavailable, errorResponse{Error: "event stream unavailable"})
		return
	}

	w.Header().Del("Content-Type")
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer conn.CloseNow()
	ctx := conn.CloseRead(s.eventsContext)
	messages := subscription.Channel()
	heartbeat := time.NewTicker(20 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-heartbeat.C:
			pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			err := conn.Ping(pingCtx)
			cancel()
			if err != nil {
				return
			}
		case message, ok := <-messages:
			if !ok {
				return
			}
			count, err := strconv.ParseInt(message.Payload, 10, 64)
			if err != nil {
				s.logger.Error("invalid counter event", "err", err)
				continue
			}
			writeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			err = wsjson.Write(writeCtx, conn, counterEvent{GlobalCount: count})
			cancel()
			if err != nil {
				return
			}
		}
	}
}
