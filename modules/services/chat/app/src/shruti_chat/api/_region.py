"""Trust-boundary helper for the `X-Shruti-Region` header.

The RU proxy (#728) tags every forwarded request with
`X-Shruti-Region: ru` so the global backend can gate PII-class
persistence (Langfuse user_id hashing, dropped free-text feedback,
redacted access-log message bodies). Caddy on global no longer strips
the header on the chat handle — trust is enforced here exclusively.

We only honour the header when the request peer IP is loopback,
RFC1918 docker-bridge, or one of the configured
`REGION_HEADER_TRUSTED_SOURCES` CIDRs. After ProxyHeadersMiddleware
rewrites `request.client.host` to the leftmost untrusted XFF entry,
that ends up being the RU proxy's public egress IP — which is exactly
what the operator must list in `REGION_HEADER_TRUSTED_SOURCES`.
Untrusted sources collapse to `region=None` — no error, just ignored,
so the client never learns whether the header was accepted or stripped.
"""

from __future__ import annotations

import ipaddress
from functools import lru_cache

from fastapi import Request

from shruti_chat.config import get_settings


# Always-trusted networks: loopback + RFC1918. Anything outside this set
# AND outside the configured REGION_HEADER_TRUSTED_SOURCES is treated as
# untrusted and the X-Shruti-Region header is silently ignored.
_BUILTIN_TRUSTED_NETWORKS: tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...] = (
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
)


@lru_cache(maxsize=1)
def _configured_networks_key(snapshot: tuple[str, ...]) -> tuple[
    ipaddress.IPv4Network | ipaddress.IPv6Network, ...
]:
    """Parse the configured CIDR list once per Settings snapshot.

    The snapshot tuple is the cache key so a Settings reload (tests
    monkey-patching `_settings = None`) flushes the cache implicitly via
    the new tuple identity.
    """
    parsed: list[ipaddress.IPv4Network | ipaddress.IPv6Network] = []
    for entry in snapshot:
        try:
            parsed.append(ipaddress.ip_network(entry, strict=False))
        except ValueError:
            # Bad CIDR in config — silently skip; logging it once at
            # startup would be nicer but config validation already runs
            # before the first request lands.
            continue
    return tuple(parsed)


def _trusted_networks() -> tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...]:
    extra = tuple(get_settings().region_header_trusted_sources)
    return _BUILTIN_TRUSTED_NETWORKS + _configured_networks_key(extra)


def _is_trusted_source(host: str | None) -> bool:
    if not host:
        return False
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        return False
    return any(addr in net for net in _trusted_networks())


def extract_region(request: Request) -> str | None:
    """Return the `X-Shruti-Region` header iff the request source is trusted.

    Untrusted sources (and missing-header trusted sources) both return None.
    Stripping unknown / empty values keeps the contract narrow — today only
    `"ru"` is meaningful, but accepting any non-empty token keeps the door
    open for additional regions without a code change.
    """
    raw = request.headers.get("X-Shruti-Region")
    if not raw:
        return None
    host = request.client.host if request.client else None
    if not _is_trusted_source(host):
        return None
    value = raw.strip().lower()
    return value or None
