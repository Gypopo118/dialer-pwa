package com.gypopo.dialer;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DialerTelecomPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
