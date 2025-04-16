// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Downloader",
    platforms: [.iOS(.v14)],
    products: [
        .library(
            name: "Downloader",
            targets: ["DownloaderPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "7.0.0")
    ],
    targets: [
        .target(
            name: "DownloaderPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/DownloaderPlugin"),
        .testTarget(
            name: "DownloaderPluginTests",
            dependencies: ["DownloaderPlugin"],
            path: "ios/Tests/DownloaderPluginTests")
    ]
)