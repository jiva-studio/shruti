// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "fluidstreamd",
    platforms: [.macOS(.v14)],
    dependencies: [
        // NOTE: fluidstreamd requires a NEWER FluidAudio than the batch
        // transcriber-service's pinned a53aff4 (2026-05-05). That revision only
        // ships the English-only Nemotron ("nemotron-speech-streaming-en-0.6b",
        // vocab 1024, no language/prompt_id). The multilingual Nemotron 3.5 model
        // (ru-RU + en-US, latin/multilingual variants, 2240 ms tier, prompt_id
        // language selection) landed in a later release, so we pin v0.15.4 here.
        // Consequence: fluidstreamd no longer shares the exact cached FluidAudio
        // build with fluidbatchd on mridanga.
        .package(
            url: "https://github.com/FluidInference/FluidAudio.git",
            exact: "0.15.4"
        ),
    ],
    targets: [
        .executableTarget(
            name: "fluidstreamd",
            dependencies: [
                .product(name: "FluidAudio", package: "FluidAudio"),
            ]
        ),
    ]
)
