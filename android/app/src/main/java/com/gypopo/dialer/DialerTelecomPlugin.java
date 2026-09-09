package com.gypopo.dialer;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.app.role.RoleManager;
import android.content.ContentUris;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.CallLog;
import android.provider.ContactsContract;
import android.telecom.TelecomManager;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Мост между WebView (наш UI) и телефонными службами Android.
 *
 * Исходящие звонки идут через TelecomManager.placeCall() — как у обычной
 * звонилки: система сама маршрутизирует вызов через SIM, а наш
 * DialerInCallService получает звонок для отображения и управления
 * (принять/завершить/спикер/mute). Поэтому здесь нет VoIP-сигналинга.
 */
@CapacitorPlugin(
    name = "DialerTelecom",
    permissions = {
        @Permission(strings = { Manifest.permission.READ_CONTACTS }, alias = "contacts"),
        @Permission(strings = { Manifest.permission.READ_CALL_LOG, Manifest.permission.WRITE_CALL_LOG }, alias = "callLog"),
        @Permission(strings = {
            Manifest.permission.CALL_PHONE,
            Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.ANSWER_PHONE_CALLS,
            Manifest.permission.RECORD_AUDIO
        }, alias = "phone"),
        @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications")
    }
)
public class DialerTelecomPlugin extends Plugin {

    private static DialerTelecomPlugin instance;

