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

    /// Whether playback was running when an audio-session interruption
    /// began, so `.ended` doesn't start a lecture the user had paused.
    private var wasPlayingBeforeInterruption = false

    /// Coarse safety timer that snapshots the in-flight position to disk
    /// (~30 s) while playing, so a hard background kill loses at most that
    /// much resume accuracy (§3.4).
    private var positionPersistTimer: Timer?
    private let positionPersistInterval: TimeInterval = 30

    override public func load() {
        // Setup audio session for background playback
        setupAudioSession()

        // Setup remote control and now playing info
        setupRemoteTransportControls()

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

    private func setupRemoteTransportControls() {
        // Get the shared command center
        let commandCenter = MPRemoteCommandCenter.shared()

        // Add handlers for play, pause, etc.
        commandCenter.playCommand.addTarget { [weak self] _ in
            self?.play()
            return .success
        }

        commandCenter.pauseCommand.addTarget { [weak self] _ in
            self?.togglePause()
            return .success
        }

        // Lock-screen next/previous drive the native queue skips so the
        // background advance + journaling go through one path. Both are
        // disabled until a queue with somewhere to go is loaded.
        commandCenter.nextTrackCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            return self.advanceToNext(reason: "skip-next") ? .success : .noSuchContent
        }

        commandCenter.previousTrackCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            return self.goToPrevious() ? .success : .noSuchContent
        }

        updateRemoteSkipCommands()

        commandCenter.seekForwardCommand.addTarget { [weak self] event in
            if let seekEvent = event as? MPSeekCommandEvent, let player = self?.player {
                let from = player.currentTime().seconds
                let newTime = CMTime(seconds: from + Double(seekEvent.type.rawValue * 30), preferredTimescale: 1)
                player.seek(to: newTime)
                self?.pushPositionJump(from: from, to: newTime.seconds)
                return .success
            }
            return .commandFailed
        }

        commandCenter.seekBackwardCommand.addTarget { [weak self] event in
            if let seekEvent = event as? MPSeekCommandEvent, let player = self?.player {
                let from = player.currentTime().seconds
                let newTime = CMTime(seconds: max(from - Double(seekEvent.type.rawValue * 30), 0), preferredTimescale: 1)
                player.seek(to: newTime)
                self?.pushPositionJump(from: from, to: newTime.seconds)
                return .success
            }
            return .commandFailed
        }

        commandCenter.changePlaybackPositionCommand.addTarget { [weak self] event in
            if let changeEvent = event as? MPChangePlaybackPositionCommandEvent, let player = self?.player {
                let from = player.currentTime().seconds
                let newTime = CMTime(seconds: changeEvent.positionTime, preferredTimescale: 1)
                player.seek(to: newTime)
                self?.pushPositionJump(from: from, to: newTime.seconds)
                return .success
            }
            return .commandFailed
        }
    }

    /// Keep the remote skip buttons in step with the live queue. iOS shows
    /// (and honours, from a car or headset) whatever is enabled here, so a
    /// one-item queue must not expose them — advancing would empty the
    /// AVQueuePlayer. Android gets this from the Media3 timeline.
    private func updateRemoteSkipCommands() {
        let commandCenter = MPRemoteCommandCenter.shared()
        commandCenter.nextTrackCommand.isEnabled = PlaybackPolicy.remoteNextEnabled(
            queueIndex: queueIndex,
            entryCount: entries.count
        )
        commandCenter.previousTrackCommand.isEnabled = PlaybackPolicy.remotePreviousEnabled(
            entryCount: entries.count
        )
    }

    @objc func handleInterruption(notification: Notification) {
        guard let info = notification.userInfo,
              let typeValue = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else {
            return
        }

        switch type {
        case .began:
            wasPlayingBeforeInterruption = (player?.rate ?? 0) != 0
            if wasPlayingBeforeInterruption {
                togglePause()
            }
        case .ended:
            // Our session is never deactivated, so iOS offers `.shouldResume`
            // even for a lecture the user had paused before the call arrived.
            let optionsValue = info[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue)
            if PlaybackPolicy.shouldResumeAfterInterruption(
                wasPlaying: wasPlayingBeforeInterruption,
                systemSuggestsResume: options.contains(.shouldResume)
            ) {
                play()
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
        if reason == .oldDeviceUnavailable {
            if player?.rate != 0 {
                togglePause()
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
        replaceQueue(with: [item], startIndex: 0, startPosition: 0)
        call.resolve()
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
        replaceQueue(with: items, startIndex: max(0, min(startIndex, items.count - 1)), startPosition: startPosition)
        call.resolve()
    }

    @objc func appendToQueue(_ call: CAPPluginCall) {
        let rawItems = call.getArray("items") ?? []
        let items = rawItems.compactMap { parseQueueItem($0) }
        guard !items.isEmpty else {
            call.resolve()
            return
        }
        appendItems(items)
        call.resolve()
    }

    @objc func getQueueState(_ call: CAPPluginCall) {
        let events = journal.allTransitions().map { $0.toDictionary() }
        let position = player?.currentTime().seconds ?? 0
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
        let currentId: Any = currentItemId.isEmpty ? NSNull() : currentItemId

        call.resolve([
            "currentItemId": player?.currentItem == nil ? NSNull() : currentId,
            "position": position.isFinite ? position : 0,
            "duration": duration.isFinite ? duration : 0,
            "playing": playing,
            "events": events
        ])
    }

    @objc func ackEvents(_ call: CAPPluginCall) {
        let upToSeq = call.getInt("upToSeq") ?? 0
        journal.ack(upToSeq: upToSeq)
        call.resolve()
    }

    @objc func skipToNext(_ call: CAPPluginCall) {
        _ = advanceToNext(reason: "skip-next")
        call.resolve()
    }

    @objc func skipToPrevious(_ call: CAPPluginCall) {
        _ = goToPrevious()
        call.resolve()
    }

    @objc func onPositionJump(_ call: CAPPluginCall) {
        let callbackId = UUID().uuidString
        positionJumpCallbacks[callbackId] = call
        call.keepAlive = true
        call.resolve([
            "callbackId": callbackId
        ])
    }

    /// Report a jump the system made to JS, so it closes the open listening
    /// session at `from` instead of absorbing the skipped span into it.
    private func pushPositionJump(from: Double, to: Double) {
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
        transitionCallbacks[callbackId] = call
        call.keepAlive = true
        call.resolve([
            "callbackId": callbackId
        ])
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
    private func replaceQueue(with items: [QueueItemSpec], startIndex: Int, startPosition: Double) {
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
        guard !newEntries.isEmpty else { return }

        entries = newEntries
        queueIndex = 0
        failureRetries.removeAll()

        rebuildPlayer(seekFirstTo: startPosition)
    }

    /// (Re)create the AVQueuePlayer from `entries[queueIndex...]`. Each
    /// item is built with its own stereo-mix tap (the tap + audioMix are
    /// per-AVPlayerItem). The first item is optionally seeked.
    ///
    /// Used both for a fresh setQueue and for skipToPrevious (which must
    /// rebuild because AVQueuePlayer is forward-only).
    private func rebuildPlayer(seekFirstTo seekPosition: Double) {
        guard queueIndex >= 0, queueIndex < entries.count else { return }

        // Tear the old player down BEFORE building/swapping: removeTimeObserver
        // must be handed the player that owns the token, and releasing a player
        // that still owns a live periodic observer is undefined behaviour.
        teardownPlayer()

        // Build AVPlayerItems for the remaining entries.
        var avItems: [AVPlayerItem] = []
        for entry in entries[queueIndex...] {
            avItems.append(makePlayerItem(for: entry))
        }
        guard let first = avItems.first else { return }

        let newPlayer = AVQueuePlayer(items: avItems)
        newPlayer.actionAtItemEnd = .advance
        player = newPlayer

        currentItemId = entries[queueIndex].itemId
        fromPositionByItemId[currentItemId] = seekPosition > 0 ? seekPosition : 0
        fromAtByItemId[currentItemId] = nowEpochMs()

        observeCurrentItem()
        setupProgressObserver()

        // Seek the first item to the resume position before playing.
        if seekPosition > 0 {
            let time = CMTime(seconds: seekPosition, preferredTimescale: 1000)
            first.seek(to: time) { _ in }
        }

        updateNowPlayingInfo(for: entries[queueIndex])
        updateRemoteSkipCommands()
        startPlaybackPersistTimer()

        play()
    }

    /// Build an AVPlayerItem with the per-item stereo-mix audioMix and
    /// time-domain pitch algorithm, wired with a status observer for
    /// failure handling. Records the item↔itemId mapping.
    private func makePlayerItem(for entry: QueueEntry) -> AVPlayerItem {
        let asset = AVURLAsset(url: entry.url)
        let item = AVPlayerItem(asset: asset)
        // The stereo-mix tap + audioMix are PER AVPlayerItem — attach a
        // fresh tap (pointed at the shared mix context) to every item so
        // a native advance keeps blending. nil for HLS/non-PCM sources →
        // passthrough.
        if let audioMix = stereoMixTap.makeAudioMix(for: asset) {
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
    private func appendItems(_ items: [QueueItemSpec]) {
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
        guard !newEntries.isEmpty else { return }

        // If there's no live player (queue ran dry), this becomes a fresh
        // queue starting at the appended items.
        guard let player = player, !entries.isEmpty else {
            entries.append(contentsOf: newEntries)
            queueIndex = max(0, entries.count - newEntries.count)
            rebuildPlayer(seekFirstTo: 0)
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
    }

    private func currentEntry() -> QueueEntry? {
        guard queueIndex >= 0, queueIndex < entries.count else { return nil }
        return entries[queueIndex]
    }

    // MARK: - currentItem KVO (native advance detection)

    /// Observe AVQueuePlayer.currentItem so every native advance re-applies
    /// the per-item rate, refreshes now-playing, and updates our index.
    /// The transition is journaled by the end/skip handlers, not here —
    /// this observer only re-binds player-side state to the new item.
    private func observeCurrentItem() {
        currentItemObservation?.invalidate()
        currentItemObservation = player?.observe(\.currentItem, options: [.new]) { [weak self] _, _ in
            self?.handleCurrentItemChange()
        }
    }

    private func handleCurrentItemChange() {
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
        let observation = item.observe(\.status, options: [.new]) { [weak self] observedItem, _ in
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
        itemStatusObservations[ObjectIdentifier(item)] = observation
    }

    /// A queued item failed to load/play. Journal a partial (reason
    /// "error") and advance past it so one bad download can't stall the
    /// whole background queue. Bounded retries guard against a run of
    /// bad items looping.
    private func handleItemFailure(_ item: AVPlayerItem) {
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
        guard !entries.isEmpty else { return false }
        let pos = player?.currentTime().seconds ?? 0

        // If we're a few seconds in, "previous" restarts the current item
        // (matching common player UX). Otherwise step back one entry.
        if pos > 3 {
            player?.seek(to: .zero)
            fromPositionByItemId[currentItemId] = 0
            fromAtByItemId[currentItemId] = nowEpochMs()
            return true
        }
        guard queueIndex > 0 else {
            player?.seek(to: .zero)
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
        if let item = player?.currentItem,
           itemIdByItem[ObjectIdentifier(item)] == entry.itemId,
           !item.duration.isIndefinite {
            return item.duration.seconds
        }
        return entry.knownDuration ?? 0
    }

    private func pushTransition(_ transition: QueueTransition) {
        let payload = transition.toDictionary()
        for (_, callback) in transitionCallbacks {
            callback.resolve(payload)
        }
    }

    // MARK: - Natural end / failure notifications

    @objc func playerItemDidReachEnd(notification: Notification) {
        guard let endedItem = notification.object as? AVPlayerItem else { return }
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
        }
        updatePlaybackInfo()
        notifyProgressCompleted(itemId: endedId, duration: durationSec)
    }

    @objc func playerItemFailedToReachEnd(notification: Notification) {
        guard let failedItem = notification.object as? AVPlayerItem else { return }
        handleItemFailure(failedItem)
    }

    // MARK: - Playback controls

    @objc func play(_ call: CAPPluginCall? = nil) {
        // Nothing loaded — a remote/headset play command arriving after
        // `stop()` must not arm the persist timer for an engine with no item.
        guard let player = player else {
            call?.resolve()
            return
        }
        player.play()
        if player.rate != 0 {
            player.rate = targetPlaybackRate
        }
        updatePlaybackInfo()
        startPlaybackPersistTimer()
        call?.resolve()
    }

    @objc func togglePause(_ call: CAPPluginCall? = nil) {
        if let player = player {
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
        call?.resolve()
    }

    @objc func seek(_ call: CAPPluginCall) {
        guard let position = call.getDouble("position") else {
            call.reject("Position parameter is required")
            return
        }

        let time = CMTime(seconds: position, preferredTimescale: 1000)
        player?.seek(to: time) { [weak self] finished in
            if finished {
                self?.updatePlaybackInfo()
                self?.persistCurrentPosition()
                call.resolve()
            } else {
                call.reject("Seek operation failed")
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
        teardownPlayer()
        entries.removeAll()
        queueIndex = 0
        currentItemId = ""
        fromPositionByItemId.removeAll()
        fromAtByItemId.removeAll()
        failureRetries.removeAll()
        wasPlayingBeforeInterruption = false
        // Drop the in-flight snapshot the way the queue-ran-dry path does: it
        // names an item that is about to be deleted (wipe) or replaced
        // (import). The transition journal itself is deliberately left alone —
        // only `ackEvents` retires those, and after an import JS reloads and
        // still has to drain the listening events recorded before it.
        journal.savePosition(itemId: nil, positionSec: 0)
        updateRemoteSkipCommands()
        clearNowPlayingInfo()
        call.resolve()
    }

    /// Relative seek by `delta` seconds, clamped to [0, duration].
    @objc func seekBy(_ call: CAPPluginCall) {
        guard let delta = call.getDouble("delta") else {
            call.reject("Argument 'delta' is required")
            return
        }
        guard let player = player, let item = player.currentItem else {
            call.resolve()
            return
        }
        let current = player.currentTime().seconds
        let durationSec = item.duration.isIndefinite ? Double.greatestFiniteMagnitude : item.duration.seconds
        let next = max(0, min(durationSec, current + delta))
        let newTime = CMTime(seconds: next, preferredTimescale: 1000)
        player.seek(to: newTime) { [weak self] finished in
            if finished {
                self?.updatePlaybackInfo()
                self?.persistCurrentPosition()
                call.resolve()
            } else {
                call.reject("Seek operation failed")
            }
        }
    }

    /// Set playback rate. Cached in `targetPlaybackRate` so a
    /// `setPlaybackRate(2)` during pause doesn't accidentally resume
    /// playback.
    @objc func setPlaybackRate(_ call: CAPPluginCall) {
        var rate = Float(call.getDouble("rate") ?? 1.0)
        if !rate.isFinite { rate = 1.0 }
        if rate < 0.5 { rate = 0.5 }
        if rate > 2.0 { rate = 2.0 }
        targetPlaybackRate = rate
        if let player = player, player.rate != 0 {
            player.rate = rate
        }
        call.resolve()
    }

    /// Forward the slider state to the MTAudioProcessingTap context. One
    /// context is shared by every tap, so this takes effect on whatever
    /// AVPlayerItem is in flight without rebuilding the player.
    @objc func setMix(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? false
        let ratio = Float(call.getDouble("ratio") ?? 0.5)
        stereoMixTap.setMix(enabled: enabled, ratio: ratio)
        call.resolve()
    }

    // MARK: - Progress callbacks

    @objc func onProgressChanged(_ call: CAPPluginCall) {
        let callbackId = UUID().uuidString
        statusCallbacks[callbackId] = call
        call.keepAlive = true
        call.resolve([
            "callbackId": callbackId
        ])
    }

    private func notifyProgressChanged() {
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
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    private func updatePlaybackInfo() {
        guard let player = player, var nowPlayingInfo = MPNowPlayingInfoCenter.default().nowPlayingInfo else {
            return
        }
        nowPlayingInfo[MPNowPlayingInfoPropertyElapsedPlaybackTime] = player.currentTime().seconds
        nowPlayingInfo[MPNowPlayingInfoPropertyPlaybackRate] = player.rate
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlayingInfo
    }

    // MARK: - Progress observer

    private func setupProgressObserver() {
        removeProgressObserver()
        // Adaptive cadence (#828): fast for transcript highlighting, slower
        // for the floating player, a heartbeat when backgrounded.
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
        if sec != progressIntervalSec {
            progressIntervalSec = sec
            // Rebuild the observer at the new cadence if one is active.
            if progressObserver != nil {
                setupProgressObserver()
            }
        }
        call.resolve()
    }

    private func removeProgressObserver() {
        if let observer = progressObserver, let owner = progressObserverPlayer {
            owner.removeTimeObserver(observer)
        }
        progressObserver = nil
        progressObserverPlayer = nil
    }

    // MARK: - Durable position persistence

    private func startPlaybackPersistTimer() {
        stopPlaybackPersistTimer()
        // Coarse safety interval — exactness isn't important (§3.4).
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

    deinit {
        teardownPlayer()
        NotificationCenter.default.removeObserver(self)
    }
}
