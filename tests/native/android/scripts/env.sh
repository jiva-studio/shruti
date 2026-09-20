#!/usr/bin/env bash
# Sourced by the other scripts. Exports what the runner needs and nothing else.

export ANDROID_SERIAL="${ANDROID_SERIAL:-emulator-5556}"

# Appium fetches an unpatched chromedriver to reach the WebView, and nix-ld
# needs these to run it. Resolve them from nixpkgs rather than by hand: the
# store holds a 32-bit build of libxcb under the same name, and picking it
# makes Appium report "No Chromedriver found" instead of a load error.
if [ -z "${NIX_LD_LIBRARY_PATH:-}" ] && command -v nix-build >/dev/null 2>&1; then
  NIX_LD_LIBRARY_PATH="$(
    for attr in glib.out nss.out nspr.out xorg.libxcb.out; do
      nix-build --no-out-link '<nixpkgs>' -A "$attr" 2>/dev/null
    done | sed 's|$|/lib|' | paste -sd:
  )"
  export NIX_LD_LIBRARY_PATH
fi
