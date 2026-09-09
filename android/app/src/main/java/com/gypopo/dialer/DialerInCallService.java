package com.gypopo.dialer;

import android.net.Uri;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;
import android.os.PowerManager;
import android.telecom.Call;
import android.telecom.CallAudioState;
import android.telecom.InCallService;
import android.telecom.VideoProfile;
import androidx.core.app.NotificationCompat;

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

    private static final String CHANNEL_INCOMING = "dialer_incoming";
    private static final String CHANNEL_ONGOING = "dialer_ongoing";
    private static final int NOTIF_INCOMING = 1001;
    private static final int NOTIF_ONGOING = 1002;

    private static DialerTelecomPlugin plugin;
    private static DialerInCallService instance;

    private final List<Call> calls = new ArrayList<>();
    private PowerManager.WakeLock proximityLock;

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
        releaseProximity();
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
        cancelNotifications();
        releaseProximity();
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
            showIncomingNotification(call);
        } else if (state == Call.STATE_DIALING || state == Call.STATE_CONNECTING) {
            event = "dialing";
            cancelNotification(NOTIF_INCOMING);
        } else if (state == Call.STATE_ACTIVE) {
            event = "active";
            cancelNotification(NOTIF_INCOMING);
            showOngoingNotification(call);
            acquireProximity();
        } else if (state == Call.STATE_DISCONNECTED || state == Call.STATE_DISCONNECTING) {
            event = "disconnected";
            cancelNotifications();
            releaseProximity();
        } else {
            event = "other";
        }
        JSObject data = new JSObject();
        data.put("event", event);
        data.put("number", numberOf(call));
        DialerTelecomPlugin.emit("telecomEvent", data);
    }

    private String numberOf(Call call) {
        return numberOfCall(call);
    }

    private static String numberOfCall(Call call) {
        try {
            Uri handle = call.getDetails().getHandle();
            if (handle != null) return handle.getSchemeSpecificPart();
        } catch (Exception ignored) {
        }
        return "";
    }

    // Снапшот живого звонка для WebView, стартовавшего позже события
    // (приложение было убито/свёрнуто, экран заблокирован): позволяет
    // сразу показать экран приёма/разговора, а не главную.
    static JSObject snapshotCurrentCall() {
        if (instance == null) return null;
        Call c = firstLiveCall();
        if (c == null) return null;
        int s = c.getState();
        String event;
        if (s == Call.STATE_RINGING) {
            event = "ringing-incoming";
        } else if (s == Call.STATE_DIALING || s == Call.STATE_CONNECTING) {
            event = "dialing";
        } else if (s == Call.STATE_ACTIVE) {
            event = "active";
        } else {
            return null;
        }
        JSObject data = new JSObject();
        data.put("event", event);
        data.put("number", numberOfCall(c));
        return data;
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

    static boolean playDtmf(char tone) {
        if (instance == null) return false;
        Call c = firstLiveCall();
        if (c == null || c.getState() != Call.STATE_ACTIVE) return false;
        try {
            c.playDtmfTone(tone);
            c.stopDtmfTone();
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    static boolean setMicMuted(boolean muted) {
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

    // ---------- Уведомления: звонок виден и при свёрнутом приложении ----------

    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm == null) return;
            NotificationChannel incoming = new NotificationChannel(
                CHANNEL_INCOMING, "Входящие звонки", NotificationManager.IMPORTANCE_HIGH);
            incoming.setLockScreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(incoming);
            NotificationChannel ongoing = new NotificationChannel(
                CHANNEL_ONGOING, "Текущий звонок", NotificationManager.IMPORTANCE_DEFAULT);
            nm.createNotificationChannel(ongoing);
        } catch (Exception ignored) {
        }
    }

    private PendingIntent actionIntent(String action, int requestCode) {
        Intent intent = new Intent(this, DialerCallActionReceiver.class);
        intent.setAction(action);
        return PendingIntent.getBroadcast(
            this, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private PendingIntent openAppIntent() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setAction("com.gypopo.dialer.OPEN_CALL");
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(
            this, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private void showIncomingNotification(Call call) {
        createChannels();
        String number = numberOf(call);
        try {
            Notification notif = new NotificationCompat.Builder(this, CHANNEL_INCOMING)
                .setSmallIcon(android.R.drawable.sym_call_incoming)
                .setContentTitle(number.isEmpty() ? "Входящий звонок" : number)
                .setContentText("Нажмите, чтобы ответить")
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setFullScreenIntent(openAppIntent(), true)
                .setContentIntent(openAppIntent())
                .addAction(android.R.drawable.sym_action_call, "Принять",
                    actionIntent(DialerCallActionReceiver.ACTION_ANSWER, 2001))
                .addAction(android.R.drawable.sym_call_missed, "Отклонить",
                    actionIntent(DialerCallActionReceiver.ACTION_DECLINE, 2002))
                .setAutoCancel(true)
                .build();
            postNotification(NOTIF_INCOMING, notif);
        } catch (Exception ignored) {
        }
    }

    private void showOngoingNotification(Call call) {
        createChannels();
        String number = numberOf(call);
        try {
            Notification notif = new NotificationCompat.Builder(this, CHANNEL_ONGOING)
                .setSmallIcon(android.R.drawable.sym_action_call)
                .setContentTitle(number.isEmpty() ? "Разговор" : number)
                .setContentText("Звонок через Звонилку")
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setOngoing(true)
                .setContentIntent(openAppIntent())
                .build();
            postNotification(NOTIF_ONGOING, notif);
        } catch (Exception ignored) {
        }
    }

    private void postNotification(int id, Notification notif) {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(id, notif);
        } catch (Exception ignored) {
        }
    }

    private void cancelNotification(int id) {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(id);
        } catch (Exception ignored) {
        }
    }

    private void cancelNotifications() {
        cancelNotification(NOTIF_INCOMING);
        cancelNotification(NOTIF_ONGOING);
    }

    // ---------- Датчик приближения: экран гаснет у уха ----------

    private void acquireProximity() {
        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm == null) return;
            if (proximityLock == null) {
                proximityLock = pm.newWakeLock(
                    PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "dialer:proximity");
                proximityLock.setReferenceCounted(false);
            }
            if (!proximityLock.isHeld()) proximityLock.acquire(10 * 60 * 1000L);
        } catch (Exception ignored) {
        }
    }

    private void releaseProximity() {
        try {
            if (proximityLock != null && proximityLock.isHeld()) proximityLock.release();
        } catch (Exception ignored) {
        }
    }
}
