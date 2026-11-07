// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "ForgeNative",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "ForgeNative", targets: ["ForgeNative"])],
    targets: [
        .executableTarget(name: "ForgeNative"),
        .testTarget(name: "ForgeNativeTests", dependencies: ["ForgeNative"])
    ]
)
