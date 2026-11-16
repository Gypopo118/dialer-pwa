package com.gypopo.dialer;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.app.role.RoleManager;
import android.content.ComponentName;
import android.content.ContentUris;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.CallLog;
import android.provider.ContactsContract;
import android.telecom.PhoneAccountHandle;
import android.telecom.TelecomManager;
import android.telephony.SubscriptionInfo;
import android.telephony.SubscriptionManager;
import android.view.HapticFeedbackConstants;

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

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

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
            Manifest.permission.READ_PHONE_STATE
        }, alias = "phone"),
        @Permission(strings = { Manifest.permission.ANSWER_PHONE_CALLS }, alias = "answer"),
        // Микрофон для самого звонка не нужен (управление идёт через
        // InCallService); алиас оставлен под будущие аудио-функции.
        @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = "mic"),
        @Permission(strings = { Manifest.permission.SEND_SMS }, alias = "sms"),
        @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications")
    }
)
public class DialerTelecomPlugin extends Plugin {

    private static final String PREFS_NAME = "dialer_prefs";
    private static final String KEY_SELECTED_SIM = "selected_sim_subscription_id";

    private static DialerTelecomPlugin instance;

    // Номер из внешнего tel:-интента (меню «Открыть с помощью» в браузере),
    // доставленный до загрузки WebView. JS забирает его один раз при старте
    // через getPendingDialNumber().
    private static String pendingDialNumber;

    // Слушатель смены SIM (вставили/вынули лоток, включили/отключили карту,
    // сменили SIM по умолчанию). Живёт, пока жив плагин.
    private SubscriptionManager.OnSubscriptionsChangedListener subsListener;

    @Override
    public void load() {
        instance = this;
        DialerInCallService.setPlugin(this);
    }

    @Override
    protected void handleOnDestroy() {
        unregisterSubscriptionsListener();
        if (instance == this) {
            instance = null;
            DialerInCallService.setPlugin(null);
        }
    }

