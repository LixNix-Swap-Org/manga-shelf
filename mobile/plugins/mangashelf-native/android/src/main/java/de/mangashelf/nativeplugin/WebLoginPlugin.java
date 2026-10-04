package de.mangashelf.nativeplugin;

import android.annotation.SuppressLint;
import android.app.Dialog;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.webkit.Profile;
import androidx.webkit.ProfileStore;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;
import org.json.JSONTokener;

/**
 * Sign-in in a dialog WebView and cookie-less requests. Where WebView supports profiles the dialog runs in its own profile,
 * deleted afterwards. Otherwise CookieManager and WebStorage are shared with the app's own WebView, so the cleanup touches
 * only the hosts the dialog visited, never removeAllCookies or deleteAllData of the default profile.
 */
@CapacitorPlugin(name = "WebLogin")
public class WebLoginPlugin extends Plugin {

    static final Set<String> COOKIE_DOMAINS = new HashSet<>(Arrays.asList("crunchyroll.com"));
    static final Set<String> REQUEST_HOSTS = new HashSet<>(Arrays.asList("www.crunchyroll.com", "beta-api.crunchyroll.com"));
    private static final String[] CLEANUP_HOSTS = { "www.", "sso.", "" };
    static final String PROFILE = "crunchyroll-login";
    // hosts of the shared-profile fallback, kept outside app_webview and backups so a killed process can be cleaned up later
    private static final String HOSTS_FILE = "weblogin-hosts.txt";

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newCachedThreadPool();
    private PluginCall pending;
    private Dialog dialog;
    private WebView webView;
    private Runnable poll;
    private String domain;
    private String cookieName;
    private String pathNotContaining;
    private String readScript;
    private boolean checking;
    private CookieManager jar;
    private WebStorage storage;
    private boolean isolated;
    private final Set<String> visited = new LinkedHashSet<>();

    static boolean hostMatches(String host, String domain) {
        if (host == null) return false;
        String h = host.toLowerCase(Locale.ROOT);
        return h.equals(domain) || h.endsWith("." + domain);
    }