    @Override
    public void load() {
        instance = this;
        DialerInCallService.setPlugin(this);
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) {
            instance = null;
            DialerInCallService.setPlugin(null);
        }
    }

    static void emit(String event, JSObject data) {
        DialerTelecomPlugin p = instance;
        if (p != null) {
            p.notifyListeners(event, data);
        }
    }

    // ---------- presence ----------

    @PluginMethod
    public void ping(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    // ---------- default dialer ----------

    @PluginMethod
    public void isDefaultDialer(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("isDefault", isDefaultDialerPackage());
        call.resolve(ret);
    }

    @PluginMethod
    public void requestDefaultDialerRole(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("no activity");
            return;
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                RoleManager rm = (RoleManager) getContext().getSystemService(Context.ROLE_SERVICE);
                if (rm == null || !rm.isRoleAvailable(RoleManager.ROLE_DIALER)) {
                    call.reject("dialer role unavailable");
                    return;
                }
                Intent intent = rm.createRequestRoleIntent(RoleManager.ROLE_DIALER);
                startActivityForResult(call, intent, "onRoleRequestFinished");
            } else {
                Intent intent = new Intent(TelecomManager.ACTION_CHANGE_DEFAULT_DIALER);
                intent.putExtra(
                    TelecomManager.EXTRA_CHANGE_DEFAULT_DIALER_PACKAGE_NAME,
                    getContext().getPackageName());
                startActivityForResult(call, intent, "onRoleRequestFinished");
            }
        } catch (Exception e) {
            call.reject("role request failed: " + e.getMessage());
        }
    }

    @ActivityCallback
    private void onRoleRequestFinished(PluginCall call, ActivityResult result) {
        JSObject ret = new JSObject();
        ret.put("isDefault", isDefaultDialerPackage());
        call.resolve(ret);
    }

    private boolean isDefaultDialerPackage() {
        try {
            TelecomManager tm = (TelecomManager) getContext().getSystemService(Context.TELECOM_SERVICE);
            if (tm == null) return false;
            return getContext().getPackageName().equals(tm.getDefaultDialerPackage());
        } catch (Exception e) {
            return false;
        }
    }

    // ---------- outgoing call ----------

    @PluginMethod
    public void placeCall(PluginCall call) {
        String number = call.getString("number");
        if (number == null || number.isEmpty()) {
            call.reject("number required");
            return;
        }
        if (getPermissionState("phone") != PermissionState.GRANTED) {
            requestPermissionForAliases(new String[]{"phone"}, call, "onPhonePermsForCall");
            return;
        }
        doPlaceCall(call, number);
    }

    @PermissionCallback
    private void onPhonePermsForCall(PluginCall call) {
        if (getPermissionState("phone") == PermissionState.GRANTED) {
            doPlaceCall(call, call.getString("number"));
        } else {
            call.reject("phone permission denied");
        }
    }

    private void doPlaceCall(PluginCall call, String number) {
        try {
            TelecomManager tm = (TelecomManager) getContext().getSystemService(Context.TELECOM_SERVICE);
            if (tm == null) {
                call.reject("telecom unavailable");
                return;
            }
            Uri uri = Uri.fromParts("tel", number, null);
            tm.placeCall(uri, new Bundle());
            JSObject ret = new JSObject();
            ret.put("placed", true);
            call.resolve(ret);
        } catch (SecurityException se) {
            call.reject("permission: " + se.getMessage());
        } catch (Exception e) {
            call.reject("placeCall failed: " + e.getMessage());
        }
    }

    // ---------- in-call control (делегируется активному InCallService) ----------

    @PluginMethod
    public void answerCall(PluginCall call) {
        if (DialerInCallService.answer()) {
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
        } else {
            call.reject("no ringing call");
        }
    }

    @PluginMethod
    public void hangUpCall(PluginCall call) {
        if (DialerInCallService.disconnect()) {
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
        } else {
            call.reject("no active call");
        }
    }

    @PluginMethod
    public void setSpeakerOn(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        if (DialerInCallService.setSpeaker(on)) {
            JSObject ret = new JSObject();
            ret.put("speakerOn", on);
            call.resolve(ret);
        } else {
            call.reject("no active call");
        }
    }

    @PluginMethod
    public void setMicMuted(PluginCall call) {
        boolean muted = Boolean.TRUE.equals(call.getBoolean("muted", false));
        if (DialerInCallService.setMicMuted(muted)) {
            JSObject ret = new JSObject();
            ret.put("micMuted", muted);
            call.resolve(ret);
        } else {
            call.reject("no active call");
        }
    }

    // ---------- contacts (ContactsContract: включает синхронизированные Google-контакты) ----------

    // Открывает системный редактор контактов с предзаполненными полями.
    // Пользователь сам выбирает аккаунт (обычно Google) и сохраняет —
    // контакт сразу виден приложению через ContactsContract.
    @PluginMethod
    public void openContactEditor(PluginCall call) {
        String name = call.getString("name", "");
        String number = call.getString("number", "");
        try {
            Intent intent = new Intent(Intent.ACTION_INSERT, ContactsContract.Contacts.CONTENT_URI);
            if (name != null && !name.isEmpty()) {
                intent.putExtra(ContactsContract.Intents.Insert.NAME, name);
            }
            if (number != null && !number.isEmpty()) {
                intent.putExtra(ContactsContract.Intents.Insert.PHONE, number);
            }
            startActivityForResult(call, intent, "onContactEditorFinished");
        } catch (Exception e) {
            call.reject("contact editor failed: " + e.getMessage());
        }
    }

    @ActivityCallback
    private void onContactEditorFinished(PluginCall call, ActivityResult result) {
        JSObject ret = new JSObject();
        ret.put("saved", result.getResultCode() == Activity.RESULT_OK);
        call.resolve(ret);
    }

    // Правка существующего контакта в системном редакторе (тот же Google).
    // contactId — числовой ContactsContract.Contacts._ID (JS передаёт число
    // из id вида "device-<id>").
    @PluginMethod
    public void openContactEditorForEdit(PluginCall call) {
        String contactId = call.getString("contactId", "");
        long id;
        try {
            id = Long.parseLong(contactId);
        } catch (Exception e) {
            call.reject("bad contactId");
            return;
        }
        try {
            Uri uri = ContentUris.withAppendedId(ContactsContract.Contacts.CONTENT_URI, id);
            Intent intent = new Intent(Intent.ACTION_EDIT, uri);
            startActivityForResult(call, intent, "onContactEditorFinished");
        } catch (Exception e) {
            call.reject("contact editor failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void playDtmfTone(PluginCall call) {
        String tone = call.getString("tone", "");
        if (tone == null || tone.length() != 1 || "0123456789*#".indexOf(tone.charAt(0)) < 0) {
            call.reject("bad tone");
            return;
        }
        if (DialerInCallService.playDtmf(tone.charAt(0))) {
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
        } else {
            call.reject("no active call");
        }
    }

    // Уведомления о звонках (Android 13+): без рантайм-разрешения входящий
    // при свёрнутом приложении показать нечем. На старых версиях — сразу ок.
    @PluginMethod
    public void ensureNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
            return;
        }
        if (getPermissionState("notifications") == PermissionState.GRANTED) {
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
            return;
        }
        requestPermissionForAliases(new String[]{"notifications"}, call, "onNotificationsPerms");
    }

    @PermissionCallback
    private void onNotificationsPerms(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("ok", getPermissionState("notifications") == PermissionState.GRANTED);
        call.resolve(ret);
    }

    // Android 14+: может ли приложение слать полноэкранные интенты.
    // Если false — система показывает только плашку, будить не будет:
    // пользователю нужно разрешить в настройках приложения.
    @PluginMethod
    public void canUseFullScreenIntent(PluginCall call) {
        boolean ok = true;
        if (Build.VERSION.SDK_INT >= 34) {
            try {
                NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm != null) ok = nm.canUseFullScreenIntent();
            } catch (Exception e) {
                ok = false;
            }
        }
        JSObject ret = new JSObject();
        ret.put("ok", ok);
        call.resolve(ret);
    }

    @PluginMethod
    public void getCurrentCall(PluginCall call) {
        JSObject snap = DialerInCallService.snapshotCurrentCall();
        if (snap == null) {
            call.reject("no call");
            return;
        }
        call.resolve(snap);
    }

    @PluginMethod
    public void getContacts(PluginCall call) {
        if (getPermissionState("contacts") != PermissionState.GRANTED) {
            requestPermissionForAliases(new String[]{"contacts"}, call, "onContactsPerms");
            return;
        }
        resolveContacts(call);
    }

    @PermissionCallback
    private void onContactsPerms(PluginCall call) {
        if (getPermissionState("contacts") == PermissionState.GRANTED) {
            resolveContacts(call);
        } else {
            call.reject("contacts permission denied");
        }
    }

    private void resolveContacts(PluginCall call) {
        JSArray arr = new JSArray();
        String[] proj = {
            ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
            ContactsContract.CommonDataKinds.Phone.NUMBER,
            ContactsContract.CommonDataKinds.Phone.PHOTO_URI,
            ContactsContract.CommonDataKinds.Phone.CONTACT_ID
        };
        try (Cursor c = getContext().getContentResolver().query(
                ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                proj, null, null,
                ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " ASC")) {
            if (c != null) {
                while (c.moveToNext()) {
                    JSObject o = new JSObject();
                    o.put("name", c.getString(0));
                    o.put("number", c.getString(1));
                    o.put("photoUri", c.isNull(2) ? null : c.getString(2));
                    o.put("id", "device-" + c.getLong(3));
                    arr.put(o);
                }
            }
        } catch (Exception e) {
            call.reject("contacts query failed: " + e.getMessage());
            return;
        }
        JSObject ret = new JSObject();
        ret.put("contacts", arr);
        call.resolve(ret);
    }

    // ---------- call log (системный CallLog.Calls) ----------

    @PluginMethod
    public void getCallLog(PluginCall call) {
        if (getPermissionState("callLog") != PermissionState.GRANTED) {
            requestPermissionForAliases(new String[]{"callLog"}, call, "onCallLogPerms");
            return;
        }
        resolveCallLog(call);
    }

    @PermissionCallback
    private void onCallLogPerms(PluginCall call) {
        if (getPermissionState("callLog") == PermissionState.GRANTED) {
            resolveCallLog(call);
        } else {
            call.reject("call log permission denied");
        }
    }

    private void resolveCallLog(PluginCall call) {
        int limit = call.getInt("limit", 200);
        JSArray arr = new JSArray();
        String[] proj = {
            CallLog.Calls._ID,
            CallLog.Calls.NUMBER,
            CallLog.Calls.TYPE,
            CallLog.Calls.DATE,
            CallLog.Calls.DURATION
        };
        try (Cursor c = getContext().getContentResolver().query(
                CallLog.Calls.CONTENT_URI,
                proj, null, null,
                CallLog.Calls.DATE + " DESC")) {
            if (c != null) {
                int count = 0;
                while (c.moveToNext() && count < limit) {
                    count++;
                    JSObject o = new JSObject();
                    o.put("id", "sys-" + c.getLong(0));
                    o.put("number", c.getString(1));
                    o.put("type", mapCallType(c.getInt(2)));
                    o.put("timestamp", c.getLong(3));
                    o.put("durationSec", c.getInt(4));
                    arr.put(o);
                }
            }
        } catch (Exception e) {
            call.reject("call log query failed: " + e.getMessage());
            return;
        }
        JSObject ret = new JSObject();
        ret.put("entries", arr);
        call.resolve(ret);
    }

    private String mapCallType(int type) {
        switch (type) {
            case CallLog.Calls.OUTGOING_TYPE: return "outgoing";
            case CallLog.Calls.INCOMING_TYPE: return "incoming";
            case CallLog.Calls.MISSED_TYPE: return "missed";
            default: return "missed";
        }
    }
}
