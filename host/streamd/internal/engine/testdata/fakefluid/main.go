// Command fakefluid is a test double for fluidstreamd (which only builds on
// macOS). It honours the frozen stdio contract just enough for streamd tests:
// it accepts `--lang` and `--chunk-ms`, reads PCM from stdin, emits NDJSON
// partials as bytes arrive, and on EOF emits a last partial + a final, then
// exits 0.
package main

import (
	"bufio"
	"flag"
	"fmt"
	"os"
)

func main() {
	flag.String("lang", "ru", "ASR language hint (ignored by the fake)")
	flag.Int("chunk-ms", 2240, "ASR chunk size in ms (ignored by the fake)")
	flag.Parse()

	out := bufio.NewWriter(os.Stdout)

	r := bufio.NewReader(os.Stdin)
	buf := make([]byte, 4096)
	total := 0
	emittedFirst := false
	for {
		n, err := r.Read(buf)
		total += n
		if n > 0 && !emittedFirst {
			fmt.Fprintln(out, `{"type":"partial","text":"привет","ts_ms":100}`)
			out.Flush()
			emittedFirst = true
		}
		if err != nil {
			break
		}
	}

	// EOF on stdin → flush the tail.
	fmt.Fprintln(out, `{"type":"partial","text":"привет мир","ts_ms":200}`)
	fmt.Fprintf(out, "{\"type\":\"final\",\"text\":\"привет мир (%d bytes).\",\"ts_ms\":300}\n", total)
	out.Flush()
}
