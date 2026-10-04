package de.mangashelf.app;

import android.content.Intent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Hands text shared to the app (ACTION_SEND text/plain) to the web layer; parsing happens in JS. */
@CapacitorPlugin(name = "ShareIntent")
public class ShareIntentPlugin extends Plugin {

    // BridgeActivity.load() passes the cold-start intent here too, so load() must not read getIntent() again
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction()) || !"text/plain".equals(intent.getType())) return;
        // Recents replays the task's original SEND intent
        if ((intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return;
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        if (text == null) return;
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        JSObject data = new JSObject();
        data.put("text", text.toString());
        data.put("subject", subject == null ? "" : subject);
        // retained until the app's listener subscribes (cold start)
        notifyListeners("shareReceived", data, true);
        // a recreated activity must not deliver the same share again
        if (getActivity() != null) getActivity().setIntent(new Intent(Intent.ACTION_MAIN));
    }
}
