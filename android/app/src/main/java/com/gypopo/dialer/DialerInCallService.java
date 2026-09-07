package com.gypopo.dialer;

import android.net.Uri;
import android.os.Bundle;
import android.telecom.Call;
import android.telecom.CallAudioState;
import android.telecom.InCallService;
import android.telecom.VideoProfile;

import com.getcapacitor.JSObject;

import java.util.ArrayList;
import java.util.List;

/**
 * InCallService звонилки: система отдаёт сюда звонки, когда приложение
 * назначено диалером по умолчанию. Состояние звонков транслируется в WebView
 * через событие "telecomEvent" — веб-UI (экран звонка) переиспользуется
 * без изменений. Управление звуком — штатными методами InCallService.
 */
public class DialerInCallService extends InCallService {

    private static DialerTelecomPlugin plugin;
    private static DialerInCallService instance;

    private final List<Call> calls = new ArrayList<>();

    static void setPlugin(DialerTelecomPlugin p) {
        plugin = p;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (instance == this) instance = null;
    }

    @Override
    public void onCallAdded(Call call) {
        super.onCallAdded(call);
        calls.add(call);
        emitState(call);
        call.registerCallback(new Call.Callback() {
            @Override
            public void onStateChanged(Call c, int state) {
                super.onStateChanged(c, state);
                emitState(c);
            }
        });
    }

    @Override
    public void onCallRemoved(Call call) {
        super.onCallRemoved(call);
        calls.remove(call);
        JSObject data = new JSObject();
        data.put("event", "disconnected");
        data.put("number", numberOf(call));
        DialerTelecomPlugin.emit("telecomEvent", data);
    }

    private void emitState(Call call) {
        int state = call.getState();
        String event;
        if (state == Call.STATE_RINGING) {
            event = "ringing-incoming";
        } else if (state == Call.STATE_DIALING || state == Call.STATE_CONNECTING) {
            event = "dialing";
        } else if (state == Call.STATE_ACTIVE) {
            event = "active";
        } else if (state == Call.STATE_DISCONNECTED || state == Call.STATE_DISCONNECTING) {
            event = "disconnected";
        } else {
            event = "other";
        }
        JSObject data = new JSObject();
        data.put("event", event);
        data.put("number", numberOf(call));
        DialerTelecomPlugin.emit("telecomEvent", data);
    }

    private String numberOf(Call call) {
        try {
            Uri handle = call.getDetails().getHandle();
            if (handle != null) return handle.getSchemeSpecificPart();
        } catch (Exception ignored) {
        }
        return "";
    }

    private static Call firstLiveCall() {
        if (instance == null) return null;
        for (Call c : instance.calls) {
            int s = c.getState();
            if (s != Call.STATE_DISCONNECTED && s != Call.STATE_DISCONNECTING) return c;
        }
        return null;
    }

    private static Call ringingCall() {
        if (instance == null) return null;
        for (Call c : instance.calls) {
            if (c.getState() == Call.STATE_RINGING) return c;
        }
        return null;
    }

    static boolean answer() {
        Call c = ringingCall();
        if (c == null) return false;
        try {
            c.answer(VideoProfile.STATE_AUDIO_ONLY);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    static boolean disconnect() {
        Call c = firstLiveCall();
        if (c == null) return false;
        try {
            c.disconnect();
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    static boolean setSpeaker(boolean on) {
        if (instance == null) return false;
        try {
            instance.setAudioRoute(on
                ? CallAudioState.ROUTE_SPEAKER
                : CallAudioState.ROUTE_WIRED_OR_EARPIECE);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    static boolean setMuted(boolean muted) {
        if (instance == null) return false;
        try {
            instance.setMuted(muted);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    @Override
    public void onBringToForeground(boolean showDialpad) {
        super.onBringToForeground(showDialpad);
        // Система просит показать UI звонка — WebView уже отображает
        // экран звонка по событию telecomEvent; отдельных действий не нужно.
    }

    @Override
    public void onSilenceIncomingCall(String reason) {
        super.onSilenceIncomingCall(reason);
        Bundle extras = new Bundle();
        JSObject data = new JSObject();
        data.put("event", "silenced");
        DialerTelecomPlugin.emit("telecomEvent", data);
    }
}
