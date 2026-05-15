# ffmpeg layer

The static ffmpeg binary is **not** committed (it's ~25 MB). It is fetched at
deploy time by the GitHub Actions workflow into `bin/ffmpeg`, and either:

- packaged as a Lambda layer (AWS), mounted at `/opt/bin/ffmpeg`, or
- bundled into the function archive (Yandex Cloud Functions), available at the
  same `/opt/bin/ffmpeg` via a small wrapper.

## Local build

```bash
mkdir -p bin
curl -L https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz \
  | tar -xJ --strip-components=1 -C bin --wildcards '*/ffmpeg'
chmod +x bin/ffmpeg
```

The `bin/` folder is gitignored.
