package main

import (
	"fmt"
	"os"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/glossary"
)

func main() {
	g, err := glossary.Load(os.Args[1])
	if err != nil {
		fmt.Println("err:", err)
		return
	}
	text := os.Args[2]
	for _, th := range []float64{0.55, 0.45, 0.40, 0.35, 0.30, 0.25} {
		hits := g.Match(text, "ru", th, 30)
		fmt.Printf("--- threshold %.2f → %d hits ---\n", th, len(hits))
		for _, h := range hits {
			fmt.Printf("  %.3f  %s\n", h.Score, h.Canonical)
		}
	}
}
