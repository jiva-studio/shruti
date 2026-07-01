// fluidstreamd — real-time streaming ASR daemon (one process per audio channel).
//
// CONTRACT (frozen — see repo README §protocol):
//   stdin  : raw PCM, signed 16-bit little-endian, mono, 16 kHz — a LIVE stream,
//            written by the client as audio is spoken (NOT a pre-recorded file
//            handed over at the end). Read in small chunks and fed immediately.
//   stdout : NDJSON, one object per line, flushed as soon as it is produced:
//              {"type":"partial","text":"...","ts_ms":1234}   ← running hypothesis, streams continuously
//              {"type":"final","text":"...","ts_ms":5678}     ← committed segment at utterance end (EOU)
//   stderr : human logs only.
//   EOF on stdin → flush the tail via finish(), emit a last "final", exit 0.
//
// Engine: FluidAudio StreamingEouAsrManager (Parakeet EOU, cache-aware, 160 ms
// chunks) — the TRUE-streaming variant. NOTE: Parakeet-TDT (the batch model)
// does NOT conform to the streaming protocol; use the EOU manager here.
//
// Reference implementations to mirror (in the FluidAudio checkout on mridanga):
//   Sources/FluidAudio/ASR/Parakeet/Streaming/EOU/StreamingEouAsrManager.swift
//   Sources/FluidAudioCLI/Commands/ASR/Parakeet/Streaming/ParakeetEouCommand.swift
//
// TODO(task #2): implement. Sketch:
//   let manager = StreamingModelVariant.parakeetEou160ms.createManager()
//   try await manager.loadModels()
//   manager.setPartialTranscriptCallback { partial in emit(.partial, partial) }
//   loop: read PCM chunk from stdin → AVAudioPCMBuffer → manager.appendAudio(buf)
//         → try await manager.processBufferedAudio()  (emits partials via callback;
//            detect EOU/segment boundary → emit(.final, ...) + manager.reset())
//   on EOF: let tail = try await manager.finish(); emit(.final, tail); exit
import Foundation

FileHandle.standardError.write(Data("fluidstreamd: not yet implemented (task #2)\n".utf8))
exit(1)
