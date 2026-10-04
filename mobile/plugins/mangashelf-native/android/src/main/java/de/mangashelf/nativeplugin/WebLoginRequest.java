package de.mangashelf.nativeplugin;

import android.text.TextUtils;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import okhttp3.Cookie;
import okhttp3.CookieJar;
import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import org.json.JSONObject;

/**
 * One HTTPS request without cookie handling, cache or redirects; the caller sets every header itself. OkHttp keeps its own
 * cookie jar, so the process-wide CookieHandler that Capacitor installs for the app WebView is never consulted.
 */
final class WebLoginRequest {

    static final int TIMEOUT_MS = 20000;
    static final int MAX_BYTES = 8 * 1024 * 1024;

    static final class NotAllowed extends Exception {}

    // no retry: a replayed token grant could rotate etp_rt twice and leave the stored one invalid
    static final OkHttpClient CLIENT = new OkHttpClient.Builder()
        .cookieJar(CookieJar.NO_COOKIES)
        .cache(null)
        .followRedirects(false)
        .followSslRedirects(false)
        .retryOnConnectionFailure(false)
        .callTimeout(TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .build();

    private WebLoginRequest() {}

    static boolean isolated(OkHttpClient client) {
        return client.cookieJar() == CookieJar.NO_COOKIES && client.cache() == null && !client.followRedirects() && !client.followSslRedirects();
    }

    static JSObject send(String url, String method, JSObject headers, String body) throws Exception {
        if (!isolated(CLIENT)) throw new NotAllowed();
        HttpUrl target = HttpUrl.get(url);
        Request.Builder builder = new Request.Builder().url(target);
        String contentType = null;
        Iterator<String> keys = headers.keys();
        while (keys.hasNext()) {
            String name = keys.next();
            Object value = headers.opt(name);
            if (!(value instanceof String)) continue;
            builder.header(name, (String) value);
            if ("content-type".equalsIgnoreCase(name)) contentType = (String) value;
        }
        if ("POST".equals(method)) {
            byte[] bytes = body == null ? new byte[0] : body.getBytes(StandardCharsets.UTF_8);
            builder.post(RequestBody.create(bytes, contentType == null ? null : MediaType.parse(contentType)));
        } else {
            builder.get();
        }
        try (Response response = CLIENT.newCall(builder.build()).execute()) {
            JSObject outHeaders = new JSObject();
            for (Map.Entry<String, List<String>> entry : response.headers().toMultimap().entrySet()) {
                outHeaders.put(entry.getKey(), TextUtils.join(", ", entry.getValue()));
            }
            JSArray cookies = new JSArray();
            for (Cookie cookie : Cookie.parseAll(target, response.headers())) {
                JSObject c = new JSObject();
                c.put("name", cookie.name());
                c.put("value", cookie.value());
                // a deleting Set-Cookie (Max-Age=0) gives Long.MIN_VALUE
                if (cookie.persistent()) c.put("expires", Math.max(0L, cookie.expiresAt()));
                else c.put("expires", JSONObject.NULL);
                cookies.put(c);
            }
            ResponseBody responseBody = response.body();
            JSObject result = new JSObject();
            result.put("status", response.code());
            result.put("headers", outHeaders);
            result.put("text", responseBody == null ? "" : readAll(responseBody.byteStream()));
            result.put("cookies", cookies);
            return result;
        }
    }

    private static String readAll(InputStream in) throws IOException {
        try (InputStream stream = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16384];
            int total = 0;
            int n;
            while ((n = stream.read(buffer)) != -1) {
                total += n;
                if (total > MAX_BYTES) throw new IOException("response too large");
                out.write(buffer, 0, n);
            }
            return out.toString("UTF-8");
        }
    }
}
