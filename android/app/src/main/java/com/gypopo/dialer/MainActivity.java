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
}
