package com.gypopo.dialer;

import android.os.Build;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
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
    }

    // Системная кнопка/жест «назад»: сначала закрываем слои интерфейса через
    // историю WebView (popstate гасит экраны по одному — как стрелка «назад»
    // в шапке), и только на корневом экране сворачиваем приложение.
    // Отдельный хук через плагин App не используется: пакета @capacitor/app
    // в сборке нет, поэтому его addListener молча не срабатывал и жест
    // всегда сворачивал приложение, не закрывая «Историю»/«Контакты».
    @Override
    public void onBackPressed() {
        try {
            if (bridge != null && bridge.getWebView() != null && bridge.getWebView().canGoBack()) {
                bridge.getWebView().goBack();
                return;
            }
        } catch (Exception ignored) {
            // Мост недоступен — падаем на сворачивание ниже.
        }
        try {
            moveTaskToBack(true);
        } catch (Exception ignored) {
            super.onBackPressed();
        }
    }
}
