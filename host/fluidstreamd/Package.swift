// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "fluidstreamd",
    platforms: [.macOS(.v14)],
    dependencies: [
        // Same library and pinned revision the batch transcriber-service uses,
        // so both share one cached FluidAudio build on mridanga.
        .package(
            url: "https://github.com/FluidInference/FluidAudio.git",
            revision: "a53aff438bed437bc23490bf0f8d1b57fa3845c7"
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
