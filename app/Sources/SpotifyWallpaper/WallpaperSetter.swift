import AppKit

/// Sets the real desktop wallpaper.
///
/// macOS only lets an app set the wallpaper of the Space you're currently on, so the engine sets it on every
/// change and `reapply()` runs the instant you switch Spaces: whichever Space you're looking at is current.
/// The API needs a file URL, and re-setting a path a Space already shows doesn't refresh it, so each screen
/// alternates between two files.
///
/// WallpaperAgent caches a large render per path and modification time, so a file is only written when it doesn't
/// already hold the latest frame: switching Spaces just points the Space at a slot that does.
@MainActor
final class WallpaperSetter {
    private let dir: URL
    private var latest: [CGDirectDisplayID: Data] = [:]
    private var slot: [CGDirectDisplayID: Int] = [:]
    /// Bumped per new frame; `held` records which frame each slot file holds, so unchanged files aren't rewritten.
    private var generation: [CGDirectDisplayID: Int] = [:]
    private var held: [CGDirectDisplayID: [Int: Int]] = [:]
    private var pruneScheduled = false
    private(set) var showing = false
    private let defaults = UserDefaults.standard

    init(paths: Paths) {
        dir = paths.frames
        WallpaperCachePruner.schedule(frames: dir)  // leftovers from earlier runs
    }

    func show(_ jpeg: Data, on screen: NSScreen) {
        if !showing { rememberOriginals() }
        showing = true
        let id = displayID(screen)
        latest[id] = jpeg
        generation[id, default: 0] += 1
        apply(screen)
    }

    func reapply() {
        guard showing else { return }
        for screen in NSScreen.screens { apply(screen) }
    }

    /// Points the current Space at a slot holding the latest frame other than the one it shows, writing that slot
    /// only if it holds an older frame. A Space showing the stale slot just switches paths, no write; one showing
    /// the fresh slot may not have been refreshed since it was written, so it gets the other slot, written at most
    /// once per frame.
    private func apply(_ screen: NSScreen) {
        let id = displayID(screen)
        guard let data = latest[id], let gen = generation[id] else { return }
        let current = NSWorkspace.shared.desktopImageURL(for: screen)?.standardizedFileURL
        let shown = (0...1).first { frameURL(id, $0).standardizedFileURL == current }
        if let fresh = (0...1).first(where: { $0 != shown && held[id]?[$0] == gen }) {
            set(frameURL(id, fresh), on: screen, slot: fresh)
            return
        }
        let next = shown.map { $0 ^ 1 } ?? ((slot[id] ?? 0) ^ 1)
        let url = frameURL(id, next)
        do {
            // restore() leaves symlinks here so every Space can show the user's wallpaper without Lirica reading a
            // protected source folder. Remove the link before writing, never follow it into the user's original.
            if (try? url.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) == true {
                try FileManager.default.removeItem(at: url)
            }
            try data.write(to: url, options: .atomic)
            held[id, default: [:]][next] = gen
        } catch {
            held[id]?[next] = nil
            NSLog("SpotifyWallpaper: couldn't set wallpaper: \(error)")
            return
        }
        set(url, on: screen, slot: next)
        schedulePrune()
    }

    private func set(_ url: URL, on screen: NSScreen, slot s: Int) {
        slot[displayID(screen)] = s
        do {
            try NSWorkspace.shared.setDesktopImageURL(url, for: screen, options: [:])
        } catch {
            NSLog("SpotifyWallpaper: couldn't set wallpaper: \(error)")
        }
    }

    /// At most one prune a minute, a minute after a write so WallpaperAgent has rendered the new frame.
    private func schedulePrune() {
        guard !pruneScheduled else { return }
        pruneScheduled = true
        WallpaperCachePruner.schedule(frames: dir, after: 60) { [weak self] in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.pruneScheduled = false } }
        }
    }

    private func frameURL(_ id: CGDirectDisplayID, _ slot: Int) -> URL {
        dir.appendingPathComponent("wall_\(id)_\(slot == 0 ? "a" : "b").jpg")
    }

    // MARK: original wallpaper

    private var originals: [String: String] {
        get { defaults.dictionary(forKey: "originalWallpapers") as? [String: String] ?? [:] }
        set { defaults.set(newValue, forKey: "originalWallpapers") }
    }

    private func rememberOriginals() {
        var o = originals
        for screen in NSScreen.screens {
            if let url = NSWorkspace.shared.desktopImageURL(for: screen), Self.isUserWallpaper(url) {
                o[String(displayID(screen))] = url.path
            }
        }
        originals = o
    }

    /// A real wallpaper the user chose, rather than a frame from this app or the old Python prototype. Do not stat
    /// the source here: it may live in Downloads, Pictures or another privacy-protected folder.
    private static func isUserWallpaper(_ url: URL) -> Bool {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].path
        let ours = [caches + "/Spotify Wallpaper", caches + "/spotify-wallpaper"]
        return !ours.contains { url.path.hasPrefix($0) }
    }

    /// Puts the user's own wallpaper back. Spaces we can't reach right now still point at our two frame
    /// files, so turn both into symlinks to the original. Creating a link does not read the source image, avoiding
    /// a surprising Downloads/Pictures permission prompt when Lirica quits.
    func restore() {
        guard showing else { return }
        showing = false
        latest.removeAll()
        held.removeAll()  // the slots become symlinks below
        let o = originals
        for screen in NSScreen.screens {
            let id = displayID(screen)
            guard let path = o[String(id)] ?? o.values.first else { continue }
            for s in 0...1 {
                let frame = frameURL(id, s)
                try? FileManager.default.removeItem(at: frame)
                try? FileManager.default.createSymbolicLink(atPath: frame.path, withDestinationPath: path)
            }
            let current = NSWorkspace.shared.desktopImageURL(for: screen)?.standardizedFileURL
            var next = (slot[id] ?? 0) ^ 1
            if frameURL(id, next).standardizedFileURL == current { next ^= 1 }
            slot[id] = next
            try? NSWorkspace.shared.setDesktopImageURL(frameURL(id, next), for: screen, options: [:])
        }
    }
}
