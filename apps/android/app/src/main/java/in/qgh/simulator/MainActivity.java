package in.qgh.simulator;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.AlertDialog;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.JsResult;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;


public final class MainActivity extends ComponentActivity {
    private static final String ASSET_PREFIX =
            "https://appassets.androidplatform.net/assets/";
    private static final String START_URL =
            ASSET_PREFIX + "index.html";
    private static final int NATIVE_VOICE_RECORD_AUDIO_PERMISSION_REQUEST = 4104;
    private static final String NATIVE_VOICE_INTERFACE = "QghNativeVoice";

    private WebView simulator;
    private QghOfflineVoice offlineVoice;
    private int nextNativeVoiceSessionId = 1;
    private int activeNativeVoiceSessionId;
    private int activeNativeVoiceNavigationGeneration;
    private String activeNativeVoicePageUrl;
    private int pendingNativeVoiceSessionId;
    private int pendingNativeVoiceNavigationGeneration;
    private String pendingNativeVoicePageUrl;
    private int topLevelNavigationGeneration = 1;
    private String currentTopLevelPageUrl = START_URL;
    private boolean nativeVoicePermissionRequestInFlight;
    private boolean nativeVoiceActivityActive;

    private static boolean isAllowedAssetUrl(String url) {
        return (ASSET_PREFIX + "index.html").equals(url)
                || (ASSET_PREFIX + "user-guide.html").equals(url)
                || (ASSET_PREFIX + "single.html").equals(url)
                || (ASSET_PREFIX + "tactical.html").equals(url);
    }

    private boolean hasRecordAudioPermission() {
        return checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
    }

    private boolean isTrustedCurrentAppAssetPage() {
        return simulator != null
                && !isFinishing()
                && !isDestroyed()
                && isAllowedAssetUrl(simulator.getUrl());
    }

    private boolean isCurrentNativeVoicePage(int navigationGeneration, String pageUrl) {
        return pageUrl != null
                && navigationGeneration == topLevelNavigationGeneration
                && pageUrl.equals(currentTopLevelPageUrl)
                && simulator != null
                && pageUrl.equals(simulator.getUrl())
                && isTrustedCurrentAppAssetPage();
    }

    private void invalidateNativeVoiceForNavigation() {
        clearPendingNativeVoiceStart();
        clearActiveOfflineVoiceSession();
    }

    private void noteTopLevelPageNavigation(String url) {
        invalidateNativeVoiceForNavigation();
        topLevelNavigationGeneration += 1;
        if (topLevelNavigationGeneration <= 0) {
            topLevelNavigationGeneration = 1;
        }
        currentTopLevelPageUrl = url;
    }

