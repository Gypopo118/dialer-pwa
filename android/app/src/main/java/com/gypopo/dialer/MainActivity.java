package com.gypopo.dialer;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    // Тег для проверки в Logcat: adb logcat -s DialerBack
    private static final String TAG = "DialerBack";
    private boolean imeWasVisible = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DialerTelecomPlugin.class);
        super.onCreate(savedInstanceState);
        // Экран звонка доступен поверх блокировки: принять/отклонить можно
        // без ввода PIN — как у штатной звонилки. Разблокировки ключом нет.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        }
        watchImeDismiss();
        // Номер из меню «Открыть с помощью» (tel:-intent из браузера).
        // Холодный старт: WebView ещё не загружен, слушать событие некому —
        // номер складывается в pending внутри плагина, JS заберёт его
        // запросом после загрузки (см. DialerTelecomPlugin.getPendingDialNumber).
        handleDialIntent(getIntent());
        // Системная кнопка/жест «назад» (targetSdk 36, predictive back):
        // каноничный путь — OnBackPressedCallback через диспетчер, а не
        // переопределение устаревшего onBackPressed(), до которого жест
        // на современных Android может не доходить.
        // Логика та же: слои интерфейса закрываем через историю WebView
        // (goBack -> popstate гасит экраны по одному, как стрелка «назад»
        // в шапке), и только на корневом экране сворачиваем приложение.
        // Исключение — живой звонок: его экран не закрываем (см. ниже).
        // Параллельно хук через плагин App (@capacitor/app) НЕ подключаем:
        // его нет в сборке, а двойная обработка пропускала бы экраны.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                // Живой звонок: экран приёма/разговора не закрываем и вызов
                // не трогаем — сворачиваем приложение, как штатная звонилка.
                // Повторное открытие (иконка/уведомление) вернёт на этот же
                // экран; WebView и его история остаются нетронутыми.
                if (DialerInCallService.hasLiveCall()) {
                    Log.d(TAG, "callback: live call -> moveTaskToBack");
                    try {
                        moveTaskToBack(true);
                    } catch (Exception ignored) {
                        // Крайний фолбэк — дефолтное поведение диспетчера.
                    }
                    return;
                }
                try {
                    if (bridge != null && bridge.getWebView() != null && bridge.getWebView().canGoBack()) {
                        Log.d(TAG, "callback: canGoBack=true -> WebView.goBack()");
                        bridge.getWebView().goBack();
                        return;
                    }
                    Log.d(TAG, "callback: root (canGoBack=false) -> moveTaskToBack");
                } catch (Exception e) {
                    Log.d(TAG, "callback: bridge failed (" + e.getMessage() + "), fallback to minimize");
                }
                try {
                    moveTaskToBack(true);
                } catch (Exception ignored) {
                    // Крайний фолбэк — дефолтное поведение диспетчера.
                    setEnabled(false);
                    try {
                        getOnBackPressedDispatcher().onBackPressed();
                    } finally {
                        setEnabled(true);
                    }
                }
            }
        });
    }

    // Тёплый старт (launchMode="singleTask", приложение свёрнуто): Android
    // доставляет новый intent сюда, а не пересоздаёт activity. WebView жив,
    // слушатель 'dialIntent' уже подписан — номер уходит в UI сразу.
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleDialIntent(intent);
    }

    // Клавиатура Android (IME) забирает первый жест «назад» себе: сначала
    // прячется она, и только следующий жест доходит до onBackPressed.
    // В режиме поиска это давало два нажатия вместо одного, поэтому ловим
    // скрытие IME по insets и сообщаем JS: если открыт поиск, он закроется
    // тем же жестом (см. home-screen.js, событие 'dialer:ime-hidden').
    private void watchImeDismiss() {
        if (bridge == null || bridge.getWebView() == null) return;
        final WebView webView = bridge.getWebView();
        ViewCompat.setOnApplyWindowInsetsListener(webView, (v, insets) -> {
            boolean imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime());
            if (imeWasVisible && !imeVisible) {
                v.post(() -> webView.evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent('dialer:ime-hidden'))", null));
            }
            imeWasVisible = imeVisible;
            return insets;
        });
    }

    private void handleDialIntent(Intent intent) {
        String number = DialerTelecomPlugin.extractNumberFromIntent(intent);
        if (number != null) {
            DialerTelecomPlugin.setPendingDialNumber(number);
        }
    }
}
