import type { PluginListenerHandle } from "@capacitor/core"

import type { AudioPlayerPlugin, OpenParams, AudioPlayerListenerResult, Status } from "./definitions"


export class AudioPlayerPluginWeb implements AudioPlayerPlugin {
  private audio: HTMLAudioElement | null = null;
  private callback: ((status: Status) => void) | null = null;
  private currentTrackId: string | null = null;


  constructor () {
    setInterval(() => {
      if (!this.audio || !this.callback) { return }

      this.callback({
        position: this.audio.currentTime,
        playing: !this.audio.paused,
        duration: this.audio.duration,
        trackId: this.currentTrackId || "",
      });
    }, 1000);
  }


  async open(
    params: OpenParams
  ): Promise<void> {
    this.audio = new Audio(params.url);
    this.currentTrackId = params.trackId;
  }

  async play(): Promise<void> {
    if (this.audio) {
      await this.audio.play();
    }
  }

  async togglePause(): Promise<void> {
    if (!this.audio) { return; }
    if (this.audio.paused) {
      this.audio.play();
    } else {
      this.audio.pause();
    }
  }

  async seek(
    options: { position: number }
  ): Promise<void> {
    if (this.audio) {
      this.audio.currentTime = options.position;
    }
  }

  async stop(): Promise<void> {
    if (this.audio) {
      this.audio.pause();
      this.audio.remove();
      this.currentTrackId = null;
    }
  }

  onProgressChanged(
    callback: (status: Status) => void
  ): Promise<AudioPlayerListenerResult> {
    this.callback = callback;
    return new Promise((resolve, _reject) => {
      resolve({ callbackId: "123" });
    });
  }

  addListener(_eventName: string, _listenerFunc: (...args: any[]) => any): Promise<PluginListenerHandle> {
    throw new Error("Method not implemented.");
  }

  removeAllListeners(): Promise<void> {
    throw new Error("Method not implemented.");
  }
}