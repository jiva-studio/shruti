package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"os"
	"path/filepath"
)

// genKeys writes an RSA-2048 keypair to the given directory.
//
// Usage:  auth genkeys <dir>
//
// Idempotent: skips generation if private.pem already exists in <dir>.
// Files are written with 0600 (private) and 0644 (public).
func genKeys(args []string) int {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "usage: auth genkeys <dir>")
		return 2
	}
	dir := args[0]
	if err := os.MkdirAll(dir, 0o700); err != nil {
		fmt.Fprintln(os.Stderr, "mkdir:", err)
		return 1
	}

	priv := filepath.Join(dir, "private.pem")
	pub := filepath.Join(dir, "public.pem")

	if _, err := os.Stat(priv); err == nil {
		fmt.Printf("✓ keys already exist at %s — skipping\n", dir)
		return 0
	}

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		fmt.Fprintln(os.Stderr, "gen:", err)
		return 1
	}

	privPEM := pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(key),
	})
	pubBytes, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		fmt.Fprintln(os.Stderr, "marshal pub:", err)
		return 1
	}
	pubPEM := pem.EncodeToMemory(&pem.Block{
		Type:  "PUBLIC KEY",
		Bytes: pubBytes,
	})

	if err := os.WriteFile(priv, privPEM, 0o600); err != nil {
		fmt.Fprintln(os.Stderr, "write priv:", err)
		return 1
	}
	if err := os.WriteFile(pub, pubPEM, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "write pub:", err)
		return 1
	}

	fmt.Printf("✓ wrote:\n    %s (0600)\n    %s (0644)\n", priv, pub)
	return 0
}
