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
        CAPPluginMethod(name: "onProgressChanged", returnType: CAPPluginReturnCallback),
        
    ]
    
    private var player: AVPlayer?
    private var playerItem: AVPlayerItem?
    private var progressObserver: Any?
    private var statusCallbacks: [String: CAPPluginCall] = [:]
    private var currentTrackId: String = ""
    
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
    }
    
    private func setupAudioSession() {
        do {
            try AVAudioSession.sharedInstance().setCategory(
                .playback,
                mode: .default,
                options: [.mixWithOthers, .allowAirPlay]
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
        
        commandCenter.seekForwardCommand.addTarget { [weak self] event in
            if let seekEvent = event as? MPSeekCommandEvent, let player = self?.player {
                let newTime = CMTime(seconds: player.currentTime().seconds + Double(seekEvent.type.rawValue * 30), preferredTimescale: 1)
                player.seek(to: newTime)
                return .success
            }
            return .commandFailed
        }
        
        commandCenter.seekBackwardCommand.addTarget { [weak self] event in
            if let seekEvent = event as? MPSeekCommandEvent, let player = self?.player {
                let newTime = CMTime(seconds: max(player.currentTime().seconds - Double(seekEvent.type.rawValue * 30), 0), preferredTimescale: 1)
                player.seek(to: newTime)
                return .success
            }
            return .commandFailed
        }
        
        commandCenter.changePlaybackPositionCommand.addTarget { [weak self] event in
            if let changeEvent = event as? MPChangePlaybackPositionCommandEvent, let player = self?.player {
                let newTime = CMTime(seconds: changeEvent.positionTime, preferredTimescale: 1)
                player.seek(to: newTime)
                return .success
            }
            return .commandFailed
        }
    }
    
    @objc func handleInterruption(notification: Notification) {
        guard let info = notification.userInfo,
              let typeValue = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else {
            return
        }
        
        switch type {
        case .began:
            // Audio session interrupted, pause playback
            if player?.rate != 0 {
                togglePause()
            }
        case .ended:
            // Interruption ended, resume playback if needed
            if let optionsValue = info[AVAudioSessionInterruptionOptionKey] as? UInt {
                let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue)
                if options.contains(.shouldResume) {
                    play()
                }
            }
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
    
    @objc func open(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), let url = URL(string: urlString) else {
            call.reject("Invalid URL provided")
            return
        }
        
        // Store track metadata
        let title = call.getString("title") ?? "Unknown Title"
        let author = call.getString("author") ?? "Unknown Artist"
        currentTrackId = call.getString("trackId") ?? ""
        
        // Clear any existing player
        removeProgressObserver()
        
        // Create a new player item and player
        playerItem = AVPlayerItem(url: url)
        player = AVPlayer(playerItem: playerItem)
        
        // Add status observation
        playerItem?.addObserver(self, forKeyPath: #keyPath(AVPlayerItem.status), options: [.new], context: nil)
        
        // Add ended playback observation
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(playerItemDidReachEnd),
            name: .AVPlayerItemDidPlayToEndTime,
            object: playerItem
        )
        
        // Setup progress observation
        setupProgressObserver()
        
        // Set the metadata for the now playing info center
        updateNowPlayingInfo(title: title, artist: author)
        
        call.resolve()
    }
    
    private func updateNowPlayingInfo(title: String, artist: String) {
        // Create a default artwork image
        let defaultArtwork = MPMediaItemArtwork(boundsSize: CGSize(width: 100, height: 100)) { size in
            // Create a simple colored square as default artwork
            let renderer = UIGraphicsImageRenderer(size: size)
            return renderer.image { ctx in
                UIColor.systemBlue.setFill()
                ctx.fill(CGRect(origin: .zero, size: size))
            }
        }
        
        // Get duration
        var duration: TimeInterval = 0
        if let currentItem = player?.currentItem {
            duration = CMTimeGetSeconds(currentItem.duration)
        }
        
        // Create the now playing info
        var nowPlayingInfo: [String: Any] = [
            MPMediaItemPropertyTitle: title,
            MPMediaItemPropertyArtist: artist,
            MPMediaItemPropertyPlaybackDuration: duration,
            MPMediaItemPropertyArtwork: defaultArtwork,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: 0,
            MPNowPlayingInfoPropertyPlaybackRate: 0
        ]
        
        // Update the now playing info center
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlayingInfo
    }
    
    private func updatePlaybackInfo() {
        guard let player = player, var nowPlayingInfo = MPNowPlayingInfoCenter.default().nowPlayingInfo else {
            return
        }
        
        nowPlayingInfo[MPNowPlayingInfoPropertyElapsedPlaybackTime] = player.currentTime().seconds
        nowPlayingInfo[MPNowPlayingInfoPropertyPlaybackRate] = player.rate
        
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlayingInfo
    }
    
    private func setupProgressObserver() {
        // Monitor playback progress every 0.5 second
        let interval = CMTime(seconds: 0.5, preferredTimescale: CMTimeScale(NSEC_PER_SEC))
        progressObserver = player?.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self] time in
            self?.updatePlaybackInfo()
            self?.notifyProgressChanged()
        }
    }
    
    private func removeProgressObserver() {
        if let observer = progressObserver, let player = player {
            player.removeTimeObserver(observer)
            progressObserver = nil
        }
    }
    
    @objc func play(_ call: CAPPluginCall? = nil) {
        player?.play()
        updatePlaybackInfo()
        call?.resolve()
    }
    
    @objc func togglePause(_ call: CAPPluginCall? = nil) {
        if let player = player {
            if player.rate != 0 {
                player.pause()
            } else {
                player.play()
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
        
        let time = CMTime(seconds: position, preferredTimescale: 1)
        player?.seek(to: time) { [weak self] finished in
            if finished {
                self?.updatePlaybackInfo()
                call.resolve()
            } else {
                call.reject("Seek operation failed")
            }
        }
    }
    
    @objc func stop(_ call: CAPPluginCall) {
        player?.pause()
        player?.seek(to: .zero)
        updatePlaybackInfo()
        call.resolve()
    }
    
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
        
        if (currentItem.duration.isIndefinite) {
            return
        }
        
        let position = player.currentTime().seconds
        let duration = currentItem.duration.isIndefinite ? 0 : currentItem.duration.seconds
        let playing = player.rate != 0
        
        let status: [String: Any] = [
            "position": position,
            "playing": playing,
            "duration": duration,
            "trackId": currentTrackId
        ]
        
        for (_, callback) in statusCallbacks {
            callback.resolve(status)
        }
    }
    
    @objc func playerItemDidReachEnd(notification: Notification) {
        // Reset to beginning
        player?.seek(to: .zero)
        updatePlaybackInfo()
        notifyProgressChanged()
    }
    
    override public func observeValue(forKeyPath keyPath: String?, of object: Any?, change: [NSKeyValueChangeKey: Any]?, context: UnsafeMutableRawPointer?) {
        if keyPath == #keyPath(AVPlayerItem.status) {
            let status: AVPlayerItem.Status
            
            if let statusNumber = change?[.newKey] as? NSNumber {
                status = AVPlayerItem.Status(rawValue: statusNumber.intValue)!
            } else {
                status = .unknown
            }
            
            // Update the now playing info with the correct duration once it's available
            if status == .readyToPlay, let currentItem = player?.currentItem {
                var nowPlayingInfo = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
                nowPlayingInfo[MPMediaItemPropertyPlaybackDuration] = currentItem.duration.seconds
                MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlayingInfo
            }
        }
    }
    
    deinit {
        removeProgressObserver()
        playerItem?.removeObserver(self, forKeyPath: #keyPath(AVPlayerItem.status))
        NotificationCenter.default.removeObserver(self)
    }
}
