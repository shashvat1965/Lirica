import XCTest
@testable import SpotifyWallpaper

final class WallpaperCachePrunerTests: XCTestCase {
    private func hex(_ time: Double) -> String { String(format: "%016llx", time.bitPattern) }

    func testCacheKeyIsTheSha256OfTheAbsolutePath() {
        let url = URL(fileURLWithPath: "/Users/shashvat/Library/Caches/Spotify Wallpaper/Frames/wall_1_a.jpg")
        let key = WallpaperCachePruner.cacheKey(for: url)
        XCTAssertTrue(key.hasPrefix("d0dfa6e80fdf7564"))
        XCTAssertEqual(key.count, 64)
        XCTAssertEqual(WallpaperCachePruner.cacheKey(for: URL(fileURLWithPath: "/Users/shashvat/Library/Caches/Spotify Wallpaper/Frames/../Frames/wall_1_a.jpg")), key)
    }

    func testOnlyFrameFilesCount() {
        XCTAssertTrue(WallpaperCachePruner.isFrameName("wall_1_a.jpg"))
        XCTAssertTrue(WallpaperCachePruner.isFrameName("wall_69733378_b.jpg"))
        XCTAssertFalse(WallpaperCachePruner.isFrameName("wall_1_c.jpg"))
        XCTAssertFalse(WallpaperCachePruner.isFrameName("cover.jpg"))
    }

    func testRenderTimeDecodesTheBigEndianDoubleSuffix() {
        XCTAssertEqual(WallpaperCachePruner.renderTime("abc-3024-1964-0-\(hex(815805464.25)).bmp"), 815805464.25)
        XCTAssertNil(WallpaperCachePruner.renderTime("abc-3024-1964-0-xyz.bmp"))
        XCTAssertNil(WallpaperCachePruner.renderTime("abc-3024-1964-0-\(hex(1)).png"))
    }

    func testKeepsTheNewestRenderPerFrameAndNeverTouchesOtherEntries() {
        let a = String(repeating: "a", count: 64), b = String(repeating: "b", count: 64)
        let user = String(repeating: "c", count: 64)
        let names = [
            "\(a)-3024-1964-0-\(hex(100)).bmp", "\(a)-3024-1964-0-\(hex(300)).bmp", "\(a)-3024-1964-0-\(hex(200)).bmp",
            "\(b)-3024-1964-0-\(hex(50)).bmp",
            "\(user)-3024-1964-0-\(hex(1)).bmp", "\(user)-3024-1964-0-\(hex(2)).bmp",
            "\(a)-garbage.bmp", ".DS_Store",
        ]
        XCTAssertEqual(WallpaperCachePruner.stale(names: names, keys: [a, b]),
                       ["\(a)-3024-1964-0-\(hex(100)).bmp", "\(a)-3024-1964-0-\(hex(200)).bmp"])
        XCTAssertEqual(WallpaperCachePruner.stale(names: names, keys: []), [])
    }
}
