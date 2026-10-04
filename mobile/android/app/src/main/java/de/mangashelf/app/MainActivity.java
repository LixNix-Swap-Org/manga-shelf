package de.mangashelf.app;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // a recreated activity or a relaunch from Recents gets the original SEND intent back; it was handled already
        Intent intent = getIntent();
        if (intent != null && Intent.ACTION_SEND.equals(intent.getAction())
                && (savedInstanceState != null || (intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0)) {
            setIntent(new Intent(Intent.ACTION_MAIN));
        }
        // app-module plugins must be registered before the bridge is built in super.onCreate
        registerPlugin(ShareIntentPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
