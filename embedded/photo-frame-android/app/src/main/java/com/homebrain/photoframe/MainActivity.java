package com.homebrain.photoframe;

import android.app.Activity;
import android.annotation.SuppressLint;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Build;
import android.provider.Settings;
import android.text.InputType;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.window.OnBackInvokedDispatcher;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

/** Fullscreen display with a separate native updater and no JS/native bridge. */
public final class MainActivity extends Activity {
    private static final String PLAYER_PATH = "/api/photo-frames/player/";
    private static final Map<String, String> ASSET_TYPES;
    static {
        Map<String, String> types = new HashMap<>();
        types.put("index.html", "text/html");
        types.put("player.js", "application/javascript");
        types.put("player.css", "text/css");
        types.put("fonts/SpaceGrotesk.ttf", "font/ttf");
        types.put("fonts/Orbitron.ttf", "font/ttf");
        ASSET_TYPES = Collections.unmodifiableMap(types);
    }
    private WebView webView;
    private Uri playerUri;

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        FrameUpdates.start(this);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON | WindowManager.LayoutParams.FLAG_FULLSCREEN);
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::showMenu);
        }
        String supplied = getIntent().getStringExtra("player_url");
        if (supplied != null && validLink(supplied)) {
            getSharedPreferences(FrameUpdates.STORE, MODE_PRIVATE).edit().putString("player_url", supplied).apply();
        }
        String saved = getSharedPreferences(FrameUpdates.STORE, MODE_PRIVATE).getString("player_url", "");
        if (validLink(saved)) showPlayer(saved); else showSetup();
    }

    private boolean validLink(String value) {
        if (value == null || value.length() > 2048) return false;
        Uri uri = Uri.parse(value);
        if (!("https".equals(uri.getScheme()) || "http".equals(uri.getScheme())) || uri.getHost() == null || uri.getUserInfo() != null || !PLAYER_PATH.equals(uri.getPath())) return false;
        Uri fragment = Uri.parse("https://pair.invalid/?" + (uri.getFragment() == null ? "" : uri.getFragment()));
        String frame = fragment.getQueryParameter("frame");
        String token = fragment.getQueryParameter("token");
        return frame != null && frame.matches("[a-fA-F0-9]{24}") && token != null && token.matches("[a-f0-9]{64}");
    }

    private void showSetup() {
        if (webView != null) { webView.destroy(); webView = null; }
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        int padding = (int)(24 * getResources().getDisplayMetrics().density);
        layout.setPadding(padding, padding, padding, padding);
        layout.setBackgroundColor(Color.rgb(20, 35, 48));
        TextView title = new TextView(this);
        title.setText("HomeBrain Photo Frame"); title.setTextSize(26); title.setTextColor(Color.WHITE);
        layout.addView(title);
        TextView instructions = new TextView(this);
        instructions.setText("Create a private pairing link under Photo Frames in HomeBrain, then paste it here. The frame needs its AC power adapter and Wi-Fi. Prefer an HTTPS hub address.");
        instructions.setTextColor(Color.LTGRAY); instructions.setPadding(0, 20, 0, 20);
        layout.addView(instructions);
        EditText link = new EditText(this);
        link.setHint("Private pairing link");
        link.setTextColor(Color.WHITE); link.setHintTextColor(Color.LTGRAY);
        link.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        link.setSingleLine(true);
        link.setText(getSharedPreferences(FrameUpdates.STORE, MODE_PRIVATE).getString("player_url", ""));
        layout.addView(link);
        Button connect = new Button(this); connect.setText("Connect Frame");
        connect.setOnClickListener(view -> {
            String value = link.getText().toString().trim();
            if (!validLink(value)) { link.setError("Paste the complete HomeBrain frame pairing link"); return; }
            getSharedPreferences(FrameUpdates.STORE, MODE_PRIVATE).edit().putString("player_url", value).apply();
            showPlayer(value);
        });
        layout.addView(connect);
        Button settings = new Button(this); settings.setText("Android / Wi-Fi Settings");
        settings.setOnClickListener(view -> startActivity(new Intent(Settings.ACTION_SETTINGS)));
        layout.addView(settings);
        setContentView(layout);
    }

    private boolean sameOrigin(Uri uri) {
        return playerUri != null && playerUri.getScheme().equals(uri.getScheme()) && playerUri.getHost().equals(uri.getHost()) && playerUri.getPort() == uri.getPort();
    }

    private void showPlayer(String link) {
        playerUri = Uri.parse(link);
        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        webView.setBackgroundColor(Color.BLACK);
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                return !sameOrigin(uri) || !PLAYER_PATH.equals(uri.getPath());
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (!sameOrigin(uri) || uri.getPath() == null || !uri.getPath().startsWith(PLAYER_PATH)) return null;
                String asset = uri.getPath().substring(PLAYER_PATH.length());
                if (asset.isEmpty()) asset = "index.html";
                String type = ASSET_TYPES.get(asset);
                if (type == null) return new WebResourceResponse("text/plain", "UTF-8", 404, "Not found", Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
                try {
                    Map<String, String> headers = new HashMap<>();
                    headers.put("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'");
                    headers.put("Referrer-Policy", "no-referrer");
                    return new WebResourceResponse(type, type.startsWith("font/") ? null : "UTF-8", 200, "OK", headers, getAssets().open(asset));
                } catch (IOException error) {
                    return new WebResourceResponse("text/plain", "UTF-8", 500, "Missing player asset", Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
                }
            }
        });
        webView.setOnLongClickListener(view -> { showMenu(); return true; });
        setContentView(webView);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        webView.loadUrl(link);
    }

    private void showMenu() {
        new AlertDialog.Builder(this).setTitle("HomeBrain Frame")
            .setItems(new String[]{"Keep displaying", "Change connection", "Android settings"}, (dialog, item) -> {
                if (item == 1) showSetup();
                if (item == 2) startActivity(new Intent(Settings.ACTION_SETTINGS));
            }).show();
    }
    // Android 6 frames use the legacy callback; API 33+ uses the callback above.
    @SuppressLint("GestureBackNavigation")
    @Override public void onBackPressed() { showMenu(); }
    @Override protected void onDestroy() { if (webView != null) webView.destroy(); super.onDestroy(); }
}
