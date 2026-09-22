// Package netguard keeps server-side fetches pointed at the public internet.
//
// CheckURL rejects a non-public host up front and is the only guard available
// for yt-dlp, which dials in its own process. DialControl runs on the actual
// connect, so it also covers redirects and DNS rebinding.
package netguard

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"strings"
	"syscall"
)

// ErrBlocked is returned for an address that is not publicly routable.
type ErrBlocked struct {
	Host string
	IP   string
}

func (e *ErrBlocked) Error() string {
	if e.IP == "" {
		return fmt.Sprintf("address %q is not publicly routable", e.Host)
	}
	return fmt.Sprintf("host %q resolves to %s, which is not publicly routable", e.Host, e.IP)
}

// blocked reports whether an IP is anything but a public unicast address.
// CGNAT (100.64.0.0/10) is in the list because that is the tailnet range.
func blocked(ip net.IP) bool {
	if ip == nil || ip.IsUnspecified() || ip.IsLoopback() ||
		ip.IsPrivate() || ip.IsMulticast() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsInterfaceLocalMulticast() {
		return true
	}
	if v4 := ip.To4(); v4 != nil {
		// 100.64.0.0/10 — CGNAT / Tailscale.
		if v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127 {
			return true
		}
		if v4[0] == 0 || v4[0] >= 240 {
			return true
		}
	}
	return false
}

// CheckURL validates the scheme and resolves the host. A host resolving to
// several addresses is rejected if any one of them is blocked.
func CheckURL(ctx context.Context, rawURL string) error {
	u, err := url.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("parse url: %w", err)
	}
	switch strings.ToLower(u.Scheme) {
	case "http", "https":
	default:
		return &ErrBlocked{Host: u.Scheme + "://"}
	}
	host := u.Hostname()
	if host == "" {
		return &ErrBlocked{Host: rawURL}
	}
	if ip := net.ParseIP(host); ip != nil {
		if blocked(ip) {
			return &ErrBlocked{Host: host, IP: ip.String()}
		}
		return nil
	}
	addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return fmt.Errorf("resolve %q: %w", host, err)
	}
	if len(addrs) == 0 {
		return &ErrBlocked{Host: host}
	}
	for _, a := range addrs {
		if blocked(a.IP) {
			return &ErrBlocked{Host: host, IP: a.IP.String()}
		}
	}
	return nil
}

// DialControl is a net.Dialer.Control hook refusing a non-public address.
func DialControl(_, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("split %q: %w", address, err)
	}
	ip := net.ParseIP(host)
	if blocked(ip) {
		return &ErrBlocked{Host: host, IP: host}
	}
	return nil
}
