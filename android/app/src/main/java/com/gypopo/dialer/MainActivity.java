package com.gypopo.dialer;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    // Тег для проверки в Logcat: adb logcat -s DialerBack
    private static final String TAG = "DialerBack";

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
        // Параллельно хук через плагин App (@capacitor/app) НЕ подключаем:
        // его нет в сборке, а двойная обработка пропускала бы экраны.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
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

    private void handleDialIntent(Intent intent) {
        String number = DialerTelecomPlugin.extractNumberFromIntent(intent);
        if (number != null) {
            DialerTelecomPlugin.setPendingDialNumber(number);
        }
    }
}
