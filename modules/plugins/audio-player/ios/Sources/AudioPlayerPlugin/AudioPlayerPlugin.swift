import Foundation
import Capacitor
import AVFoundation
import MediaPlayer

@objc(AudioPlayerPlugin)
public class AudioPlayerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AudioPlayerPlugin"
    public let jsName = "AudioPlayer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "togglePause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seek", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seekBy", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setMix", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPlaybackRate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setProgressInterval", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "onProgressChanged", returnType: CAPPluginReturnCallback),
        CAPPluginMethod(name: "onPositionJump", returnType: CAPPluginReturnCallback),
        // Background continuous-playback queue surface (see src/definitions.ts).
        CAPPluginMethod(name: "setQueue", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "appendToQueue", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getQueueState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ackEvents", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "skipToNext", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "skipToPrevious", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "onItemTransition", returnType: CAPPluginReturnCallback),
    ]

    /// A single queued track. Holds everything native needs to (re)build
    /// the AVPlayerItem and to label the now-playing UI without calling
    /// back into JS — the queue advances natively while JS is suspended.
    private struct QueueEntry {
        let itemId: String
        let url: URL
        let title: String
        let author: String
        /// Known duration in seconds (from JS), used to report a
        /// completion duration in transitions when the AVPlayerItem's
        /// own duration is still indefinite.
        let knownDuration: Double?
    }

    // MARK: - Owner queue (#1726)
    //
    // Everything in this object is read and written on ONE queue: the main
    // queue. Callbacks reach the plugin from at least three places —
    // Capacitor's shared serial bridge queue (every @objc method), the main
    // queue (the periodic time observer, the persist Timer) and AVFoundation's
    // own queues (currentItem KVO, item-status KVO, the end-of-item
    // notification) — and Swift's Array/Dictionary are not thread-safe, so
    // concurrent mutation corrupts the bookkeeping or crashes the process.
    //
    // Android has the same three-source problem and solves it by construction:
    // `AudioPlayerPlugin.java` and `QueuePlaybackManager.java` post everything
    // to the main looper. This mirrors that, for the same reason and with the
    // same trade-off (the journal's small atomic writes happen on the owner
    // thread on both platforms).
    //
    // The rules, which the rest of this file obeys:
    //
    //   * every entry point that is not already on the owner queue hops with
    //     `onOwnerQueue`, and that hop is ALWAYS asynchronous. Nothing ever
    //     waits on the owner queue, so a bridge-queue call can never block on
    //     work that is itself waiting for the bridge queue.
    //   * a plugin method that has to report state resolves its CAPPluginCall
    //     from inside the hop rather than fetching a value back across it.
    //   * every private helper below assumes it is already on the owner queue
    //     (`assertOwnerQueue()` says so out loud in debug builds).
    //   * blocks posted from a one-shot plugin method capture `self` strongly:
    //     they run once, immediately, and the plugin must still exist to serve
    //     the call. Blocks installed on long-lived registrations (KVO,
    //     notifications, remote commands, timers) capture it weakly.

    /// Hop onto the owning queue. Deliberately async-only.
    private func onOwnerQueue(_ work: @escaping () -> Void) {
        DispatchQueue.main.async(execute: work)
    }

    /// Debug-only statement of the invariant. Compiled out of release builds.
    private func assertOwnerQueue() {
        assert(Thread.isMainThread, "audio-player state touched off the owner queue")
    }

    // MARK: - Owner-queue state

    // The AVQueuePlayer owns auto-advance under the `.playback` session —
    // a single track is just a queue of length 1 (one play path).
    private var player: AVQueuePlayer?
    private var progressObserver: Any?
    /// The player the periodic observer was added to. A token must be
    /// returned to its own player — `player` alone is the wrong reference
    /// the moment a rebuild swaps it (#1626).
    private weak var progressObserverPlayer: AVQueuePlayer?
    private var currentItemObservation: NSKeyValueObservation?
    private var statusCallbacks: [String: CAPPluginCall] = [:]
    private var transitionCallbacks: [String: CAPPluginCall] = [:]
    /// Listeners for jumps the system performed on its own — lock-screen
    /// scrubbing and the ±N s seek commands. Seeks JS asked for go through
    /// `seek()` / `seekBy()`, which the app already journals, so those are
    /// deliberately not reported here.
    private var positionJumpCallbacks: [String: CAPPluginCall] = [:]

    /// The full ordered queue snapshot (current item onward). `queueIndex`
    /// points at the entry currently playing. We keep the entries (not
    /// just AVPlayerItems) so we can rebuild for `skipToPrevious` —
    /// AVQueuePlayer is forward-only — and re-fill on append.
    private var entries: [QueueEntry] = []
    private var queueIndex: Int = 0

    /// itemId for the entry that is currently the AVQueuePlayer's
    /// currentItem. Tracked separately from `queueIndex` because the
    /// currentItem KVO is what tells us a native advance happened.
    private var currentItemId: String = ""

    /// Where listening on each item began (resume point / 0), keyed by
    /// itemId. Kept per-item rather than as a single mutable field because
    /// the natural-end notification and the currentItem KVO can fire in
    /// either order — the finished item's `fromPosition` must not be
    /// clobbered by the next item becoming current first.
    private var fromPositionByItemId: [String: Double] = [:]

    /// Wall-clock (epoch ms) when listening on each item began, keyed by
    /// itemId. Same bookkeeping as `fromPositionByItemId`, in the same places.
    private var fromAtByItemId: [String: Double] = [:]

    /// Maps an AVPlayerItem to its itemId so the currentItem-change
    /// observer knows which entry just became current. AVQueuePlayer
    /// drops finished items, so we also use `entries` for lookups.
    private var itemIdByItem: [ObjectIdentifier: String] = [:]

    /// Per-item failure retry budget so a run of bad items can't loop.
    private var failureRetries: [String: Int] = [:]
    private let maxFailureRetries = 1

    /// AVPlayerItem.status / failure observations, keyed by item.
    private var itemStatusObservations: [ObjectIdentifier: NSKeyValueObservation] = [:]

    /// Bumped by every `rebuildPlayer`. The player is now assembled after an
    /// asynchronous asset load (#1740), so a rebuild that a newer one has
    /// already replaced must drop its result instead of installing a stale
    /// player. `settledGeneration` trails it once a rebuild has finished.
    private var rebuildGeneration: Int = 0
    private var settledGeneration: Int = 0
    /// True while a rebuild has torn the old player down but not yet installed
    /// the new one — the window `appendItems` has to know about.
    private var rebuildInFlight: Bool { rebuildGeneration != settledGeneration }

    private let journal = QueueJournal()

    /// One tap instance, reused across opens. Owns the heap-allocated
    /// mix-state context that the per-item MTAudioProcessingTap
    /// callbacks dereference, so a setMix() call hits whatever item
    /// is currently in flight.
    private let stereoMixTap = StereoMixTap()

    /// AVPlayer.rate has dual meaning: `0` = paused, anything > 0 means
    /// actively playing at that speed. We can't write `player.rate =
    /// newRate` while paused — it'd resume playback. Store the user's
    /// chosen speed here and apply it whenever we transition into play.
    private var targetPlaybackRate: Float = 1.0
    /// How often the periodic time observer fires (seconds). Adjusted by
    /// `setProgressInterval` so we stream fast for transcript highlighting,
    /// slower for the floating player, and a heartbeat when backgrounded.
    private var progressIntervalSec: Double = 1.0

    /// How far the lock screen's seek gesture moves. iOS reports the gesture
    /// as begin/end events, not as an interval, so we pick one.
    private let remoteSeekIntervalSec: Double = 30

    /// Whether playback was running when an audio-session interruption
    /// began, so `.ended` doesn't start a lecture the user had paused.
    private var wasPlayingBeforeInterruption = false

    /// Coarse safety timer that snapshots the in-flight position to disk
    /// (~30 s) while playing, so a hard background kill loses at most that
    /// much resume accuracy (§3.4).
    private var positionPersistTimer: Timer?
    private let positionPersistInterval: TimeInterval = 30

    /// The engine has something loaded. Derived from our own bookkeeping and
    /// not from `player.currentItem`, which AVQueuePlayer clears asynchronously
    /// around the end of the last item — exactly when this matters (#1740).
    private var hasLiveItem: Bool {
        player != nil && !currentItemId.isEmpty
    }

    override public func load() {
        // Setup audio session for background playback
        setupAudioSession()

        // The transport controls read queue state (`updateRemoteSkipCommands`),
        // so they are armed on the owner queue like every other mutation.
        onOwnerQueue { self.setupRemoteTransportControls() }

        // Add notification observers for audio interruptions
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleInterruption),
            name: AVAudioSession.interruptionNotification,
            object: nil
        )

        // Add notification for when audio route changes (e.g., headphones unplugged)
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleRouteChange),
            name: AVAudioSession.routeChangeNotification,
            object: nil
        )

        // A natural end on ANY queued item — AVQueuePlayer auto-advances,
        // but we still get one notification per item. The notification's
        // object identifies which item ended.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(playerItemDidReachEnd(notification:)),
            name: .AVPlayerItemDidPlayToEndTime,
            object: nil
        )

        // A failed item (couldn't play to end). We journal a partial and
        // let AVQueuePlayer skip past it.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(playerItemFailedToReachEnd(notification:)),
            name: .AVPlayerItemFailedToPlayToEndTime,
            object: nil
        )
    }

    private func setupAudioSession() {
        do {
            // No `.mixWithOthers`: it marks our audio as secondary/ambient,
            // so iOS hands the Now Playing / lock-screen controls to whichever
            // app owns a non-mixing session instead of us. As the primary
            // session we own the lock screen and Control Center, and starting
            // playback pauses other apps — the expected media-player behaviour.
            try AVAudioSession.sharedInstance().setCategory(
                .playback,
                mode: .default,
                options: [.allowAirPlay]
            )
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            print("Failed to set up audio session: \(error.localizedDescription)")
        }
    }

    /// Remote command handlers return their status synchronously but do their
    /// work on the owner queue, so they answer `.success` and let the hop
    /// decide what actually happens. Nothing is lost: `updateRemoteSkipCommands`
    /// only ENABLES a skip when there is somewhere to go, which is the same
    /// decision `.noSuchContent` used to report one hop later.
    private func setupRemoteTransportControls() {
        assertOwnerQueue()
        // Get the shared command center
        let commandCenter = MPRemoteCommandCenter.shared()

        // Add handlers for play, pause, etc.
        commandCenter.playCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            self.onOwnerQueue { self.performPlay() }
            return .success
        }

        commandCenter.pauseCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            self.onOwnerQueue { self.performTogglePause() }
            return .success
        }

        // Lock-screen next/previous drive the native queue skips so the
        // background advance + journaling go through one path. Both are
        // disabled until a queue with somewhere to go is loaded.
        commandCenter.nextTrackCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            self.onOwnerQueue { self.advanceToNext(reason: "skip-next") }
            return .success
        }

        commandCenter.previousTrackCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            self.onOwnerQueue { self.goToPrevious() }
            return .success
        }

        updateRemoteSkipCommands()

        // MPSeekCommandEvent is a press-and-hold gesture: `.beginSeeking` on
        // press, `.endSeeking` on release. It carries no interval — multiplying
        // `type.rawValue` by 30 (what this did before) is enum arithmetic, and
        // made the press emit a bogus 0-second jump (#1740). We treat the whole
        // gesture as one discrete ±30 s jump, applied on release.
        commandCenter.seekForwardCommand.addTarget { [weak self] event in
            guard let self = self, let seekEvent = event as? MPSeekCommandEvent else {
                return .commandFailed
            }
            guard seekEvent.type == .endSeeking else { return .success }
            self.onOwnerQueue { self.seekRelativeFromRemote(delta: self.remoteSeekIntervalSec) }
            return .success
        }

        commandCenter.seekBackwardCommand.addTarget { [weak self] event in
            guard let self = self, let seekEvent = event as? MPSeekCommandEvent else {
                return .commandFailed
            }
            guard seekEvent.type == .endSeeking else { return .success }
            self.onOwnerQueue { self.seekRelativeFromRemote(delta: -self.remoteSeekIntervalSec) }
            return .success
        }

        commandCenter.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let self = self,
                  let changeEvent = event as? MPChangePlaybackPositionCommandEvent else {
                return .commandFailed
            }
            let target = changeEvent.positionTime
            self.onOwnerQueue {
                guard let player = self.player else { return }
                self.seekFromRemote(to: max(0, target), from: player.currentTime().seconds)
            }
            return .success
        }
    }

    /// Keep the remote skip buttons in step with the live queue. iOS shows
    /// (and honours, from a car or headset) whatever is enabled here, so a
    /// one-item queue must not expose them — advancing would empty the
    /// AVQueuePlayer. Android gets this from the Media3 timeline.
    private func updateRemoteSkipCommands() {
        assertOwnerQueue()
        let commandCenter = MPRemoteCommandCenter.shared()
        commandCenter.nextTrackCommand.isEnabled = PlaybackPolicy.remoteNextEnabled(
            queueIndex: queueIndex,
            entryCount: entries.count,
            hasLiveItem: hasLiveItem
        )
        commandCenter.previousTrackCommand.isEnabled = PlaybackPolicy.remotePreviousEnabled(
            entryCount: entries.count,
            hasLiveItem: hasLiveItem
        )
    }

    // MARK: - Audio session notifications

    @objc func handleInterruption(notification: Notification) {
        guard let info = notification.userInfo,
              let typeValue = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else {
            return
        }
        let optionsValue = info[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
        onOwnerQueue { [weak self] in
            self?.applyInterruption(type: type, optionsValue: optionsValue)
        }
    }

    private func applyInterruption(type: AVAudioSession.InterruptionType, optionsValue: UInt) {
        assertOwnerQueue()
        switch type {
        case .began:
            wasPlayingBeforeInterruption = (player?.rate ?? 0) != 0
            if wasPlayingBeforeInterruption {
                performTogglePause()
            }
        case .ended:
            // Our session is never deactivated, so iOS offers `.shouldResume`
            // even for a lecture the user had paused before the call arrived.
            let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue)
            if PlaybackPolicy.shouldResumeAfterInterruption(
                wasPlaying: wasPlayingBeforeInterruption,
                systemSuggestsResume: options.contains(.shouldResume)
            ) {
                performPlay()
            }
            wasPlayingBeforeInterruption = false
        @unknown default:
            break
        }
    }

    @objc func handleRouteChange(notification: Notification) {
        guard let info = notification.userInfo,
              let reasonValue = info[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue) else {
            return
        }

        // Pause playback when headphones are unplugged
        guard reason == .oldDeviceUnavailable else { return }
        onOwnerQueue { [weak self] in
            guard let self = self else { return }
            if self.player?.rate != 0 {
                self.performTogglePause()
            }
        }
    }

    // MARK: - Public API: single-track convenience (one play path)

    @objc func open(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), URL(string: urlString) != nil else {
            call.reject("Invalid URL provided")
            return
        }
        let title = call.getString("title") ?? "Unknown Title"
        let author = call.getString("author") ?? "Unknown Artist"
        let itemId = call.getString("itemId") ?? ""

        // open() is a queue of length 1 — there is ONE native play path.
        let item = QueueItemSpec(itemId: itemId, url: urlString, title: title, author: author, duration: nil)
        onOwnerQueue {
            // Resolved only once the player is actually assembled: the app
            // seeks to the resume position straight after this promise
            // settles, and a seek that lands on a nil player is lost.
            self.replaceQueue(with: [item], startIndex: 0, startPosition: 0) {
                call.resolve()
            }
        }
    }

    // MARK: - Public API: queue

    @objc func setQueue(_ call: CAPPluginCall) {
        let rawItems = call.getArray("items") ?? []
        let items = rawItems.compactMap { parseQueueItem($0) }
        let startIndex = call.getInt("startIndex") ?? 0
        let startPosition = call.getDouble("startPosition") ?? 0
        guard !items.isEmpty else {
            call.reject("setQueue requires at least one item")
            return
        }
        onOwnerQueue {
            self.replaceQueue(
                with: items,
                startIndex: max(0, min(startIndex, items.count - 1)),
                startPosition: startPosition
            ) {
                call.resolve()
            }
        }
    }

    @objc func appendToQueue(_ call: CAPPluginCall) {
        let rawItems = call.getArray("items") ?? []
        let items = rawItems.compactMap { parseQueueItem($0) }
        guard !items.isEmpty else {
            call.resolve()
            return
        }
        onOwnerQueue {
            self.appendItems(items) {
                call.resolve()
            }
        }
    }

    @objc func getQueueState(_ call: CAPPluginCall) {
        onOwnerQueue {
            call.resolve(self.queueStatePayload())
        }
    }

    /// The now-playing snapshot JS drains on launch/resume. Falls back to the
    /// durable position snapshot when the engine has nothing live, the way
    /// Android does (`AudioPlayerPlugin.java` `getQueueState`): after iOS
    /// terminates a suspended app the in-flight lecture only exists on disk
    /// (#1740).
    private func queueStatePayload() -> [String: Any] {
        assertOwnerQueue()
        let events = journal.allTransitions().map { $0.toDictionary() }
        var currentId: String? = currentItemId.isEmpty ? nil : currentItemId
        var position = player?.currentTime().seconds ?? 0
        let durationCM = player?.currentItem?.duration
        var duration: Double = 0
        if let durationCM = durationCM, !durationCM.isIndefinite {
            duration = durationCM.seconds
        } else if let entry = currentEntry(), let known = entry.knownDuration {
            duration = known
        }
        // An itemless player is not playing whatever its last rate was —
        // JS reads this to clear a stale "playing" when the queue is dry.
        let playing = player?.currentItem != nil && (player?.rate ?? 0) != 0

        if player?.currentItem == nil {
            let snapshot = journal.lastPosition()
            if let snapshotId = snapshot.itemId, !snapshotId.isEmpty {
                currentId = snapshotId
                position = max(0, snapshot.positionSec)
            }
        }

        var currentIdValue: Any = NSNull()
        if let currentId = currentId {
            currentIdValue = currentId
        }

        return [
            "currentItemId": currentIdValue,
            "position": position.isFinite ? position : 0,
            "duration": duration.isFinite ? duration : 0,
            "playing": playing,
            "events": events
        ]
    }

    /// Touches only the journal, which owns its own serial queue, so this one
    /// deliberately stays on the bridge queue: hopping would put the journal's
    /// disk write on the owner thread for no gain.
    @objc func ackEvents(_ call: CAPPluginCall) {
        let upToSeq = call.getInt("upToSeq") ?? 0
        journal.ack(upToSeq: upToSeq)
        call.resolve()
    }

    @objc func skipToNext(_ call: CAPPluginCall) {
        onOwnerQueue {
            self.advanceToNext(reason: "skip-next")
            call.resolve()
        }
    }

    @objc func skipToPrevious(_ call: CAPPluginCall) {
        onOwnerQueue {
            self.goToPrevious()
            call.resolve()
        }
    }

    @objc func onPositionJump(_ call: CAPPluginCall) {
        let callbackId = UUID().uuidString
        call.keepAlive = true
        onOwnerQueue {
            self.positionJumpCallbacks[callbackId] = call
            call.resolve([
                "callbackId": callbackId
            ])
        }
    }

    /// Report a jump the system made to JS, so it closes the open listening
    /// session at `from` instead of absorbing the skipped span into it.
    private func pushPositionJump(from: Double, to: Double) {
        assertOwnerQueue()
        guard !positionJumpCallbacks.isEmpty else { return }
        let payload: [String: Any] = [
            "itemId": currentItemId,
            "fromPosition": from.isFinite ? max(0, from) : 0,
            "toPosition": to.isFinite ? max(0, to) : 0
        ]
        for (_, callback) in positionJumpCallbacks {
            callback.resolve(payload)
        }
    }

    @objc func onItemTransition(_ call: CAPPluginCall) {
        let callbackId = UUID().uuidString
        call.keepAlive = true
        onOwnerQueue {
            self.transitionCallbacks[callbackId] = call
            call.resolve([
                "callbackId": callbackId
            ])
        }
    }

    // MARK: - Queue building

    /// Normalised spec parsed off the JS bridge before AVFoundation
    /// objects are built. Keeps parsing isolated from playback wiring.
    private struct QueueItemSpec {
        let itemId: String
        let url: String
        let title: String
        let author: String
        let duration: Double?
    }

    private func parseQueueItem(_ raw: Any) -> QueueItemSpec? {
        guard let dict = raw as? [String: Any] else { return nil }
        guard let itemId = dict["itemId"] as? String,
              let url = dict["url"] as? String,
              !url.isEmpty else { return nil }
        let title = dict["title"] as? String ?? "Unknown Title"
        let author = dict["author"] as? String ?? "Unknown Artist"
        let duration = (dict["duration"] as? NSNumber)?.doubleValue
        return QueueItemSpec(itemId: itemId, url: url, title: title, author: author, duration: duration)
    }

    /// Tear down the existing AVQueuePlayer and build a fresh one from
    /// `items[startIndex...]`. The start item is seeked to `startPosition`
    /// (seconds); auto-advanced items always start at 0.
    ///
    /// `completion` runs on the owner queue once the new player is live (or
    /// once we know there will not be one) — exactly once, on every path.
    private func replaceQueue(
        with items: [QueueItemSpec],
        startIndex: Int,
        startPosition: Double,
        then completion: @escaping () -> Void
    ) {
        assertOwnerQueue()
        teardownPlayer()

        // Materialise entries from the start index onward.
        var newEntries: [QueueEntry] = []
        for spec in items[startIndex...] {
            guard let url = URL(string: spec.url) else { continue }
            newEntries.append(QueueEntry(
                itemId: spec.itemId,
                url: url,
                title: spec.title,
                author: spec.author,
                knownDuration: spec.duration
            ))
        }
        guard !newEntries.isEmpty else {
            completion()
            return
        }

        entries = newEntries
        queueIndex = 0
        failureRetries.removeAll()

        rebuildPlayer(seekFirstTo: startPosition, then: completion)
    }

    /// (Re)create the AVQueuePlayer from `entries[queueIndex...]`. Each
    /// item is built with its own stereo-mix tap (the tap + audioMix are
    /// per-AVPlayerItem). The first item is optionally seeked.
    ///
    /// Used both for a fresh setQueue and for skipToPrevious (which must
    /// rebuild because AVQueuePlayer is forward-only).
    ///
    /// The item that is about to play needs its audio mix BEFORE it starts —
    /// an audioMix attached to an already-playing item may never take effect —
    /// and building one needs the asset's track list, which for a lecture that
    /// isn't downloaded yet is a network fetch. That fetch used to run
    /// synchronously on the shared Capacitor bridge queue, stalling every other
    /// plugin call in the app (#1740); now it runs off-thread and the player is
    /// assembled when it lands.
    private func rebuildPlayer(seekFirstTo seekPosition: Double, then completion: (() -> Void)? = nil) {
        assertOwnerQueue()
        guard queueIndex >= 0, queueIndex < entries.count else {
            completion?()
            return
        }

        // Tear the old player down BEFORE building/swapping: removeTimeObserver
        // must be handed the player that owns the token, and releasing a player
        // that still owns a live periodic observer is undefined behaviour.
        teardownPlayer()

        rebuildGeneration += 1
        let generation = rebuildGeneration
        let firstEntry = entries[queueIndex]
        let firstAsset = AVURLAsset(url: firstEntry.url)

        stereoMixTap.loadAudioMix(for: firstAsset, priority: .now) { [weak self] mix in
            guard let self = self else { return }
            self.onOwnerQueue {
                defer { completion?() }
                // A newer rebuild already owns the engine — drop this result,
                // but still settle the call that asked for it.
                guard generation == self.rebuildGeneration else { return }
                self.settledGeneration = generation
                self.assemblePlayer(
                    firstItemId: firstEntry.itemId,
                    firstAsset: firstAsset,
                    firstMix: mix,
                    seekFirstTo: seekPosition
                )
            }
        }
    }

    /// Install the AVQueuePlayer for `entries[queueIndex...]`. Re-reads the
    /// queue rather than trusting a list captured before the asset load, so
    /// items appended while the rebuild was in flight are included.
    private func assemblePlayer(
        firstItemId: String,
        firstAsset: AVURLAsset,
        firstMix: AVAudioMix?,
        seekFirstTo seekPosition: Double
    ) {
        assertOwnerQueue()
        guard queueIndex >= 0, queueIndex < entries.count else { return }
        let pending = Array(entries[queueIndex...])
        guard let firstEntry = pending.first else { return }

        var avItems: [AVPlayerItem] = []
        if firstEntry.itemId == firstItemId {
            avItems.append(makePlayerItem(for: firstEntry, asset: firstAsset, audioMix: firstMix))
        } else {
            // The queue moved under the load (a skip landed elsewhere); build
            // the head like any other item.
            avItems.append(makePlayerItem(for: firstEntry))
        }
        for entry in pending.dropFirst() {
            avItems.append(makePlayerItem(for: entry))
        }
        guard let first = avItems.first else { return }

        let newPlayer = AVQueuePlayer(items: avItems)
        newPlayer.actionAtItemEnd = .advance
        player = newPlayer

        currentItemId = firstEntry.itemId
        fromPositionByItemId[currentItemId] = seekPosition > 0 ? seekPosition : 0
        fromAtByItemId[currentItemId] = nowEpochMs()

        observeCurrentItem()
        setupProgressObserver()

        // Seek the first item to the resume position before playing.
        if seekPosition > 0 {
            let time = CMTime(seconds: seekPosition, preferredTimescale: 1000)
            first.seek(to: time) { _ in }
        }

        updateNowPlayingInfo(for: firstEntry)
        updateRemoteSkipCommands()
        startPlaybackPersistTimer()

        performPlay()
    }

    /// Build an AVPlayerItem for an entry that is not about to play: its
    /// stereo-mix tap is attached when the asset's track list arrives, which is
    /// minutes before its turn comes round.
    private func makePlayerItem(for entry: QueueEntry) -> AVPlayerItem {
        assertOwnerQueue()
        let asset = AVURLAsset(url: entry.url)
        let item = makePlayerItem(for: entry, asset: asset, audioMix: nil)
        stereoMixTap.loadAudioMix(for: asset, priority: .ahead) { [weak self, weak item] mix in
            guard let self = self, let mix = mix else { return }
            self.onOwnerQueue {
                guard let item = item else { return }
                item.audioMix = mix
            }
        }
        return item
    }

    /// Build an AVPlayerItem with the given (already-built) audioMix and the
    /// time-domain pitch algorithm, wired with a status observer for failure
    /// handling. Records the item↔itemId mapping.
    private func makePlayerItem(for entry: QueueEntry, asset: AVURLAsset, audioMix: AVAudioMix?) -> AVPlayerItem {
        assertOwnerQueue()
        let item = AVPlayerItem(asset: asset)
        // The stereo-mix tap + audioMix are PER AVPlayerItem — attach a
        // fresh tap (pointed at the shared mix context) to every item so
        // a native advance keeps blending. nil for HLS/non-PCM sources →
        // passthrough.
        if let audioMix = audioMix {
            item.audioMix = audioMix
        }
        // Time-domain pitch algorithm preserves voice quality at non-1×
        // playback rates.
        item.audioTimePitchAlgorithm = .timeDomain

        itemIdByItem[ObjectIdentifier(item)] = entry.itemId
        observeItemStatus(item)
        return item
    }

    /// Append items to the tail of the live queue. Inserts each new
    /// AVPlayerItem after the current last one so AVQueuePlayer keeps
    /// auto-advancing into them.
    private func appendItems(_ items: [QueueItemSpec], then completion: @escaping () -> Void) {
        assertOwnerQueue()
        var newEntries: [QueueEntry] = []
        for spec in items {
            guard let url = URL(string: spec.url) else { continue }
            newEntries.append(QueueEntry(
                itemId: spec.itemId,
                url: url,
                title: spec.title,
                author: spec.author,
                knownDuration: spec.duration
            ))
        }
        guard !newEntries.isEmpty else {
            completion()
            return
        }

        // A rebuild is between teardown and assembly: it reads `entries` when
        // it installs the player, so appending is all that is needed — and
        // starting a second rebuild here would fight it for the engine.
        if rebuildInFlight {
            entries.append(contentsOf: newEntries)
            completion()
            return
        }

        // If there's no live player (queue ran dry), this becomes a fresh
        // queue starting at the appended items.
        guard let player = player, !entries.isEmpty else {
            entries.append(contentsOf: newEntries)
            queueIndex = max(0, entries.count - newEntries.count)
            rebuildPlayer(seekFirstTo: 0, then: completion)
            return
        }

        entries.append(contentsOf: newEntries)
        // Insert at the tail. AVQueuePlayer.insert(after: nil) appends at
        // the end of the queue.
        for entry in newEntries {
            let item = makePlayerItem(for: entry)
            if player.canInsert(item, after: nil) {
                player.insert(item, after: nil)
            }
        }
        updateRemoteSkipCommands()
        completion()
    }

    private func currentEntry() -> QueueEntry? {
        assertOwnerQueue()
        guard queueIndex >= 0, queueIndex < entries.count else { return nil }
        return entries[queueIndex]
    }

    // MARK: - currentItem KVO (native advance detection)

    /// Observe AVQueuePlayer.currentItem so every native advance re-applies
    /// the per-item rate, refreshes now-playing, and updates our index.
    /// The transition is journaled by the end/skip handlers, not here —
    /// this observer only re-binds player-side state to the new item.
    private func observeCurrentItem() {
        assertOwnerQueue()
        currentItemObservation?.invalidate()
        currentItemObservation = player?.observe(\.currentItem, options: [.new]) { [weak self] _, _ in
            // KVO arrives on whatever queue AVFoundation felt like using.
            self?.onOwnerQueue { self?.handleCurrentItemChange() }
        }
    }

    private func handleCurrentItemChange() {
        assertOwnerQueue()
        guard let player = player else { return }
        guard let item = player.currentItem else {
            // Queue ran dry. The end/skip handler already journaled the
            // final transition (startedItemId == null) before we got here.
            return
        }
        let newId = itemIdByItem[ObjectIdentifier(item)] ?? ""

        // Sync our index to the entry that just became current.
        if let idx = entries.firstIndex(where: { $0.itemId == newId }) {
            queueIndex = idx
        }
        currentItemId = newId
        // Auto-advanced items always start at 0. Only set if not already
        // recorded (a rebuild/seek path may have set a resume position).
        if fromPositionByItemId[newId] == nil {
            fromPositionByItemId[newId] = 0
        }
        if fromAtByItemId[newId] == nil {
            fromAtByItemId[newId] = nowEpochMs()
        }

        // Per-item rate must be re-applied on every advance (rate lives
        // on the player but is reset to 1 by AVQueuePlayer on advance).
        if player.rate != 0 {
            player.rate = targetPlaybackRate
        }

        if let entry = currentEntry() {
            updateNowPlayingInfo(for: entry)
        }
        updateRemoteSkipCommands()
        // Snapshot the new current item immediately.
        journal.savePosition(itemId: newId.isEmpty ? nil : newId, positionSec: 0)
    }

    // MARK: - Item status / failure observation

    private func observeItemStatus(_ item: AVPlayerItem) {
        assertOwnerQueue()
        let observation = item.observe(\.status, options: [.new]) { [weak self] observedItem, _ in
            guard let self = self else { return }
            self.onOwnerQueue { [weak self] in
                guard let self = self else { return }
                switch observedItem.status {
                case .readyToPlay:
                    // Refresh duration in now-playing once it's known, but
                    // only for the item that is actually current.
                    if observedItem === self.player?.currentItem,
                       let entry = self.currentEntry() {
                        self.updateNowPlayingInfo(for: entry)
                    }
                case .failed:
                    self.handleItemFailure(observedItem)
                default:
                    break
                }
            }
        }
        itemStatusObservations[ObjectIdentifier(item)] = observation
    }

    /// A queued item failed to load/play. Journal a partial (reason
    /// "error") and advance past it so one bad download can't stall the
    /// whole background queue. Bounded retries guard against a run of
    /// bad items looping.
    private func handleItemFailure(_ item: AVPlayerItem) {
        assertOwnerQueue()
        guard item === player?.currentItem else { return }
        let failedId = itemIdByItem[ObjectIdentifier(item)] ?? currentItemId

        // Both the .failed KVO and AVPlayerItemFailedToPlayToEndTime can
        // fire for the same item; only act once per failed item (bounded
        // by maxFailureRetries) so we don't double-journal / double-skip.
        let retries = failureRetries[failedId] ?? 0
        guard retries < maxFailureRetries else { return }
        failureRetries[failedId] = retries + 1

        // Advance, journaling the failed item as an error partial.
        advanceWithJournal(reason: "error",
                           finishedAt: player?.currentTime().seconds ?? 0)
    }

    // MARK: - Advance / skip

    /// Skip to the next item (lock-screen next or in-app skip). Returns
    /// false when there's nothing to advance to.
    @discardableResult
    private func advanceToNext(reason: String) -> Bool {
        assertOwnerQueue()
        guard player != nil, currentEntry() != nil else { return false }
        // Nothing to advance into: advancing anyway empties the AVQueuePlayer
        // and JS is never told playback stopped (#1626). Same guard Android
        // gets from `hasNextMediaItem()`.
        guard PlaybackPolicy.hasNext(queueIndex: queueIndex, entryCount: entries.count) else {
            return false
        }
        let pos = player?.currentTime().seconds ?? 0
        advanceWithJournal(reason: reason, finishedAt: pos)
        return true
    }

    /// Common advance path for skip-next / error: journal the finished
    /// item, then tell AVQueuePlayer to advance. The currentItem KVO does
    /// the player-side re-bind.
    private func advanceWithJournal(reason: String, finishedAt: Double) {
        assertOwnerQueue()
        let finished = currentEntry()
        let nextEntry = (queueIndex + 1 < entries.count) ? entries[queueIndex + 1] : nil
        journalTransition(
            finished: finished,
            finishedAt: finishedAt,
            startedItemId: nextEntry?.itemId,
            reason: reason
        )
        // advanceToNextItem() pops the current item; the KVO fires with
        // the new currentItem (or nil when the queue is exhausted).
        player?.advanceToNextItem()
    }

    /// Skip to the previous item. AVQueuePlayer is forward-only, so we
    /// rebuild the queue from the previous index. Returns false at the
    /// head of the queue.
    @discardableResult
    private func goToPrevious() -> Bool {
        assertOwnerQueue()
        guard !entries.isEmpty else { return false }
        let pos = player?.currentTime().seconds ?? 0

        // If we're a few seconds in, "previous" restarts the current item
        // (matching common player UX). Otherwise step back one entry.
        if pos > 3 {
            player?.seek(to: .zero)
            // A rewind the ENGINE performed is a discontinuity like any other:
            // without the jump the open listening session keeps its old
            // `from_position` and a re-listen credits nothing (#1740).
            pushPositionJump(from: pos, to: 0)
            fromPositionByItemId[currentItemId] = 0
            fromAtByItemId[currentItemId] = nowEpochMs()
            return true
        }
        guard queueIndex > 0 else {
            player?.seek(to: .zero)
            if pos > 0 {
                pushPositionJump(from: pos, to: 0)
                fromPositionByItemId[currentItemId] = 0
                fromAtByItemId[currentItemId] = nowEpochMs()
            }
            return true
        }

        let finished = currentEntry()
        let prevIndex = queueIndex - 1
        journalTransition(
            finished: finished,
            finishedAt: pos,
            startedItemId: entries[prevIndex].itemId,
            reason: "skip-prev"
        )

        // Rebuild from the previous entry onward.
        queueIndex = prevIndex
        rebuildPlayer(seekFirstTo: 0)
        return true
    }

    // MARK: - Journaling

    private func nowEpochMs() -> Double {
        return Date().timeIntervalSince1970 * 1000
    }

    private func journalTransition(finished: QueueEntry?, finishedAt: Double, startedItemId: String?, reason: String) {
        assertOwnerQueue()
        guard let finished = finished else { return }
        let durationSec = resolvedDuration(for: finished)
        let transition = QueueTransition(
            finishedItemId: finished.itemId,
            fromPosition: fromPositionByItemId[finished.itemId] ?? 0,
            finishedAt: finishedAt.isFinite ? finishedAt : durationSec,
            duration: durationSec,
            startedItemId: startedItemId,
            reason: reason,
            at: nowEpochMs(),
            fromAt: fromAtByItemId[finished.itemId],
            seq: journal.nextSeq()
        )
        // Durable append happens BEFORE anything else (e.g. teardown).
        journal.append(transition)
        // Best-effort foreground push — UI sugar only.
        pushTransition(transition)
        // The finished item's resume point is no longer needed.
        fromPositionByItemId.removeValue(forKey: finished.itemId)
        fromAtByItemId.removeValue(forKey: finished.itemId)
    }

    /// Best duration we can report for a finished item: the live
    /// AVPlayerItem duration if known, else the JS-supplied duration.
    private func resolvedDuration(for entry: QueueEntry) -> Double {
        assertOwnerQueue()
        if let item = player?.currentItem,
           itemIdByItem[ObjectIdentifier(item)] == entry.itemId,
           !item.duration.isIndefinite {
            return item.duration.seconds
        }
        return entry.knownDuration ?? 0
    }

    private func pushTransition(_ transition: QueueTransition) {
        assertOwnerQueue()
        let payload = transition.toDictionary()
        for (_, callback) in transitionCallbacks {
            callback.resolve(payload)
        }
    }

    // MARK: - Natural end / failure notifications

    @objc func playerItemDidReachEnd(notification: Notification) {
        guard let endedItem = notification.object as? AVPlayerItem else { return }
        onOwnerQueue { [weak self] in
            self?.handleItemDidReachEnd(endedItem)
        }
    }

    private func handleItemDidReachEnd(_ endedItem: AVPlayerItem) {
        assertOwnerQueue()
        let endedId = itemIdByItem[ObjectIdentifier(endedItem)]
        // Only journal an "auto" completion for an item we actually own.
        guard let endedId = endedId,
              let finished = entries.first(where: { $0.itemId == endedId }) else {
            updatePlaybackInfo()
            return
        }

        // The next entry (if any) is what AVQueuePlayer will advance to.
        let finishedIndex = entries.firstIndex(where: { $0.itemId == endedId }) ?? queueIndex
        let nextEntry = (finishedIndex + 1 < entries.count) ? entries[finishedIndex + 1] : nil

        let durationSec = !endedItem.duration.isIndefinite
            ? endedItem.duration.seconds
            : (finished.knownDuration ?? 0)

        let transition = QueueTransition(
            finishedItemId: endedId,
            fromPosition: fromPositionByItemId[endedId] ?? 0,
            finishedAt: durationSec,           // natural end ⇒ finishedAt == duration
            duration: durationSec,
            startedItemId: nextEntry?.itemId,  // null when queue runs dry
            reason: "auto",
            at: nowEpochMs(),
            fromAt: fromAtByItemId[endedId],
            seq: journal.nextSeq()
        )
        // Persist BEFORE anything else, including teardown when dry.
        journal.append(transition)
        pushTransition(transition)
        fromPositionByItemId.removeValue(forKey: endedId)
        fromAtByItemId.removeValue(forKey: endedId)

        if nextEntry == nil {
            // Queue exhausted — persist the final journal entry (done
            // above) before stopping.
            stopPlaybackPersistTimer()
            currentItemId = ""
            journal.savePosition(itemId: nil, positionSec: durationSec)
            // Nothing is loaded any more, so the lock-screen transport must go
            // with it: a live "previous" here journals a skip-prev for a
            // lecture that already finished and starts the one before it with
            // no in-app player to show for it (#1740).
            updateRemoteSkipCommands()
        }
        updatePlaybackInfo()
        notifyProgressCompleted(itemId: endedId, duration: durationSec)
    }

    @objc func playerItemFailedToReachEnd(notification: Notification) {
        guard let failedItem = notification.object as? AVPlayerItem else { return }
        onOwnerQueue { [weak self] in
            self?.handleItemFailure(failedItem)
        }
    }

    // MARK: - Playback controls

    @objc func play(_ call: CAPPluginCall) {
        onOwnerQueue {
            self.performPlay()
            call.resolve()
        }
    }

    private func performPlay() {
        assertOwnerQueue()
        // Nothing loaded — a remote/headset play command arriving after
        // `stop()` must not arm the persist timer for an engine with no item.
        guard let player = player else { return }
        if !hasLiveItem {
            replayFinishedEntry()
            return
        }
        player.play()
        if player.rate != 0 {
            player.rate = targetPlaybackRate
        }
        updatePlaybackInfo()
        startPlaybackPersistTimer()
    }

    /// Restart the entry the playhead ended on.
    ///
    /// `handleItemDidReachEnd` leaves the player alive with `currentItemId`
    /// cleared when the queue runs dry, and an AVQueuePlayer that has consumed
    /// its items cannot be started again — `play()` returns with the rate still
    /// 0, so replaying the lecture that just finished was a dead tap from its
    /// row and from the mini-player button alike (#1793). Only a fresh player
    /// plays; `rebuildPlayer` builds one from `queueIndex`, which still points
    /// at the finished entry, and `assemblePlayer` starts it.
    private func replayFinishedEntry() {
        assertOwnerQueue()
        guard currentEntry() != nil else { return }
        rebuildPlayer(seekFirstTo: 0)
    }

    @objc func togglePause(_ call: CAPPluginCall) {
        onOwnerQueue {
            self.performTogglePause()
            call.resolve()
        }
    }

    private func performTogglePause() {
        assertOwnerQueue()
        guard let player = player else { return }
        // Same dry-queue recovery as `performPlay`: the mini-player's button
        // toggles, and toggling an itemless player is what made replaying a
        // finished lecture inert (#1793).
        if !hasLiveItem {
            replayFinishedEntry()
            return
        }
        if player.rate != 0 {
            player.pause()
            // Snapshot position on pause (event-driven persistence).
            persistCurrentPosition()
        } else {
            player.play()
            player.rate = targetPlaybackRate
        }
        updatePlaybackInfo()
    }

    @objc func seek(_ call: CAPPluginCall) {
        guard let position = call.getDouble("position") else {
            call.reject("Position parameter is required")
            return
        }
        let target = position.isFinite ? max(0, position) : 0
        onOwnerQueue {
            // No engine to seek — resolve instead of leaving the JS promise
            // pending forever. `replaceQueue` can legitimately end up with no
            // player (every item had an unparseable URL), and the app seeks to
            // its resume position right after `open()` resolves, so this is
            // reachable and used to wedge playback with no error (#1740).
            // `seekBy` has always guarded it.
            guard let player = self.player else {
                call.resolve()
                return
            }
            let time = CMTime(seconds: target, preferredTimescale: 1000)
            player.seek(to: time) { [weak self] finished in
                guard finished else {
                    call.reject("Seek operation failed")
                    return
                }
                self?.onOwnerQueue {
                    self?.updatePlaybackInfo()
                    self?.persistCurrentPosition()
                    call.resolve()
                }
            }
        }
    }

    /// Tear the engine down for good — not a pause-and-rewind. Both callers
    /// are destructive (clear user data / delete account, and database
    /// import), so nothing may survive that could put the old lecture back on
    /// the lock screen: a paused AVQueuePlayer with a live now-playing entry
    /// is still a playable track for an account that no longer exists (#1728).
    /// Counterpart of Android's `controller.stop() + clearMediaItems()`.
    ///
    /// JS journals the final position itself (`finishCurrent`) before calling
    /// this, so there is nothing left worth snapshotting here.
    @objc func stop(_ call: CAPPluginCall) {
        onOwnerQueue {
            self.teardownPlayer()
            self.entries.removeAll()
            self.queueIndex = 0
            self.currentItemId = ""
            self.fromPositionByItemId.removeAll()
            self.fromAtByItemId.removeAll()
            self.failureRetries.removeAll()
            self.wasPlayingBeforeInterruption = false
            // Drop the in-flight snapshot the way the queue-ran-dry path does: it
            // names an item that is about to be deleted (wipe) or replaced
            // (import). The transition journal itself is deliberately left alone —
            // only `ackEvents` retires those, and after an import JS reloads and
            // still has to drain the listening events recorded before it.
            self.journal.savePosition(itemId: nil, positionSec: 0)
            self.updateRemoteSkipCommands()
            self.clearNowPlayingInfo()
            call.resolve()
        }
    }

    /// Relative seek by `delta` seconds, clamped to [0, duration].
    @objc func seekBy(_ call: CAPPluginCall) {
        guard let delta = call.getDouble("delta") else {
            call.reject("Argument 'delta' is required")
            return
        }
        onOwnerQueue {
            guard let player = self.player, let item = player.currentItem else {
                call.resolve()
                return
            }
            let current = player.currentTime().seconds
            let durationSec = item.duration.isIndefinite ? Double.greatestFiniteMagnitude : item.duration.seconds
            let next = max(0, min(durationSec, current + delta))
            let newTime = CMTime(seconds: next, preferredTimescale: 1000)
            player.seek(to: newTime) { [weak self] finished in
                guard finished else {
                    call.reject("Seek operation failed")
                    return
                }
                self?.onOwnerQueue {
                    self?.updatePlaybackInfo()
                    self?.persistCurrentPosition()
                    call.resolve()
                }
            }
        }
    }

    /// Apply a ±N s jump the SYSTEM asked for (lock screen, car head unit),
    /// clamped to the item, and report it as a position jump.
    private func seekRelativeFromRemote(delta: Double) {
        assertOwnerQueue()
        guard let player = player, let item = player.currentItem else { return }
        let from = player.currentTime().seconds
        guard from.isFinite else { return }
        let durationSec = item.duration.isIndefinite ? Double.greatestFiniteMagnitude : item.duration.seconds
        let target = max(0, min(durationSec.isFinite ? durationSec : Double.greatestFiniteMagnitude, from + delta))
        seekFromRemote(to: target, from: from)
    }

    private func seekFromRemote(to target: Double, from: Double) {
        assertOwnerQueue()
        guard let player = player, target.isFinite else { return }
        // Millisecond timescale: `preferredTimescale: 1` truncated every remote
        // seek to a whole second (#1740).
        player.seek(to: CMTime(seconds: target, preferredTimescale: 1000))
        pushPositionJump(from: from, to: target)
    }

    /// Set playback rate. Cached in `targetPlaybackRate` so a
    /// `setPlaybackRate(2)` during pause doesn't accidentally resume
    /// playback.
    @objc func setPlaybackRate(_ call: CAPPluginCall) {
        var rate = Float(call.getDouble("rate") ?? 1.0)
        if !rate.isFinite { rate = 1.0 }
        if rate < 0.5 { rate = 0.5 }
        if rate > 2.0 { rate = 2.0 }
        let target = rate
        onOwnerQueue {
            self.targetPlaybackRate = target
            if let player = self.player, player.rate != 0 {
                player.rate = target
            }
            call.resolve()
        }
    }

    /// Forward the slider state to the MTAudioProcessingTap context. One
    /// context is shared by every tap, so this takes effect on whatever
    /// AVPlayerItem is in flight without rebuilding the player.
    @objc func setMix(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? false
        let ratio = Float(call.getDouble("ratio") ?? 0.5)
        onOwnerQueue {
            self.stereoMixTap.setMix(enabled: enabled, ratio: ratio)
            call.resolve()
        }
    }

    // MARK: - Progress callbacks

    @objc func onProgressChanged(_ call: CAPPluginCall) {
        let callbackId = UUID().uuidString
        call.keepAlive = true
        onOwnerQueue {
            self.statusCallbacks[callbackId] = call
            call.resolve([
                "callbackId": callbackId
            ])
        }
    }

    private func notifyProgressChanged() {
        assertOwnerQueue()
        guard let player = player, let currentItem = player.currentItem else {
            return
        }
        if currentItem.duration.isIndefinite {
            return
        }
        let position = player.currentTime().seconds
        let duration = currentItem.duration.isIndefinite ? 0 : currentItem.duration.seconds
        let playing = player.rate != 0

        let status: [String: Any] = [
            "position": position,
            "playing": playing,
            "duration": duration,
            "itemId": currentItemId
        ]
        for (_, callback) in statusCallbacks {
            callback.resolve(status)
        }
    }

    private func notifyProgressCompleted(itemId: String, duration: Double) {
        assertOwnerQueue()
        let status: [String: Any] = [
            "position": duration,
            "playing": false,
            "duration": duration,
            "itemId": itemId
        ]
        for (_, callback) in statusCallbacks {
            callback.resolve(status)
        }
    }

    // MARK: - Now playing

    /// App icon, loaded once and reused as the lock-screen / Control Center
    /// artwork for every track. The icon lives only in the asset catalog,
    /// which `UIImage(named:)` can't address directly — its real filename is
    /// listed under CFBundleIcons in Info.plist, so we resolve that first.
    ///
    /// A `lazy var` is not thread-safe; like everything else here it is only
    /// ever touched on the owner queue.
    private lazy var nowPlayingArtwork: MPMediaItemArtwork? = {
        guard let icons = Bundle.main.infoDictionary?["CFBundleIcons"] as? [String: Any],
              let primary = icons["CFBundlePrimaryIcon"] as? [String: Any],
              let files = primary["CFBundleIconFiles"] as? [String],
              let lastName = files.last,
              let icon = UIImage(named: lastName) else {
            return nil
        }
        return MPMediaItemArtwork(boundsSize: icon.size) { _ in icon }
    }()

    private func updateNowPlayingInfo(for entry: QueueEntry) {
        assertOwnerQueue()
        var duration: TimeInterval = 0
        if let currentItem = player?.currentItem, !currentItem.duration.isIndefinite {
            duration = CMTimeGetSeconds(currentItem.duration)
        } else if let known = entry.knownDuration {
            duration = known
        }

        let elapsed = player?.currentTime().seconds ?? 0
        var nowPlayingInfo: [String: Any] = [
            MPMediaItemPropertyTitle: entry.title,
            MPMediaItemPropertyArtist: entry.author,
            MPMediaItemPropertyPlaybackDuration: duration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: elapsed.isFinite ? elapsed : 0,
            MPNowPlayingInfoPropertyPlaybackRate: player?.rate ?? 0
        ]
        if let artwork = nowPlayingArtwork {
            nowPlayingInfo[MPMediaItemPropertyArtwork] = artwork
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlayingInfo
    }

    /// Dismiss the lock-screen / Control Center transport entirely. Assigning
    /// `nil` is the only thing that removes us from the now-playing surface;
    /// a stale dictionary keeps a live play button for a track we no longer
    /// hold. Deliberately NOT part of `teardownPlayer()`, which also runs
    /// between queue rebuilds (skipToPrevious, refill of a dry queue) where
    /// blanking the now-playing UI would flicker mid-playback.
    private func clearNowPlayingInfo() {
        assertOwnerQueue()
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    private func updatePlaybackInfo() {
        assertOwnerQueue()
        guard let player = player, var nowPlayingInfo = MPNowPlayingInfoCenter.default().nowPlayingInfo else {
            return
        }
        nowPlayingInfo[MPNowPlayingInfoPropertyElapsedPlaybackTime] = player.currentTime().seconds
        nowPlayingInfo[MPNowPlayingInfoPropertyPlaybackRate] = player.rate
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlayingInfo
    }

    // MARK: - Progress observer

    private func setupProgressObserver() {
        assertOwnerQueue()
        removeProgressObserver()
        // Adaptive cadence (#828): fast for transcript highlighting, slower
        // for the floating player, a heartbeat when backgrounded.
        //
        // `queue: .main` IS the owner queue, so this block reads the state
        // directly instead of hopping.
        let interval = CMTime(seconds: progressIntervalSec, preferredTimescale: CMTimeScale(NSEC_PER_SEC))
        progressObserver = player?.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self] _ in
            self?.updatePlaybackInfo()
            self?.notifyProgressChanged()
        }
        progressObserverPlayer = progressObserver != nil ? player : nil
    }

    /// Change how often progress is pushed to the WebView. The lock-screen
    /// Now Playing info interpolates position from the reported rate, so it
    /// stays smooth regardless of this cadence.
    @objc func setProgressInterval(_ call: CAPPluginCall) {
        let ms = call.getDouble("intervalMs") ?? 1000
        var sec = ms / 1000.0
        if !sec.isFinite || sec <= 0 { sec = 1.0 }
        if sec < 0.25 { sec = 0.25 }
        let interval = sec
        onOwnerQueue {
            if interval != self.progressIntervalSec {
                self.progressIntervalSec = interval
                // Rebuild the observer at the new cadence if one is active.
                if self.progressObserver != nil {
                    self.setupProgressObserver()
                }
            }
            call.resolve()
        }
    }

    /// No owner-queue assertion: `teardownPlayer` reaches this from `deinit`,
    /// which runs wherever the last reference happened to be dropped.
    private func removeProgressObserver() {
        if let observer = progressObserver, let owner = progressObserverPlayer {
            owner.removeTimeObserver(observer)
        }
        progressObserver = nil
        progressObserverPlayer = nil
    }

    // MARK: - Durable position persistence

    private func startPlaybackPersistTimer() {
        assertOwnerQueue()
        stopPlaybackPersistTimer()
        // Coarse safety interval — exactness isn't important (§3.4). Fires on
        // the main run loop, which is the owner queue.
        let timer = Timer(timeInterval: positionPersistInterval, repeats: true) { [weak self] _ in
            self?.persistCurrentPosition()
        }
        RunLoop.main.add(timer, forMode: .common)
        positionPersistTimer = timer
    }

    private func stopPlaybackPersistTimer() {
        positionPersistTimer?.invalidate()
        positionPersistTimer = nil
    }

    private func persistCurrentPosition() {
        assertOwnerQueue()
        guard let player = player else { return }
        let pos = player.currentTime().seconds
        journal.savePosition(
            itemId: currentItemId.isEmpty ? nil : currentItemId,
            positionSec: pos.isFinite ? pos : 0
        )
    }

    // MARK: - Teardown

    /// Tear down all observers + the live player without touching the
    /// durable journal (the journal outlives players, by design).
    private func teardownPlayer() {
        stopPlaybackPersistTimer()
        removeProgressObserver()
        currentItemObservation?.invalidate()
        currentItemObservation = nil
        for (_, observation) in itemStatusObservations {
            observation.invalidate()
        }
        itemStatusObservations.removeAll()
        itemIdByItem.removeAll()
        player?.pause()
        player?.removeAllItems()
        player = nil
    }

    /// The one place that touches state off the owner queue — and the only one
    /// where that is safe: `deinit` runs when the last reference is gone, so
    /// nothing else can be holding this object while it runs.
    deinit {
        teardownPlayer()
        NotificationCenter.default.removeObserver(self)
    }
}
