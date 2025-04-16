import Foundation

@objc public class Downloader: NSObject {
    @objc public func echo(_ value: String) -> String {
        print(value)
        return value
    }
}
