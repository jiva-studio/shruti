package crawl

import (
	"sync"
	"testing"
)

// A claim is a plain read: an address keeps coming back until reading it has
// moved it on, so the same page appears in claim after claim while a worker is
// still fetching it. Handing it out twice is a wasted request to somebody's
// site and two transactions writing the same rows — which is exactly how a
// first run of a new source fell over on page_links.
func TestOneAddressGoesToOneWorker(t *testing.T) {
	s := &Scheduler{}
	url := "https://a.example/page"

	if !s.take(url) {
		t.Fatal("first worker was refused an address nobody holds")
	}
	if s.take(url) {
		t.Error("a second worker was given an address already being read")
	}

	s.release(url)
	if !s.take(url) {
		t.Error("the address stayed held after the worker finished with it")
	}
}

// Different addresses do not block each other: the guard is per address, not a
// lock on the queue.
func TestOtherAddressesAreUnaffected(t *testing.T) {
	s := &Scheduler{}
	if !s.take("https://a.example/one") || !s.take("https://a.example/two") {
		t.Fatal("two different addresses could not be held at once")
	}
}

// Workers take and release from several goroutines at once, which is the only
// way this is ever used.
func TestExactlyOneWinsUnderRace(t *testing.T) {
	s := &Scheduler{}
	url := "https://a.example/contested"

	var wg sync.WaitGroup
	var mu sync.Mutex
	won := 0
	for range 50 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if s.take(url) {
				mu.Lock()
				won++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()

	if won != 1 {
		t.Errorf("%d workers were given the same address, want 1", won)
	}
}
