"""Resolves and invokes the denoise_mp3.py algorithm as a subprocess.

Mirrors transcriber-service's resolveFluidbatchd: one source of truth for the
algorithm (../audio-denoiser/denoise_mp3.py), run in a child process so the
worker pool gets real parallelism + per-job memory isolation.
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .models import DenoiseParams


@dataclass
class Runner:
    python: str          # interpreter that has the denoise deps installed
    script: str          # path to denoise_mp3.py
    ffprobe: str = "ffprobe"

    def ready(self) -> bool:
        return Path(self.script).is_file() and Path(self.python).exists()

    def probe_duration(self, path: str) -> float:
        """Audio duration in seconds via ffprobe. 0.0 if unavailable."""
        try:
            out = subprocess.run(
                [self.ffprobe, "-v", "error", "-show_entries", "format=duration",
                 "-of", "default=nk=1:nw=1", path],
                capture_output=True, text=True, timeout=60,
            )
            return float(out.stdout.strip())
        except (ValueError, OSError, subprocess.SubprocessError):
            return 0.0

    def denoise(self, in_path: str, out_path: str, params: DenoiseParams,
                timeout: float) -> None:
        """Run denoise_mp3.py single-file mode (or splice-plan mode when
        `params.segments` is set). Raises RuntimeError on failure."""
        args = [
            self.python, self.script,
            "--in", in_path,
            "--out", out_path,
            "--nr", str(params.nr),
            "--nf", str(params.nf),
            "--mix-min", str(params.mix_min),
            "--mix-max", str(params.mix_max),
        ]

        plan_file: Optional[str] = None
        if params.segments:
            # Splice plan overrides --strategy; hand it to the script as a temp
            # JSON file (avoids arg-length limits for long plans).
            fd, plan_file = tempfile.mkstemp(suffix=".json", prefix="denoise-plan-")
            try:
                with os.fdopen(fd, "w") as f:
                    json.dump({
                        "segments": [s.model_dump(exclude_none=True) for s in params.segments],
                        "crossfade_ms": params.crossfade_ms,
                    }, f)
            except Exception:
                os.unlink(plan_file)
                raise
            args += ["--plan", plan_file]
        else:
            args += ["--strategy", params.strategy]

        try:
            proc = subprocess.run(
                args, capture_output=True, text=True, timeout=timeout,
                env={**os.environ},
            )
        finally:
            if plan_file:
                try:
                    os.unlink(plan_file)
                except OSError:
                    pass
        if proc.returncode != 0:
            tail = (proc.stderr or proc.stdout or "").strip()[-2000:]
            raise RuntimeError(f"denoise_mp3.py exited {proc.returncode}: {tail}")


def resolve_script(flag: Optional[str]) -> str:
    """Locate denoise_mp3.py: explicit flag, then sibling audio-denoiser dir."""
    if flag:
        p = Path(flag).expanduser().resolve()
        if not p.is_file():
            raise FileNotFoundError(f"--denoiser-script not found: {p}")
        return str(p)
    # sibling of this package: modules/tools/audio-denoiser/denoise_mp3.py
    here = Path(__file__).resolve()
    candidate = here.parents[2] / "audio-denoiser" / "denoise_mp3.py"
    if candidate.is_file():
        return str(candidate)
    raise FileNotFoundError(
        "could not locate denoise_mp3.py; pass --denoiser-script explicitly "
        f"(looked in {candidate})"
    )