    // Возврат приложения на передний план. WebView перечитывает живое
    // состояние звонка через getCurrentCall, чтобы экран приёма/разговора
    // вернулся после сворачивания или тапа по уведомлению. Пакета
    // @capacitor/app в сборке нет — используем штатный хук Capacitor.
    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        emit("appResume", new JSObject());
    }

    static void emit(String event, JSObject data) {
        DialerTelecomPlugin p = instance;
        if (p != null) {
            p.notifyListeners(event, data);
        }
    }

    // ---------- внешний tel:-intent («Открыть с помощью» из браузера) ----------

    // Достаёт номер из intent'а меню «Открыть с помощью»: ACTION_DIAL и
    // ACTION_VIEW с data tel:... (так присылают браузеры и мессенджеры,
    // когда тапают по номеру). Плюс фолбэк на устаревший EXTRA_PHONE_NUMBER.
    // Возвращает null, если intent не про телефонный номер.
    static String extractNumberFromIntent(Intent intent) {
        if (intent == null || intent.getAction() == null) return null;
        try {
            String action = intent.getAction();
            if (Intent.ACTION_DIAL.equals(action) || Intent.ACTION_VIEW.equals(action)) {
                Uri data = intent.getData();
                if (data != null && "tel".equalsIgnoreCase(data.getScheme())) {
                    String ssp = data.getSchemeSpecificPart();
                    if (ssp != null && !ssp.trim().isEmpty()) return ssp;
                }
                if (Intent.ACTION_DIAL.equals(action)) {
                    String extra = intent.getStringExtra(Intent.EXTRA_PHONE_NUMBER);
                    if (extra != null && !extra.trim().isEmpty()) return extra;
                }
            }
        } catch (Exception ignored) {
            // Чужой malformed intent — просто нет номера.
        }
        return null;
    }

    // Кладёт номер из внешнего intent'а: в pending (холодный старт — JS ещё
    // не подписан, заберёт запросом) и событием 'dialIntent' (тёплый старт —
    // слушатель уже висит, номер уходит в WebView сразу).
    static void setPendingDialNumber(String number) {
        if (number == null || number.trim().isEmpty()) return;
        pendingDialNumber = number;
        JSObject data = new JSObject();
        data.put("number", number);
        emit("dialIntent", data);
    }

    // JS забирает pending-номер один раз после загрузки (холодный старт).
    @PluginMethod
    public void getPendingDialNumber(PluginCall call) {
        JSObject ret = new JSObject();
        String number = pendingDialNumber;
        pendingDialNumber = null;
        ret.put("number", number == null ? "" : number);
        call.resolve(ret);
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
            // Выбранная карта передаётся ровно тем ключом, который понимает
            // Telecom: PhoneAccountHandle в Bundle. Слот-индексы не используем.
            Bundle extras = new Bundle();
            PhoneAccountHandle handle = resolveSelectedHandle(call, tm);
            if (handle != null) {
                extras.putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle);
            }
            Uri uri = Uri.fromParts("tel", number, null);
            tm.placeCall(uri, extras);
            // Датчик сразу: не ждём DIALING/ACTIVE от Telecom.
            DialerInCallService.noteCallStarted();
            JSObject ret = new JSObject();
            ret.put("placed", true);
            call.resolve(ret);
        } catch (SecurityException se) {
            call.reject("permission: " + se.getMessage());
        } catch (Exception e) {
            call.reject("placeCall failed: " + e.getMessage());
        }
    }

    // PhoneAccountHandle из токена, который вернул getSims(). Если токена нет,
    // пробуем subscriptionId (он не слот-индекс и однозначно указывает карту),
    // и только потом оставляем выбор системе.
    private PhoneAccountHandle resolveSelectedHandle(PluginCall call, TelecomManager tm) {
        PhoneAccountHandle handle = decodePhoneAccount(call.getString("phoneAccountId"));
        if (handle == null) {
            Integer subId = call.getInt("subscriptionId");
            if (subId != null && subId >= 0) {
                try {
                    handle = tm.getPhoneAccountHandleForSubscriptionId(subId);
                } catch (Exception ignored) {
                    // нет доступа/аккаунта — звонок уйдёт через SIM по умолчанию
                }
            }
        }
        return handle;
    }

    // ---------- SIM cards ----------

    // Список активных SIM для умной кнопки вызова: имя оператора, слот и
    // PhoneAccountHandle. silent=true не поднимает диалог разрешений (нужно
    // для фонового обновления при возврате в приложение).
    @PluginMethod
    public void getSims(PluginCall call) {
        Boolean requestedSilent = call.getBoolean("silent");
        boolean silent = requestedSilent != null && requestedSilent;
        if (getPermissionState("phone") != PermissionState.GRANTED) {
            if (silent) {
                call.resolve(emptySimsReply());
                return;
            }
            requestPermissionForAliases(new String[]{"phone"}, call, "onPhonePermsForSims");
            return;
        }
        resolveSims(call);
    }

    @PermissionCallback
    private void onPhonePermsForSims(PluginCall call) {
        if (getPermissionState("phone") == PermissionState.GRANTED) {
            resolveSims(call);
        } else {
            call.resolve(emptySimsReply());
        }
    }

    private JSObject emptySimsReply() {
        JSObject ret = new JSObject();
        ret.put("sims", new JSArray());
        ret.put("denied", true);
        return ret;
    }

    private void resolveSims(PluginCall call) {
        ensureSubscriptionsListener();
        JSObject ret = new JSObject();
        ret.put("sims", buildSimsArray());
        call.resolve(ret);
    }

    private JSArray buildSimsArray() {
        JSArray arr = new JSArray();
        try {
            SubscriptionManager sm = subscriptionManager();
            TelecomManager tm = (TelecomManager) getContext().getSystemService(Context.TELECOM_SERVICE);
            if (sm == null) return arr;
            List<SubscriptionInfo> infos = sm.getActiveSubscriptionInfoList();
            if (infos == null || infos.isEmpty()) return arr;

            List<SubscriptionInfo> sorted = new ArrayList<>(infos);
            Collections.sort(sorted, (a, b) -> Integer.compare(a.getSimSlotIndex(), b.getSimSlotIndex()));

            List<PhoneAccountHandle> callAccounts = null;
            if (tm != null) {
                try {
                    callAccounts = tm.getCallCapablePhoneAccounts();
                } catch (Exception ignored) {
                    // без READ_PHONE_STATE провайдер может не отдать аккаунты
                }
            }

            for (SubscriptionInfo info : sorted) {
                if (info == null || info.getSimSlotIndex() < 0) continue;
                JSObject o = new JSObject();
                o.put("subscriptionId", info.getSubscriptionId());
                o.put("slotIndex", info.getSimSlotIndex());
                o.put("name", pickSimName(info));

                PhoneAccountHandle handle = null;
                if (tm != null) {
                    try {
                        handle = tm.getPhoneAccountHandleForSubscriptionId(info.getSubscriptionId());
                    } catch (Exception ignored) {
                        // оставляем без handle — звонок уйдёт по выбору системы
                    }
                }
                // Если Telecom вернул список call-capable аккаунтов, а нашего
                // handle в нём нет — не подсовываем его в placeCall.
                if (handle != null && callAccounts != null && !callAccounts.isEmpty() && !callAccounts.contains(handle)) {
                    handle = null;
                }
                if (handle != null) {
                    String encoded = encodePhoneAccount(handle);
                    if (encoded != null) o.put("phoneAccountId", encoded);
                }
                arr.put(o);
            }
        } catch (Exception ignored) {
            // нет разрешения/провайдер недоступен — вернём пустой список
        }
        return arr;
    }

    // displayName (пользовательское имя) важнее carrierName. Служебные
    // заглушки вроде «CARD 1»/«No service» заменяем на «SIM N» по слоту.
    private String pickSimName(SubscriptionInfo info) {
        String display = charSequenceToString(info.getDisplayName());
        String carrier = charSequenceToString(info.getCarrierName());
        String name = !display.isEmpty() ? display : carrier;
        if (isPlaceholderSimName(name)) name = "";
        if (name.isEmpty()) {
            int slot = info.getSimSlotIndex();
            name = "SIM " + (slot >= 0 ? slot + 1 : 1);
        }
        return name;
    }

    private static String charSequenceToString(CharSequence value) {
        return value == null ? "" : value.toString().trim();
    }

    private static boolean isPlaceholderSimName(String name) {
        if (name == null) return true;
        String n = name.trim().toLowerCase(Locale.ROOT);
        if (n.isEmpty()) return true;
        if (n.equals("no service") || n.equals("unknown") || n.equals("android")) return true;
        return n.matches("^(card|sim)\\s*\\d+$");
    }

    // PhoneAccountHandle нельзя отдать в JS как объект — сериализуем в
    // непрозрачный токен и восстанавливаем перед placeCall.
    private static String encodePhoneAccount(PhoneAccountHandle handle) {
        try {
            return handle.getComponentName().flattenToString() + "|" + Uri.encode(handle.getId());
        } catch (Exception e) {
            return null;
        }
    }

    private static PhoneAccountHandle decodePhoneAccount(String encoded) {
        if (encoded == null || encoded.isEmpty()) return null;
        int sep = encoded.lastIndexOf('|');
        if (sep <= 0 || sep >= encoded.length() - 1) return null;
        try {
            ComponentName cn = ComponentName.unflattenFromString(encoded.substring(0, sep));
            String id = Uri.decode(encoded.substring(sep + 1));
            if (cn == null || id == null || id.isEmpty()) return null;
            return new PhoneAccountHandle(cn, id);
        } catch (Exception e) {
            return null;
        }
    }

    private SubscriptionManager subscriptionManager() {
        try {
            return (SubscriptionManager) getContext().getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE);
        } catch (Exception e) {
            return null;
        }
    }

    private void ensureSubscriptionsListener() {
        if (subsListener != null) return;
        final SubscriptionManager sm = subscriptionManager();
        if (sm == null) return;
        final SubscriptionManager.OnSubscriptionsChangedListener listener =
            new SubscriptionManager.OnSubscriptionsChangedListener() {
                @Override
                public void onSubscriptionsChanged() {
                    JSObject ret = new JSObject();
                    ret.put("sims", buildSimsArray());
                    emit("simsChanged", ret);
                }
            };
        subsListener = listener;
        try {
            getBridge().executeOnMainThread(() -> {
                try {
                    if (subsListener != listener) return; // плагин уже уничтожен
                    sm.addOnSubscriptionsChangedListener(listener);
                } catch (Exception e) {
                    if (subsListener == listener) subsListener = null;
                }
            });
        } catch (Exception e) {
            subsListener = null;
        }
    }

    private void unregisterSubscriptionsListener() {
        SubscriptionManager.OnSubscriptionsChangedListener listener = subsListener;
        subsListener = null;
        if (listener == null) return;
        try {
            SubscriptionManager sm = subscriptionManager();
            if (sm != null) sm.removeOnSubscriptionsChangedListener(listener);
        } catch (Exception ignored) {
            // плагин уже отцеплен — чистить нечего
        }
    }

    // Выбранная SIM хранится в SharedPreferences (переживает перезапуск
    // WebView/приложения). JS дублирует её в localStorage для PWA-режима.
    @PluginMethod
    public void getSelectedSim(PluginCall call) {
        SharedPreferences sp = getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        JSObject ret = new JSObject();
        ret.put("subscriptionId", sp.getInt(KEY_SELECTED_SIM, -1));
        call.resolve(ret);
    }

    @PluginMethod
    public void setSelectedSim(PluginCall call) {
        Integer value = call.getInt("subscriptionId");
        int id = value != null ? value : -1;
        SharedPreferences sp = getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        sp.edit().putInt(KEY_SELECTED_SIM, id).apply();
        call.resolve();
    }

    // Лёгкий тактильный щелчок при пересечении порога свайпа SIM.
    // CLOCK_TICK — системный tick, не требующий VIBRATE.
    @PluginMethod
    public void hapticTick(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("no activity");
            return;
        }
        activity.runOnUiThread(() -> {
            try {
                getBridge().getWebView().performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK);
                JSObject ret = new JSObject();
                ret.put("ok", true);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("haptic failed: " + e.getMessage());
            }
        });
    }

    // ---------- in-call control (делегируется активному InCallService) ----------

    @PluginMethod
    public void answerCall(PluginCall call) {
        if (getPermissionState("answer") != PermissionState.GRANTED) {
            requestPermissionForAliases(new String[]{"answer"}, call, "onAnswerPerms");
            return;
        }
        doAnswer(call);
    }

    @PermissionCallback
    private void onAnswerPerms(PluginCall call) {
        if (getPermissionState("answer") == PermissionState.GRANTED) {
            doAnswer(call);
        } else {
            call.reject("answer permission denied");
        }
    }

    private void doAnswer(PluginCall call) {
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
    // из id вида "device-<id>"). lookupKey — опциональный, имеет приоритет:
    // переживает слияние/переиндексацию контакта.
    @PluginMethod
    public void openContactEditorForEdit(PluginCall call) {
        String contactId = call.getString("contactId", "");
        String lookupKey = call.getString("lookupKey", "");
        long id = 0;
        boolean hasId = false;
        try {
            id = Long.parseLong(contactId);
            hasId = true;
        } catch (Exception ignored) {
        }
        try {
            Uri uri;
            if (lookupKey != null && !lookupKey.isEmpty()) {
                uri = ContactsContract.Contacts.getLookupUri(id, lookupKey);
            } else if (hasId) {
                uri = ContentUris.withAppendedId(ContactsContract.Contacts.CONTENT_URI, id);
            } else {
                call.reject("bad contactId");
                return;
            }
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

    // Поверх всех окон (нужно для пробуждения заблокированного телефона
    // дублем к полноэкранному интенту). Запрашивается один раз при старте.
    @PluginMethod
    public void ensureOverlayPermission(PluginCall call) {
        boolean ok = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                if (!android.provider.Settings.canDrawOverlays(getContext())) {
                    ok = false;
                    Intent intent = new Intent(
                        android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        Uri.parse("package:" + getContext().getPackageName()));
                    startActivityForResult(call, intent, "onOverlayResult");
                    return;
                }
            } catch (Exception e) {
                call.reject("overlay request failed: " + e.getMessage());
                return;
            }
        }
        JSObject ret = new JSObject();
        ret.put("ok", ok);
        call.resolve(ret);
    }

    @ActivityCallback
    private void onOverlayResult(PluginCall call, ActivityResult result) {
        boolean ok = true;
        try {
            ok = android.provider.Settings.canDrawOverlays(getContext());
        } catch (Exception ignored) {
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

    // SMS-отбой: моментальное SMS звонящему номеру. Отправка напрямую через
    // SmsManager (default SMS app не требуется); длинные/кириллические тексты
    // режутся на части автоматически.
    @PluginMethod
    public void sendSms(PluginCall call) {
        String number = call.getString("number", "");
        String text = call.getString("text", "");
        if (number.isEmpty() || text.isEmpty()) {
            call.reject("number and text required");
            return;
        }
        if (getPermissionState("sms") != PermissionState.GRANTED) {
            requestPermissionForAliases(new String[]{"sms"}, call, "onSmsPerms");
            return;
        }
        doSendSms(call);
    }

    @PermissionCallback
    private void onSmsPerms(PluginCall call) {
        if (getPermissionState("sms") == PermissionState.GRANTED) {
            doSendSms(call);
        } else {
            call.reject("sms permission denied");
        }
    }

    private void doSendSms(PluginCall call) {
        String number = call.getString("number", "");
        String text = call.getString("text", "");
        try {
            android.telephony.SmsManager sms = android.telephony.SmsManager.getDefault();
            java.util.ArrayList<String> parts = sms.divideMessage(text);
            sms.sendMultipartTextMessage(number, null, parts, null, null);
            JSObject ret = new JSObject();
            ret.put("sent", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("sms failed: " + e.getMessage());
        }
    }

    // Байты фото контакта (миниатюра из провайдера) в base64.
    // Нужны, когда WebView не открывает content:// напрямую: мост всегда может.
    @PluginMethod
    public void getContactPhoto(PluginCall call) {
        String contactId = call.getString("contactId", "");
        long id;
        try {
            id = Long.parseLong(contactId);
        } catch (Exception e) {
            call.reject("bad contactId");
            return;
        }
        if (getPermissionState("contacts") != PermissionState.GRANTED) {
            requestPermissionForAliases(new String[]{"contacts"}, call, "onPhotoPerms");
            return;
        }
        resolvePhoto(call, id);
    }

    @PermissionCallback
    private void onPhotoPerms(PluginCall call) {
        if (getPermissionState("contacts") == PermissionState.GRANTED) {
            try {
                resolvePhoto(call, Long.parseLong(call.getString("contactId", "")));
            } catch (Exception e) {
                call.reject("bad contactId");
            }
        } else {
            call.reject("contacts permission denied");
        }
    }

    private void resolvePhoto(PluginCall call, long id) {
        android.net.Uri uri = android.content.ContentUris.withAppendedId(
            ContactsContract.Contacts.CONTENT_URI, id);
        String photoUri = null;
        android.database.Cursor c = null;
        try {
            c = getContext().getContentResolver().query(
                uri, new String[]{ ContactsContract.Contacts.PHOTO_URI }, null, null, null);
            if (c != null && c.moveToFirst()) photoUri = c.getString(0);
        } catch (Exception e) {
            call.reject("photo query failed: " + e.getMessage());
            return;
        } finally {
            if (c != null) c.close();
        }
        if (photoUri == null) {
            call.reject("no photo");
            return;
        }
        try (java.io.InputStream in = getContext().getContentResolver().openInputStream(
                android.net.Uri.parse(photoUri))) {
            if (in == null) {
                call.reject("no photo");
                return;
            }
            java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int n;
            while ((n = in.read(chunk)) != -1) buf.write(chunk, 0, n);
            String b64 = android.util.Base64.encodeToString(buf.toByteArray(), android.util.Base64.NO_WRAP);
            JSObject ret = new JSObject();
            ret.put("photo", b64);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("photo read failed: " + e.getMessage());
        }
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
            ContactsContract.CommonDataKinds.Phone.CONTACT_ID,
            ContactsContract.CommonDataKinds.Phone.NORMALIZED_NUMBER
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
                    o.put("normalizedNumber", c.isNull(4) ? null : c.getString(4));
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

    // Резолв «номер → контакт» тем же механизмом, что у системной звонилки:
    // PhoneLookup.CONTENT_FILTER_URI формат-независим (любое написание номера
    // даёт один контакт). Пустой cursor → {contact:null}; без разрешения —
    // reject (JS ловит и уходит в fallback, наружу не пробрасывается).
    @PluginMethod
    public void lookupContactByNumber(PluginCall call) {
        String number = call.getString("number", "");
        if (getPermissionState("contacts") != PermissionState.GRANTED) {
            call.reject("contacts permission denied");
            return;
        }
        Uri uri = Uri.withAppendedPath(
            ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number));
        String[] proj = {
            ContactsContract.PhoneLookup.DISPLAY_NAME,
            ContactsContract.PhoneLookup.CONTACT_ID,
            ContactsContract.PhoneLookup.LOOKUP_KEY,
            ContactsContract.PhoneLookup.PHOTO_URI,
            ContactsContract.PhoneLookup.NUMBER
        };
        JSObject contact = null;
        try (Cursor c = getContext().getContentResolver().query(uri, proj, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                contact = new JSObject();
                contact.put("name", c.isNull(0) ? null : c.getString(0));
                contact.put("id", "device-" + c.getLong(1));
                contact.put("lookupKey", c.isNull(2) ? null : c.getString(2));
                contact.put("photoUri", c.isNull(3) ? null : c.getString(3));
                contact.put("number", c.isNull(4) ? null : c.getString(4));
            }
        } catch (Exception e) {
            call.reject("contact lookup failed: " + e.getMessage());
            return;
        }
        call.resolve(new JSObject().put("contact", contact));
    }

    // ---------- call log (системный CallLog.Calls) ----------

    @PluginMethod
    public void getCallLog(PluginCall call) {
        if (getPermissionState("callLog") != PermissionState.GRANTED) {
            // Тихий режим (экран входящего звонка): не поднимаем диалог
            // разрешений поверх кнопок «Принять/Отклонить». Сообщаем, что
            // журнал недоступен, — UI скроет блок истории, а не покажет
            // ложное «Новый звонок».
            if (Boolean.TRUE.equals(call.getBoolean("silent", false))) {
                JSObject ret = new JSObject();
                ret.put("entries", new JSArray());
                ret.put("denied", true);
                call.resolve(ret);
                return;
            }
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
            CallLog.Calls.DURATION,
            CallLog.Calls.CACHED_NAME
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
                    o.put("cachedName", c.isNull(5) ? null : c.getString(5));
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

    // «Удалить запись» в меню плашки недавних: вычищаем из системного
    // CallLog все записи, совпадающие по правилу группировки приложения
    // (хвост из 8 цифр — тот же собеседник в локальном и международном
    // написании). Как и чтение, требует разрешения callLog (READ+WRITE).
    @PluginMethod
    public void deleteCallLogForNumber(PluginCall call) {
        if (getPermissionState("callLog") != PermissionState.GRANTED) {
            requestPermissionForAliases(new String[]{"callLog"}, call, "onDeleteCallLogPerms");
            return;
        }
        resolveDeleteCallLog(call);
    }

    @PermissionCallback
    private void onDeleteCallLogPerms(PluginCall call) {
        if (getPermissionState("callLog") == PermissionState.GRANTED) {
            resolveDeleteCallLog(call);
        } else {
            call.reject("call log permission denied");
        }
    }

    private void resolveDeleteCallLog(PluginCall call) {
        String number = call.getString("number");
        if (number == null || number.trim().isEmpty()) {
            call.reject("number required");
            return;
        }
        String key = callLogGroupKey(number);
        java.util.ArrayList<String> ids = new java.util.ArrayList<>();
        try (Cursor c = getContext().getContentResolver().query(
                CallLog.Calls.CONTENT_URI,
                new String[]{CallLog.Calls._ID, CallLog.Calls.NUMBER},
                null, null, null)) {
            if (c != null) {
                while (c.moveToNext()) {
                    String n = c.getString(1);
                    if (n != null && key.equals(callLogGroupKey(n))) {
                        ids.add(String.valueOf(c.getLong(0)));
                    }
                }
            }
        } catch (Exception e) {
            call.reject("call log query failed: " + e.getMessage());
            return;
        }
        if (!ids.isEmpty()) {
            String selection = CallLog.Calls._ID + " IN (" + android.text.TextUtils.join(",", ids) + ")";
            getContext().getContentResolver().delete(CallLog.Calls.CONTENT_URI, selection, null);
        }
        JSObject ret = new JSObject();
        ret.put("deleted", ids.size());
        call.resolve(ret);
    }

    // Ключ группировки номера — как в JS (utils/format.js, groupKeyForNumber):
    // хвост из 8 цифр у полных номеров, короткие сервисные (112 и т.п.) целиком.
    private static String callLogGroupKey(String number) {
        StringBuilder digits = new StringBuilder();
        for (int i = 0; i < number.length(); i++) {
            char ch = number.charAt(i);
            if (ch >= '0' && ch <= '9') digits.append(ch);
        }
        String d = digits.toString();
        return d.length() >= 8 ? d.substring(d.length() - 8) : d;
    }

    // ---------- clipboard ----------
    // Текст системного буфера обмена. Отдельного разрешения не требует:
    // приложение на переднем плане читает буфер свободно (Android 10+),
    // система сама покажет тост «приложение вставило из буфера».
    // Нужен, т.к. navigator.clipboard.readText() в WebView часто
    // заблокирован и молча падает — кнопка «Вставить» ничего не делает.
    @PluginMethod
    public void getClipboardText(PluginCall call) {
        try {
            android.content.ClipboardManager cm =
                (android.content.ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
            JSObject ret = new JSObject();
            if (cm == null || !cm.hasPrimaryClip()) {
                ret.put("text", "");
                call.resolve(ret);
                return;
            }
            android.content.ClipData clip = cm.getPrimaryClip();
            String text = "";
            if (clip != null && clip.getItemCount() > 0) {
                CharSequence cs = clip.getItemAt(0).coerceToText(getContext());
                if (cs != null) text = cs.toString();
            }
            ret.put("text", text);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("clipboard read failed: " + e.getMessage());
        }
    }
}
