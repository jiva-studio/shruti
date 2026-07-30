package main

import (
	"fmt"
	"os"

	glossary "github.com/jiva-studio/lectorium/pipeline/glossary"
)

func main() {
	g, err := loadGlossary(os.Args[1])
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

func loadGlossary(path string) (*glossary.Glossary, error) {
	if path == "" || path == "-" {
		return glossary.Embedded()
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return glossary.Parse(body)
}
