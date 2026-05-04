package studio.jiva.shruti.audioplayer.audioprocessor;

import androidx.media3.common.C;
import androidx.media3.common.audio.AudioProcessor.AudioFormat;
import androidx.media3.common.audio.AudioProcessor.UnhandledAudioFormatException;
import androidx.media3.common.audio.BaseAudioProcessor;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * ExoPlayer audio processor that folds the L and R channels of a
 * stereo stream into a mono signal and emits it on both output
 * channels, so the listener hears the same mix in both ears.
 *
 * Stereo recordings in our corpus may carry the original lecture in
 * the left channel and a translation in the right. Played as native
 * stereo this is uncomfortable in headphones; this processor lets the
 * UI blend the two with a `ratio` parameter:
 *
 *   ratio = 0.0  → both ears hear the original (left) only
 *   ratio = 1.0  → both ears hear the translation (right) only
 *   ratio = 0.5  → balanced mono mix of both channels
 *
 * Loudness compensation: per-channel weights are normalised by
 *   k = 1 / sqrt((1−s)² + s²)
 * so the perceived volume stays stable across the slider.
 *
 * Supports `ENCODING_PCM_16BIT` and `ENCODING_PCM_FLOAT` at any
 * sample rate. Anything that isn't 2-channel PCM is rejected via
 * `UnhandledAudioFormatException`, which makes ExoPlayer skip this
 * processor and play the source unchanged.
 *
 * `enabled` and `ratio` are `volatile` so the UI thread can update
 * them while the audio render thread reads them; both writes are
 * single fields so torn reads aren't possible at the granularity
 * we care about.
 *
 * `isActive()` always returns true while we're configured for stereo
 * PCM. That keeps the processor in the audio chain so toggling the
 * mix does not require recreating the player; in passthrough mode
 * the queueInput path just copies bytes through.
 */
public final class StereoMixAudioProcessor extends BaseAudioProcessor {

    private volatile boolean enabled = false;
    private volatile float ratio = 0.5f;

    public void setMix(boolean enabled, float ratio) {
        this.enabled = enabled;
        if (Float.isNaN(ratio)) ratio = 0.5f;
        if (ratio < 0f) ratio = 0f;
        if (ratio > 1f) ratio = 1f;
        this.ratio = ratio;
    }

    @Override
    protected AudioFormat onConfigure(AudioFormat inputAudioFormat)
            throws UnhandledAudioFormatException {
        // We only know how to mix true stereo. Mono / surround / non-
        // PCM streams are passed through untouched (returning
        // NOT_SET tells BaseAudioProcessor to disable us for this
        // configuration).
        if (inputAudioFormat.channelCount != 2) {
            throw new UnhandledAudioFormatException(inputAudioFormat);
        }
        if (inputAudioFormat.encoding != C.ENCODING_PCM_16BIT
                && inputAudioFormat.encoding != C.ENCODING_PCM_FLOAT) {
            throw new UnhandledAudioFormatException(inputAudioFormat);
        }
        // Output format matches input — same encoding, same rate,
        // still 2 channels (carrying the duplicated mono signal when
        // enabled, or the unchanged stereo when disabled).
        return inputAudioFormat;
    }

    @Override
    public boolean isActive() {
        // Stay in chain whenever the configured stream is one we
        // recognise, so setMix() can flip behaviour without recreating
        // the player. Returning false here would let ExoPlayer skip
        // this processor entirely until the next configure().
        return inputAudioFormat.channelCount == 2
                && (inputAudioFormat.encoding == C.ENCODING_PCM_16BIT
                        || inputAudioFormat.encoding == C.ENCODING_PCM_FLOAT);
    }

    @Override
    public void queueInput(ByteBuffer inputBuffer) {
        int remaining = inputBuffer.remaining();
        if (remaining == 0) return;

        ByteBuffer out = replaceOutputBuffer(remaining);
        if (!enabled) {
            // Pass-through. Copy the whole window verbatim. duplicate()
            // gives us an independent position so we don't disturb the
            // input buffer's view.
            ByteBuffer copy = inputBuffer.duplicate();
            copy.order(ByteOrder.nativeOrder());
            out.put(copy);
            inputBuffer.position(inputBuffer.limit());
            out.flip();
            return;
        }

        final float s = ratio;
        final float lw = 1f - s;
        final float rw = s;
        // Constant-loudness compensation: at s=0.5 a naive mean is
        // 6 dB quieter than either source, so we boost by sqrt(2).
        final float k = 1f / (float) Math.sqrt(lw * lw + rw * rw);
        final float gL = lw * k;
        final float gR = rw * k;

        ByteOrder order = inputBuffer.order();
        out.order(order);

        if (inputAudioFormat.encoding == C.ENCODING_PCM_16BIT) {
            // Each frame = 2 channels × 2 bytes = 4 bytes.
            int frames = remaining / 4;
            for (int i = 0; i < frames; i++) {
                int base = inputBuffer.position() + i * 4;
                short l = inputBuffer.getShort(base);
                short r = inputBuffer.getShort(base + 2);
                int mixed = Math.round(l * gL + r * gR);
                if (mixed > Short.MAX_VALUE) mixed = Short.MAX_VALUE;
                else if (mixed < Short.MIN_VALUE) mixed = Short.MIN_VALUE;
                short mono = (short) mixed;
                out.putShort(mono);
                out.putShort(mono);
            }
            inputBuffer.position(inputBuffer.limit());
        } else {
            // ENCODING_PCM_FLOAT: 2 channels × 4 bytes = 8 bytes per frame.
            int frames = remaining / 8;
            for (int i = 0; i < frames; i++) {
                int base = inputBuffer.position() + i * 8;
                float l = inputBuffer.getFloat(base);
                float r = inputBuffer.getFloat(base + 4);
                float mono = l * gL + r * gR;
                if (mono > 1f) mono = 1f;
                else if (mono < -1f) mono = -1f;
                out.putFloat(mono);
                out.putFloat(mono);
            }
            inputBuffer.position(inputBuffer.limit());
        }
        out.flip();
    }
}
