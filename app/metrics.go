package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/go-redis/v9"
)

type serverMetrics struct {
	registry *prometheus.Registry
	requests *prometheus.CounterVec
	duration *prometheus.HistogramVec
	handler  http.Handler
}

func newServerMetrics(s *Server) *serverMetrics {
	labels := prometheus.Labels{"server_id": s.serverID}
	m := &serverMetrics{
		registry: prometheus.NewRegistry(),
		requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "multiserver_http_requests_total", Help: "Completed backend HTTP requests by route and response status.", ConstLabels: labels,
		}, []string{"route", "status"}),
		duration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name: "multiserver_http_request_duration_seconds", Help: "Backend HTTP request duration in seconds by route and response status.", ConstLabels: labels,
			Buckets: []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15},
		}, []string{"route", "status"}),
	}
	m.registry.MustRegister(m.requests, m.duration,
		prometheus.NewGaugeFunc(prometheus.GaugeOpts{
			Name: "multiserver_in_flight_requests", Help: "Requests currently being served, including the metrics scrape itself.", ConstLabels: labels,
		}, func() float64 { return float64(s.InFlight()) }),
		prometheus.NewGaugeFunc(prometheus.GaugeOpts{
			Name: "multiserver_local_count", Help: "Root requests counted by this backend process.", ConstLabels: labels,
		}, func() float64 { return float64(s.localCnt.Load()) }),
		&globalCountCollector{
			primary: s.primary, logger: s.logger,
			count:   prometheus.NewDesc("multiserver_global_count", "Current shared root request count read directly from the Redis primary.", nil, labels),
			success: prometheus.NewDesc("multiserver_global_count_scrape_success", "Whether the shared Redis counter was read successfully on this scrape.", nil, labels),
		},
	)
	m.handler = promhttp.HandlerFor(m.registry, promhttp.HandlerOpts{})
	return m
}

func (s *Server) withMetrics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		recorder := &metricResponseWriter{ResponseWriter: w}
		next.ServeHTTP(recorder, r)
		status := recorder.status
		if status == 0 {
			status = http.StatusOK
		}
		route := metricRoute(r.URL.Path)
		code := strconv.Itoa(status)
		s.metrics.requests.WithLabelValues(route, code).Inc()
		s.metrics.duration.WithLabelValues(route, code).Observe(time.Since(started).Seconds())
	})
}

func metricRoute(path string) string {
	switch path {
	case "/", "/health", "/store", "/get", "/slow", "/metrics", "/events":
		return path
	default:
		return "unmatched"
	}
}

type metricResponseWriter struct {
	http.ResponseWriter
	status int
}

func (w *metricResponseWriter) WriteHeader(status int) {
	if w.status == 0 && (status >= 200 || status == http.StatusSwitchingProtocols) {
		w.status = status
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *metricResponseWriter) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(body)
}

func (w *metricResponseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

type globalCountCollector struct {
	primary *redis.Client
	logger  *slog.Logger
	count   *prometheus.Desc
	success *prometheus.Desc
}

func (c *globalCountCollector) Describe(ch chan<- *prometheus.Desc) {
	ch <- c.count
	ch <- c.success
}

func (c *globalCountCollector) Collect(ch chan<- prometheus.Metric) {
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	count, err := c.primary.Get(ctx, "global_count").Int64()
	if errors.Is(err, redis.Nil) {
		count, err = 0, nil
	}
	if err != nil {
		c.logger.Error("redis metrics counter read failed", "err", err)
		ch <- prometheus.MustNewConstMetric(c.success, prometheus.GaugeValue, 0)
		return
	}
	ch <- prometheus.MustNewConstMetric(c.count, prometheus.GaugeValue, float64(count))
	ch <- prometheus.MustNewConstMetric(c.success, prometheus.GaugeValue, 1)
}
