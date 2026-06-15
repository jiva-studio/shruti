"""denoiser-service: LAN-local HTTP service for batch audio denoising.

Mirrors transcriber-service's data plane (HTTP + SQLite queue + worker pool),
but the heavy lifting is delegated to the existing ``denoise_mp3.py`` script
(one source of truth for the algorithm) instead of a Swift ANE daemon.
"""

__version__ = "0.1.0"
