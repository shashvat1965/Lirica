import CryptoKit
import Foundation

/// Deletes WallpaperAgent's stale renders of our own frame files.
///
/// WallpaperAgent caches an uncompressed BMP (tens of MB) for every image it shows, named
/// `<sha256 of the file's path>-<W>-<H>-0-<mtime as a big-endian float64 in hex>.bmp`, and never evicts old ones.
/// Every frame we write gets a new mtime and so a new entry: left alone the folder grows by gigabytes. Only entries
/// whose name starts with the hash of one of our frame paths are touched, keeping the newest per path; everything
/// else there is the user's own wallpapers. Best effort: the folder may be unreadable, and every failure is silent.
enum WallpaperCachePruner {
    static let cacheDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(
        "Library/Containers/com.apple.wallpaper.agent/Data/Library/Caches/com.apple.wallpaper.caches/"
            + "extension-com.apple.wallpaper.extension.image")

    private static let queue = DispatchQueue(label: "SpotifyWallpaper.cachePruner", qos: .utility)

    /// The name prefix WallpaperAgent uses for a file: the sha256 of its absolute path, in lowercase hex.
    static func cacheKey(for url: URL) -> String {
        SHA256.hash(data: Data(url.standardizedFileURL.path.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// Whether a file name is one of the two frames per display that `WallpaperSetter` alternates between.
    static func isFrameName(_ name: String) -> Bool {
        name.hasPrefix("wall_") && (name.hasSuffix("_a.jpg") || name.hasSuffix("_b.jpg"))
    }

    /// The source file's modification time encoded in a cache entry's name, or nil if the name isn't one.
    static func renderTime(_ name: String) -> Double? {
        guard name.hasSuffix(".bmp"), let hex = name.dropLast(4).split(separator: "-").last,
              hex.count == 16, let bits = UInt64(hex, radix: 16) else { return nil }
        return Double(bitPattern: bits)
    }

    /// The cache entries to delete: every render of one of `keys` except the newest per key. Names we can't parse
    /// are kept, never guessed at.
    static func stale(names: [String], keys: Set<String>) -> [String] {
        var byKey: [String: [(name: String, time: Double)]] = [:]
        for name in names {
            guard let dash = name.firstIndex(of: "-"), keys.contains(String(name[..<dash])),
                  let time = renderTime(name) else { continue }
            byKey[String(name[..<dash]), default: []].append((name, time))
        }
        return byKey.values.flatMap { entries -> [String] in
            let newest = entries.max { $0.time < $1.time }!.name
            return entries.map(\.name).filter { $0 != newest }
        }.sorted()
    }

    /// Prunes off the main thread, after `delay` so WallpaperAgent has rendered the frame just set.
    static func schedule(frames: URL, after delay: TimeInterval = 0, completion: (@Sendable () -> Void)? = nil) {
        queue.asyncAfter(deadline: .now() + delay) {
            prune(frames: frames)
            completion?()
        }
    }

    private static func prune(frames: URL) {
        let fm = FileManager.default
        do {
            let keys = Set(try fm.contentsOfDirectory(atPath: frames.path).filter(isFrameName)
                .map { cacheKey(for: frames.appendingPathComponent($0)) })
            guard !keys.isEmpty else { return }
            let doomed = stale(names: try fm.contentsOfDirectory(atPath: cacheDir.path), keys: keys)
            var freed: Int64 = 0
            for name in doomed {
                let url = cacheDir.appendingPathComponent(name)
                let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0
                do {
                    try fm.removeItem(at: url)
                    freed += size
                } catch {
                    NSLog("SpotifyWallpaper: couldn't remove cached wallpaper render \(name): \(error)")
                }
            }
            if !doomed.isEmpty {
                NSLog("SpotifyWallpaper: pruned \(doomed.count) stale wallpaper renders (\(freed / 1_000_000) MB)")
            }
        } catch {
            NSLog("SpotifyWallpaper: couldn't prune WallpaperAgent's cache: \(error)")
        }
    }
}
