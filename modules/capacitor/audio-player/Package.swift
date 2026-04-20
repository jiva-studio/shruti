// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "LectoriumAudioPlayer",
    platforms: [.iOS(.v14)],
    products: [
        .library(
            name: "LectoriumAudioPlayer",
            targets: ["AudioPlayerPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "7.0.0")
    ],
    targets: [
        .target(
            name: "AudioPlayerPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/AudioPlayerPlugin"),
        .testTarget(
            name: "AudioPlayerPluginTests",
            dependencies: ["AudioPlayerPlugin"],
            path: "ios/Tests/AudioPlayerPluginTests")
    ]
)