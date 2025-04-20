package studios.akdasa.lectorium.audioplayer.mediaStateNotifications;

import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;

public final class PluginCallMediaStateNotifier implements IMediaStateNotifier {
    private final PluginCall call;

    public PluginCallMediaStateNotifier(PluginCall call) {
        this.call = call;
    }

    @Override
    public void send(MediaState state) {
        JSObject payload = new JSObject();
        payload.put("trackId", state.getTrackId());
        payload.put("position", state.getPosition() / 1000);
        payload.put("duration", state.getDuration() / 1000);
        payload.put("playing", state.getState().equals("playing"));
        call.resolve(payload);
    }
}
