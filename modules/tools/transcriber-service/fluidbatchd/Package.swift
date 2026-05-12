// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "fluidbatchd",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(
            url: "https://github.com/FluidInference/FluidAudio.git",
            revision: "a53aff438bed437bc23490bf0f8d1b57fa3845c7"
        ),
    ],
    targets: [
        .executableTarget(
            name: "fluidbatchd",
            dependencies: [
                .product(name: "FluidAudio", package: "FluidAudio"),
            ]
        )
    ]
)