    @PluginMethod
    public void open(PluginCall call) {
        String cookieDomain = call.getString("cookieDomain", "").toLowerCase(Locale.ROOT);
        String name = call.getString("cookieName", "");
        JSObject doneWhen = call.getObject("doneWhen", new JSObject());
        String path = doneWhen.optString("pathNotContaining", "");
        Uri url = Uri.parse(call.getString("url", ""));
        if (!COOKIE_DOMAINS.contains(cookieDomain) || name.isEmpty() || path.isEmpty() || !"https".equals(url.getScheme())
                || !hostMatches(url.getHost(), cookieDomain)) {
            call.reject("not_allowed", "not_allowed");
            return;
        }
        main.post(() -> {
            if (pending != null || getActivity() == null) {
                call.reject("busy", "busy");
                return;
            }
            removeLeftovers(cookieDomain);
            pending = call;
            domain = cookieDomain;
            cookieName = name;
            pathNotContaining = path.toLowerCase(Locale.ROOT);
            readScript = call.getString("readScript");
            checking = false;
            show(url.toString(), call.getString("title", "Bei Crunchyroll anmelden"), call.getString("cancelLabel", "Abbrechen"));
        });
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void show(String url, String title, String cancelLabel) {
        dialog = new Dialog(getActivity(), android.R.style.Theme_DeviceDefault_Light_NoActionBar);
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);

        LinearLayout root = new LinearLayout(getActivity());
        root.setOrientation(LinearLayout.VERTICAL);
        root.setFitsSystemWindows(true);
        root.setBackgroundColor(Color.WHITE);
        LinearLayout bar = new LinearLayout(getActivity());
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        Button cancel = new Button(getActivity(), null, android.R.attr.borderlessButtonStyle);
        cancel.setText(cancelLabel);
        cancel.setOnClickListener((v) -> finish(null, "cancelled"));
        TextView heading = new TextView(getActivity());
        heading.setText(title);
        heading.setTextSize(17);
        heading.setTextColor(Color.BLACK);
        bar.addView(cancel);
        bar.addView(heading, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        webView = new WebView(getActivity());
        visited.clear();
        isolated = WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE);
        if (isolated) {
            Profile profile = ProfileStore.getInstance().getOrCreateProfile(PROFILE);
            WebViewCompat.setProfile(webView, PROFILE);
            jar = profile.getCookieManager();
            storage = profile.getWebStorage();
        } else {
            jar = CookieManager.getInstance();
            storage = WebStorage.getInstance();
        }
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportMultipleWindows(false);
        webView.setWebViewClient(
            new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    String scheme = request.getUrl().getScheme();
                    return !"https".equals(scheme) && !"about".equals(scheme);
                }

                @Override
                public void onPageStarted(WebView view, String started, Bitmap favicon) {
                    if (!isolated) remember(started);
                }

                @Override
                public void onPageFinished(WebView view, String loaded) {
                    check();
                }
            }
        );
        root.addView(webView, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));

        dialog.setContentView(root);
        dialog.setCancelable(true);
        dialog.setOnCancelListener((d) -> finish(null, "cancelled"));
        dialog.show();
        if (dialog.getWindow() != null) {
            dialog.getWindow().setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        }
        webView.loadUrl(url);
        poll = new Runnable() {
            @Override
            public void run() {
                check();
                if (pending != null) main.postDelayed(this, 1000);
            }
        };
        main.postDelayed(poll, 1000);
    }

    private void check() {
        if (pending == null || webView == null || checking) return;
        Uri page = Uri.parse(String.valueOf(webView.getUrl()));
        String path = page.getPath() == null ? "" : page.getPath().toLowerCase(Locale.ROOT);
        if (!hostMatches(page.getHost(), domain) || path.contains(pathNotContaining)) return;
        String value = cookieValue(jar.getCookie("https://www." + domain), cookieName);
        if (value == null || value.isEmpty()) return;
        JSObject cookie = new JSObject();
        cookie.put("value", value);
        cookie.put("expires", JSONObject.NULL);
        JSObject result = new JSObject();
        result.put("cookie", cookie);
        if (readScript == null || readScript.isEmpty()) {
            result.put("scriptResult", JSONObject.NULL);
            finish(result, null);
            return;
        }
        checking = true;
        String wrapped = "(function(){try{var v=(" + readScript + ");return v==null?null:String(v);}catch(e){return null;}})()";
        webView.evaluateJavascript(wrapped, (raw) -> {
            result.put("scriptResult", decodeJson(raw));
            finish(result, null);
        });
    }

    // CookieManager.getCookie gives "a=1; b=2" (HttpOnly included, no attributes)
    static String cookieValue(String header, String name) {
        if (header == null) return null;
        for (String part : header.split(";")) {
            int eq = part.indexOf('=');
            if (eq > 0 && part.substring(0, eq).trim().equals(name)) return part.substring(eq + 1).trim();
        }
        return null;
    }

    // evaluateJavascript hands back the value as JSON text
    static Object decodeJson(String raw) {
        try {
            Object value = new JSONTokener(raw == null ? "null" : raw).nextValue();
            return value instanceof String ? value : JSONObject.NULL;
        } catch (Exception e) {
            return JSONObject.NULL;
        }
    }

    private void finish(JSObject result, String error) {
        PluginCall call = pending;
        if (call == null) return;
        pending = null;
        if (poll != null) main.removeCallbacks(poll);
        poll = null;
        cleanup();
        if (result != null) call.resolve(result);
        else call.reject(error, error);
    }

    private void cleanup() {
        if (webView != null) {
            webView.stopLoading();
            webView.clearCache(true);
            webView.clearHistory();
        }
        if (isolated) {
            jar.removeAllCookies(null);
            jar.flush();
            storage.deleteAllData();
        } else {
            List<String> urls = baseUrls(domain);
            urls.addAll(visited);
            expireShared(urls);
            hostsFile().delete();
        }
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        if (dialog != null) {
            dialog.setOnCancelListener(null);
            if (dialog.isShowing()) dialog.dismiss();
            dialog = null;
        }
        // deleting needs the destroyed WebView released; what fails here is removed at the next open()
        if (isolated) main.post(WebLoginPlugin::deleteProfile);
        visited.clear();
        jar = null;
        storage = null;
    }

    /** Data a killed process left behind: the login profile, or the hosts the shared-profile fallback had recorded. */
    private void removeLeftovers(String cookieDomain) {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            deleteProfile();
            return;
        }
        File file = hostsFile();
        if (!file.exists()) return;
        List<String> urls = baseUrls(cookieDomain);
        try (BufferedReader in = new BufferedReader(new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8))) {
            String host;
            while ((host = in.readLine()) != null) {
                if (isCleanableHost(host)) urls.add("https://" + host + "/");
            }
        } catch (IOException ignored) {
            // an unreadable list still leaves the base hosts to clean
        }
        jar = CookieManager.getInstance();
        storage = WebStorage.getInstance();
        expireShared(urls);
        jar = null;
        storage = null;
        file.delete();
    }

    private static void deleteProfile() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) return;
        try {
            ProfileStore store = ProfileStore.getInstance();
            if (store.getAllProfileNames().contains(PROFILE)) store.deleteProfile(PROFILE);
        } catch (IllegalStateException ignored) {
            // still in use: the next open() deletes it before creating a new one
        }
    }

    private static List<String> baseUrls(String cookieDomain) {
        List<String> urls = new ArrayList<>();
        for (String host : CLEANUP_HOSTS) urls.add("https://" + host + cookieDomain + "/");
        return urls;
    }

    private File hostsFile() {
        return new File(getContext().getNoBackupFilesDir(), HOSTS_FILE);
    }

    private boolean isCleanableHost(String host) {
        if (host == null || host.isEmpty() || !host.matches("[a-z0-9.-]+")) return false;
        String own = getBridge() == null ? null : getBridge().getHost();
        return !host.equalsIgnoreCase(own);
    }

    private void remember(String url) {
        Uri page = Uri.parse(String.valueOf(url));
        String host = page.getHost() == null ? null : page.getHost().toLowerCase(Locale.ROOT);
        if (!"https".equals(page.getScheme()) || !isCleanableHost(host)) return;
        String path = page.getPath() == null || page.getPath().isEmpty() ? "/" : page.getPath();
        if (!visited.add("https://" + host + path)) return;
        Set<String> hosts = new LinkedHashSet<>();
        for (String seen : visited) hosts.add(Uri.parse(seen).getHost());
        try (OutputStream out = new FileOutputStream(hostsFile())) {
            out.write(TextUtils.join("\n", hosts).getBytes(StandardCharsets.UTF_8));
        } catch (IOException ignored) {
            // the in-memory list still drives the cleanup of this session
        }
    }

    /** Expire every cookie readable from the given pages, for every path prefix and parent domain, then their origin storage. */
    private void expireShared(Collection<String> urls) {
        Set<String> origins = new LinkedHashSet<>();
        for (String url : urls) {
            Uri page = Uri.parse(url);
            String host = page.getHost();
            if (host == null) continue;
            String origin = "https://" + host;
            origins.add(origin);
            String header = jar.getCookie(url);
            if (header == null) continue;
            for (String part : header.split(";")) {
                int eq = part.indexOf('=');
                if (eq <= 0) continue;
                String name = part.substring(0, eq).trim();
                for (String path : pathPrefixes(page.getPath())) {
                    jar.setCookie(origin, name + "=; Max-Age=0; Path=" + path + "; Secure");
                    for (String parent : parentDomains(host)) {
                        jar.setCookie(origin, name + "=; Max-Age=0; Path=" + path + "; Secure; Domain=." + parent);
                    }
                }
            }
        }
        jar.flush();
        for (String origin : origins) storage.deleteOrigin(origin);
    }

    static List<String> pathPrefixes(String path) {
        List<String> out = new ArrayList<>();
        out.add("/");
        if (path == null) return out;
        StringBuilder prefix = new StringBuilder();
        for (String segment : path.split("/")) {
            if (segment.isEmpty()) continue;
            prefix.append('/').append(segment);
            out.add(prefix.toString());
        }
        return out;
    }

    // a.b.example.com -> a.b.example.com, b.example.com, example.com (the browser rejects public suffixes on its own)
    static List<String> parentDomains(String host) {
        List<String> out = new ArrayList<>();
        String rest = host.toLowerCase(Locale.ROOT);
        while (rest.indexOf('.') > 0) {
            out.add(rest);
            rest = rest.substring(rest.indexOf('.') + 1);
        }
        return out;
    }

    @PluginMethod
    public void request(PluginCall call) {
        String method = call.getString("method", "GET").toUpperCase(Locale.ROOT);
        Uri url = Uri.parse(call.getString("url", ""));
        String host = url.getHost() == null ? "" : url.getHost().toLowerCase(Locale.ROOT);
        if (!"https".equals(url.getScheme()) || !REQUEST_HOSTS.contains(host) || !("GET".equals(method) || "POST".equals(method))) {
            call.reject("not_allowed", "not_allowed");
            return;
        }
        JSObject headers = call.getObject("headers", new JSObject());
        String body = call.getString("body");
        io.execute(() -> {
            try {
                call.resolve(WebLoginRequest.send(url.toString(), method, headers, body));
            } catch (WebLoginRequest.NotAllowed e) {
                call.reject("not_allowed", "not_allowed");
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()), "network", e);
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        if (pending != null) finish(null, "cancelled");
        io.shutdown();
    }
}