    private void runNativeVoiceOnUiThread(Runnable task) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            task.run();
        } else {
            runOnUiThread(task);
        }
    }

    private String nativeVoiceCapabilityForTrustedPage() {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            return nativeVoiceActivityActive && isTrustedCurrentAppAssetPage() && offlineVoice != null
                    ? offlineVoice.capability()
                    : "unavailable";
        }
        AtomicReference<String> capability = new AtomicReference<>("unavailable");
        CountDownLatch completed = new CountDownLatch(1);
        runOnUiThread(() -> {
            if (nativeVoiceActivityActive && isTrustedCurrentAppAssetPage() && offlineVoice != null) {
                capability.set(offlineVoice.capability());
            }
            completed.countDown();
        });
        try {
            completed.await(300, TimeUnit.MILLISECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
        return capability.get();
    }

    private int nextNativeVoiceSessionId() {
        int sessionId = nextNativeVoiceSessionId++;
        if (nextNativeVoiceSessionId <= 0) {
            nextNativeVoiceSessionId = 1;
        }
        return sessionId;
    }

    private boolean isActiveNativeVoiceSession(int sessionId) {
        return sessionId != 0
                && sessionId == activeNativeVoiceSessionId
                && isCurrentNativeVoicePage(
                        activeNativeVoiceNavigationGeneration, activeNativeVoicePageUrl)
                && offlineVoice != null;
    }

    private void emitNativeVoiceEvent(
            int navigationGeneration, String pageUrl, String type, String transcript, String code) {
        if (!isCurrentNativeVoicePage(navigationGeneration, pageUrl)) {
            return;
        }

        JSONObject event = new JSONObject();
        try {
            event.put("type", type);
            if (transcript != null) {
                event.put("transcript", transcript);
            }
            if (code != null) {
                event.put("code", code);
            }
        } catch (JSONException ignored) {
            return;
        }

        // The event payload is JSON-encoded; no recognised speech is ever used as JavaScript source.
        String script = "if(window.location.href===" + JSONObject.quote(pageUrl)
                + "&&window.QGHVoiceWorkspace&&typeof window.QGHVoiceWorkspace"
                + ".receiveNativeVoiceEvent==='function'){window.QGHVoiceWorkspace"
                + ".receiveNativeVoiceEvent(" + event + ");}";
        simulator.evaluateJavascript(script, null);
    }

    private void emitNativeVoiceFailure(int navigationGeneration, String pageUrl, String code) {
        emitNativeVoiceEvent(navigationGeneration, pageUrl, "error", null, code);
        emitNativeVoiceEvent(navigationGeneration, pageUrl, "ended", null, null);
    }

    private void clearPendingNativeVoiceStart() {
        pendingNativeVoiceSessionId = 0;
        pendingNativeVoiceNavigationGeneration = 0;
        pendingNativeVoicePageUrl = null;
    }

    private void clearActiveOfflineVoiceSession() {
        activeNativeVoiceSessionId = 0;
        activeNativeVoiceNavigationGeneration = 0;
        activeNativeVoicePageUrl = null;
        if (offlineVoice != null) {
            offlineVoice.cancel();
        }
    }

    private void finishNativeVoiceSession(int sessionId) {
        if (!isActiveNativeVoiceSession(sessionId)) {
            return;
        }
        int navigationGeneration = activeNativeVoiceNavigationGeneration;
        String pageUrl = activeNativeVoicePageUrl;
        clearActiveOfflineVoiceSession();
        emitNativeVoiceEvent(navigationGeneration, pageUrl, "ended", null, null);
    }

    private void handleNativeVoiceError(int sessionId, String code) {
        if (!isActiveNativeVoiceSession(sessionId)) {
            return;
        }
        emitNativeVoiceEvent(
                activeNativeVoiceNavigationGeneration,
                activeNativeVoicePageUrl,
                "error",
                null,
                code == null ? "unavailable" : code);
    }

    private void handleNativeVoiceResult(int sessionId, String transcript) {
        if (!isActiveNativeVoiceSession(sessionId)
                || transcript == null
                || transcript.trim().isEmpty()) {
            return;
        }
        emitNativeVoiceEvent(
                activeNativeVoiceNavigationGeneration,
                activeNativeVoicePageUrl,
                "result",
                transcript.trim(),
                null);
    }

    private void handleNativeVoiceNoResult(int sessionId) {
        if (!isActiveNativeVoiceSession(sessionId)) {
            return;
        }
        emitNativeVoiceEvent(
                activeNativeVoiceNavigationGeneration,
                activeNativeVoicePageUrl,
                "no-result",
                null,
                null);
    }

    private void beginNativeVoiceRecognition(
            int sessionId, int navigationGeneration, String pageUrl) {
        if (sessionId == 0
                || !nativeVoiceActivityActive
                || !isCurrentNativeVoicePage(navigationGeneration, pageUrl)
                || !hasRecordAudioPermission()
                || offlineVoice == null) {
            return;
        }
        if (!"available".equals(offlineVoice.capability())) {
            if (pendingNativeVoiceSessionId == sessionId) {
                clearPendingNativeVoiceStart();
            }
            emitNativeVoiceFailure(navigationGeneration, pageUrl, "unavailable");
            return;
        }
        if (pendingNativeVoiceSessionId == sessionId) {
            clearPendingNativeVoiceStart();
        }
        clearActiveOfflineVoiceSession();
        activeNativeVoiceSessionId = sessionId;
        activeNativeVoiceNavigationGeneration = navigationGeneration;
        activeNativeVoicePageUrl = pageUrl;
        offlineVoice.start(new QghOfflineVoice.Listener() {
            @Override
            public void onStarted() {
                if (isActiveNativeVoiceSession(sessionId)) {
                    emitNativeVoiceEvent(navigationGeneration, pageUrl, "started", null, null);
                }
            }

            @Override
            public void onFinalText(String transcript) {
                handleNativeVoiceResult(sessionId, transcript);
            }

            @Override
            public void onNoResult() {
                handleNativeVoiceNoResult(sessionId);
            }

            @Override
            public void onError(String code) {
                handleNativeVoiceError(sessionId, code);
            }

            @Override
            public void onEnded() {
                finishNativeVoiceSession(sessionId);
            }
        });
    }

    private void startNativeVoice(boolean continuous) {
        if (!nativeVoiceActivityActive
                || !isCurrentNativeVoicePage(
                        topLevelNavigationGeneration, currentTopLevelPageUrl)) {
            return;
        }

        // Continuous rearming is owned by the workspace after an ended event. One native session
        // always returns at most one final phrase, which prevents transcript duplication.
        clearPendingNativeVoiceStart();
        clearActiveOfflineVoiceSession();
        int sessionId = nextNativeVoiceSessionId();
        int navigationGeneration = topLevelNavigationGeneration;
        String pageUrl = currentTopLevelPageUrl;
        pendingNativeVoiceSessionId = sessionId;
        pendingNativeVoiceNavigationGeneration = navigationGeneration;
        pendingNativeVoicePageUrl = pageUrl;

        if (offlineVoice == null || !"available".equals(offlineVoice.capability())) {
            clearPendingNativeVoiceStart();
            emitNativeVoiceFailure(navigationGeneration, pageUrl, "unavailable");
            return;
        }

        if (hasRecordAudioPermission()) {
            beginNativeVoiceRecognition(sessionId, navigationGeneration, pageUrl);
            return;
        }

        if (!nativeVoicePermissionRequestInFlight) {
            nativeVoicePermissionRequestInFlight = true;
            requestPermissions(
                    new String[] { Manifest.permission.RECORD_AUDIO },
                    NATIVE_VOICE_RECORD_AUDIO_PERMISSION_REQUEST);
        }
    }

    private void stopNativeVoice() {
        clearPendingNativeVoiceStart();
        if (offlineVoice == null || activeNativeVoiceSessionId == 0) {
            return;
        }
        try {
            offlineVoice.stop();
        } catch (RuntimeException ignored) {
            int navigationGeneration = activeNativeVoiceNavigationGeneration;
            String pageUrl = activeNativeVoicePageUrl;
            clearActiveOfflineVoiceSession();
            emitNativeVoiceEvent(navigationGeneration, pageUrl, "ended", null, null);
        }
    }

    private void stopNativeVoiceFromTrustedPage() {
        if (isTrustedCurrentAppAssetPage()) {
            stopNativeVoice();
        }
    }

    private void cancelNativeVoice() {
        clearPendingNativeVoiceStart();
        boolean hadActiveSession = activeNativeVoiceSessionId != 0;
        int navigationGeneration = activeNativeVoiceNavigationGeneration;
        String pageUrl = activeNativeVoicePageUrl;
        clearActiveOfflineVoiceSession();
        if (hadActiveSession) {
            emitNativeVoiceEvent(navigationGeneration, pageUrl, "ended", null, null);
        }
    }

    private void cancelNativeVoiceFromTrustedPage() {
        if (isTrustedCurrentAppAssetPage()) {
            cancelNativeVoice();
        }
    }

    private final class QghNativeVoiceBridge {
        @JavascriptInterface
        public String getCapability() {
            return nativeVoiceCapabilityForTrustedPage();
        }

        @JavascriptInterface
        public void setGrammar(String grammar) {
            runNativeVoiceOnUiThread(() -> {
                if (isTrustedCurrentAppAssetPage() && offlineVoice != null) {
                    offlineVoice.setGrammar(grammar);
                }
            });
        }

        @JavascriptInterface
        public void start(boolean continuous) {
            runNativeVoiceOnUiThread(() -> startNativeVoice(continuous));
        }

        @JavascriptInterface
        public void stop() {
            runNativeVoiceOnUiThread(MainActivity.this::stopNativeVoiceFromTrustedPage);
        }

        @JavascriptInterface
        public void cancel() {
            runNativeVoiceOnUiThread(MainActivity.this::cancelNativeVoiceFromTrustedPage);
        }
    }

    @Override
    @SuppressLint("SetJavaScriptEnabled") // The simulator is a bundled, CSP-restricted offline application.
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // The local model begins preparing while the first bundled page is loading. Mark the
        // activity usable now so the page observes PREPARING rather than a false unavailable
        // state if its scripts execute just before onResume.
        nativeVoiceActivityActive = true;
        offlineVoice = new QghOfflineVoice(this);
        WebView.setWebContentsDebuggingEnabled(false);
        simulator = new WebView(this);
        WebSettings settings = simulator.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setBlockNetworkImage(true);
        settings.setBlockNetworkLoads(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setGeolocationEnabled(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(true);

        WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        simulator.setWebViewClient(new WebViewClientCompat() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                // This callback is for the top-level document. A native voice session belongs
                // solely to that document and must not carry its result into the next page.
                noteTopLevelPageNavigation(url);
                super.onPageStarted(view, url, favicon);
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(
                    WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !isAllowedAssetUrl(request.getUrl().toString());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return !isAllowedAssetUrl(url);
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                cancelNativeVoice();
                view.destroy();
                MainActivity.this.runOnUiThread(MainActivity.this::recreate);
                return true;
            }
        });

        simulator.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                // Voice is handled by the private Vosk bridge; WebView media capture is never a
                // fallback path and is denied even for a bundled page.
                request.deny();
            }

            @Override
            public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
                if (isFinishing() || isDestroyed()) {
                    result.cancel();
                    return true;
                }

                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton(android.R.string.ok, (dialog, which) -> result.confirm())
                        .setOnCancelListener(dialog -> result.cancel())
                        .show();
                return true;
            }
        });

        simulator.addJavascriptInterface(new QghNativeVoiceBridge(), NATIVE_VOICE_INTERFACE);
        simulator.loadUrl(START_URL);
        setContentView(simulator);

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (simulator != null && simulator.canGoBack()) {
                    simulator.goBack();
                } else {
                    moveTaskToBack(true);
                }
            }
        });
    }

    @Override
    public void onRequestPermissionsResult(
            int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == NATIVE_VOICE_RECORD_AUDIO_PERMISSION_REQUEST) {
            nativeVoicePermissionRequestInFlight = false;
            int sessionId = pendingNativeVoiceSessionId;
            int navigationGeneration = pendingNativeVoiceNavigationGeneration;
            String pageUrl = pendingNativeVoicePageUrl;
            clearPendingNativeVoiceStart();
            if (sessionId == 0) {
                return;
            }
            if (hasRecordAudioPermission()
                    && nativeVoiceActivityActive
                    && !isFinishing()
                    && !isDestroyed()
                    && isCurrentNativeVoicePage(navigationGeneration, pageUrl)) {
                beginNativeVoiceRecognition(sessionId, navigationGeneration, pageUrl);
            } else if (isCurrentNativeVoicePage(navigationGeneration, pageUrl)) {
                emitNativeVoiceFailure(navigationGeneration, pageUrl, "not-allowed");
            }
            return;
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        nativeVoiceActivityActive = true;
    }

    @Override
    protected void onPause() {
        nativeVoiceActivityActive = false;
        cancelNativeVoice();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        cancelNativeVoice();
        if (offlineVoice != null) {
            offlineVoice.close();
            offlineVoice = null;
        }
        if (simulator != null) {
            simulator.stopLoading();
            simulator.loadUrl("about:blank");
            simulator.clearHistory();
            simulator.removeAllViews();
            simulator.destroy();
        }
        super.onDestroy();
    }
}
