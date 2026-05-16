package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

// TestConcurrentRoot_AtomicCounters fires N concurrent GET / requests at a
// real httptest server and asserts that:
//   - global_count in Redis ends up exactly at N (Redis INCR is atomic);
//   - local_count (atomic.Int64) ends up exactly at N (no lost updates).
//
// A read-modify-write implementation of global_count would lose updates
// under this load — proving spec pitfall #1.
func TestConcurrentRoot_AtomicCounters(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	defer mr.Close()

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()

	srv := NewServer("app1", rdb)
	httpSrv := httptest.NewServer(srv.Handler())
	defer httpSrv.Close()

	const n = 200

	t.Logf("firing %d concurrent GET / requests at %s", n, httpSrv.URL)

	var wg sync.WaitGroup
	wg.Add(n)
	errs := make(chan error, n)
	ready := make(chan struct{})

	for range n {
		go func() {
			defer wg.Done()
			<-ready // thundering herd: maximise actual concurrency
			resp, err := http.Get(httpSrv.URL + "/")
			if err != nil {
				errs <- err
				return
			}
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				errs <- fmt.Errorf("status %d", resp.StatusCode)
			}
		}()
	}

	start := time.Now()
	close(ready)
	wg.Wait()
	elapsed := time.Since(start)
	close(errs)

	for err := range errs {
		t.Fatalf("request error: %v", err)
	}

	got, err := rdb.Get(context.Background(), "global_count").Int64()
	if err != nil {
		t.Fatalf("read global_count: %v", err)
	}
	local := srv.localCnt.Load()

	t.Logf("completed in %v", elapsed.Round(time.Microsecond))
	t.Logf("observed: global_count=%d, local_count=%d (expected both = %d)", got, local, n)
	t.Logf("if global_count < %d, Redis INCR is not atomic (read-modify-write would lose updates under contention)", n)
	t.Logf("if local_count  < %d, atomic.Int64 has a race (counter not race-free)", n)

	if got != n {
		t.Errorf("global_count: got %d, want %d -- lost updates indicate non-atomic increment", got, n)
	}
	if local != n {
		t.Errorf("local_count: got %d, want %d -- lost atomic.Int64 updates", local, n)
	}
}
