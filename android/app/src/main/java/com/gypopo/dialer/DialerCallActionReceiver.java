package com.gypopo.dialer;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Кнопки «Принять» / «Отклонить» в уведомлении о входящем звонке.
 * Работают даже когда приложение свёрнуто: система поднимет процесс
 * для доставки broadcast, а звонком управляет живой InCallService.
 */
public class DialerCallActionReceiver extends BroadcastReceiver {

    public static final String ACTION_ANSWER = "com.gypopo.dialer.ANSWER_CALL";
    public static final String ACTION_DECLINE = "com.gypopo.dialer.DECLINE_CALL";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        String action = intent.getAction();
        if (ACTION_ANSWER.equals(action)) {
            DialerInCallService.answer();
        } else if (ACTION_DECLINE.equals(action)) {
            DialerInCallService.disconnect();
        }
    }
}
