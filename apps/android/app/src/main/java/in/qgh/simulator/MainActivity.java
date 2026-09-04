package in.qgh.simulator;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
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

import java.util.ArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

public final class MainActivity extends ComponentActivity {
    private static final String ASSET_PREFIX =
            "https://appassets.androidplatform.net/assets/";
    private static final String ASSET_HOST = "appassets.androidplatform.net";
    private static final String START_URL =
            ASSET_PREFIX + "index.html";
    private static final int RECORD_AUDIO_PERMISSION_REQUEST = 4103;
    private static final int NATIVE_VOICE_RECORD_AUDIO_PERMISSION_REQUEST = 4104;
    private static final String NATIVE_VOICE_INTERFACE = "QghNativeVoice";
    private static final String NATIVE_VOICE_LANGUAGE = "en-IN";

    private WebView simulator;
    private PermissionRequest pendingAudioPermissionRequest;
    private SpeechRecognizer nativeVoiceRecognizer;
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

    private static boolean isTrustedAppAssetOrigin(Uri origin) {
        return origin != null
                && "https".equals(origin.getScheme())
                && ASSET_HOST.equals(origin.getHost())
                && origin.getPort() == -1;
    }

    private static boolean isAudioOnlyPermissionRequest(PermissionRequest request) {
        String[] resources = request.getResources();
        return resources != null
                && resources.length == 1
                && PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resources[0]);
    }

    private static boolean isTrustedAudioPermissionRequest(PermissionRequest request) {
        return request != null
                && isTrustedAppAssetOrigin(request.getOrigin())
                && isAudioOnlyPermissionRequest(request);
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
        destroyNativeVoiceRecognizer();
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

    private boolean isOnDeviceVoiceAvailableOnUiThread() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            return false;
        }
        try {
            return SpeechRecognizer.isOnDeviceRecognitionAvailable(this);
        } catch (RuntimeException ignored) {
            return false;
        }
    }

    private String nativeVoiceCapabilityForTrustedPage() {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            return nativeVoiceActivityActive
                    && isTrustedCurrentAppAssetPage()
                    && isOnDeviceVoiceAvailableOnUiThread()
                    ? "available"
                    : "unavailable";
        }

        AtomicReference<String> capability = new AtomicReference<>("unavailable");
        CountDownLatch completed = new CountDownLatch(1);
        runOnUiThread(() -> {
            if (nativeVoiceActivityActive
                    && isTrustedCurrentAppAssetPage()
                    && isOnDeviceVoiceAvailableOnUiThread()) {
                capability.set("available");
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
                && nativeVoiceRecognizer != null;
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

    private void destroyNativeVoiceRecognizer() {
        SpeechRecognizer recognizer = nativeVoiceRecognizer;
        nativeVoiceRecognizer = null;
        activeNativeVoiceSessionId = 0;
        activeNativeVoiceNavigationGeneration = 0;
        activeNativeVoicePageUrl = null;
        if (recognizer == null) {
            return;
        }
        try {
            recognizer.cancel();
        } catch (RuntimeException ignored) {
            // The recognizer may have already stopped itself.
        }
        try {
            recognizer.destroy();
        } catch (RuntimeException ignored) {
            // Destruction is best-effort during Android lifecycle changes.
        }
    }

    private void finishNativeVoiceSession(int sessionId) {
        if (!isActiveNativeVoiceSession(sessionId)) {
            return;
        }
        int navigationGeneration = activeNativeVoiceNavigationGeneration;
        String pageUrl = activeNativeVoicePageUrl;
        destroyNativeVoiceRecognizer();
        emitNativeVoiceEvent(navigationGeneration, pageUrl, "ended", null, null);
    }

    private String nativeVoiceErrorCode(int error) {
        if (error == SpeechRecognizer.ERROR_NO_MATCH
                || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
            return "no-speech";
        }
        if (error == SpeechRecognizer.ERROR_CLIENT) {
            return "aborted";
        }
        if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) {
            return "not-allowed";
        }
        return "unavailable";
    }

    private void handleNativeVoiceError(int sessionId, int error) {
        if (!isActiveNativeVoiceSession(sessionId)) {
            return;
        }
        emitNativeVoiceEvent(
                activeNativeVoiceNavigationGeneration,
                activeNativeVoicePageUrl,
                "error",
                null,
                nativeVoiceErrorCode(error));
        finishNativeVoiceSession(sessionId);
    }

    private void handleNativeVoiceResults(int sessionId, ArrayList<String> transcripts) {
        if (!isActiveNativeVoiceSession(sessionId)) {
            return;
        }
        String transcript = null;
        if (transcripts != null) {
            for (String candidate : transcripts) {
                if (candidate != null && !candidate.trim().isEmpty()) {
                    transcript = candidate.trim();
                    break;
                }
            }
        }
        if (transcript != null) {
            emitNativeVoiceEvent(
                    activeNativeVoiceNavigationGeneration,
                    activeNativeVoicePageUrl,
                    "result",
                    transcript,
                    null);
        }
        finishNativeVoiceSession(sessionId);
    }

    private RecognitionListener createNativeVoiceRecognitionListener(final int sessionId) {
        return new RecognitionListener() {
            @Override
            public void onReadyForSpeech(Bundle params) {
                // The explicit started event is emitted after startListening succeeds.
            }

            @Override
            public void onBeginningOfSpeech() {
                // Final results are the only speech payload exposed to the WebView.
            }

            @Override
            public void onRmsChanged(float rmsdB) {
                // Audio level is intentionally not exposed to the web application.
            }

            @Override
            public void onBufferReceived(byte[] buffer) {
                // Raw microphone data is never exposed to JavaScript.
            }

            @Override
            public void onEndOfSpeech() {
                // Wait for onResults or onError so a press-to-talk release can return its final phrase.
            }

            @Override
            public void onError(int error) {
                runNativeVoiceOnUiThread(() -> handleNativeVoiceError(sessionId, error));
            }

            @Override
            public void onResults(Bundle results) {
                ArrayList<String> transcripts = results == null
                        ? null
                        : results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                ArrayList<String> finalTranscripts = transcripts == null
                        ? null
                        : new ArrayList<>(transcripts);
                runNativeVoiceOnUiThread(
                        () -> handleNativeVoiceResults(sessionId, finalTranscripts));
            }

            @Override
            public void onPartialResults(Bundle partialResults) {
                // Partial transcript callbacks are deliberately ignored.
            }

            @Override
            public void onEvent(int eventType, Bundle params) {
                // Platform-specific recognizer events are not part of the app bridge contract.
            }
        };
    }

    @SuppressLint("NewApi")
    private void beginNativeVoiceRecognition(
            int sessionId, int navigationGeneration, String pageUrl) {
        if (sessionId == 0
                || !nativeVoiceActivityActive
                || !isCurrentNativeVoicePage(navigationGeneration, pageUrl)
                || !hasRecordAudioPermission()) {
            return;
        }
        if (!isOnDeviceVoiceAvailableOnUiThread()) {
            if (pendingNativeVoiceSessionId == sessionId) {
                clearPendingNativeVoiceStart();
            }
            emitNativeVoiceFailure(navigationGeneration, pageUrl, "unavailable");
            return;
        }

        if (pendingNativeVoiceSessionId == sessionId) {
            clearPendingNativeVoiceStart();
        }
        destroyNativeVoiceRecognizer();

        try {
            SpeechRecognizer recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(this);
            nativeVoiceRecognizer = recognizer;
            activeNativeVoiceSessionId = sessionId;
            activeNativeVoiceNavigationGeneration = navigationGeneration;
            activeNativeVoicePageUrl = pageUrl;
            recognizer.setRecognitionListener(createNativeVoiceRecognitionListener(sessionId));

            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                    .putExtra(RecognizerIntent.EXTRA_LANGUAGE, NATIVE_VOICE_LANGUAGE)
                    .putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, NATIVE_VOICE_LANGUAGE)
                    .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
                    .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
                    .putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
            recognizer.startListening(intent);
            if (isActiveNativeVoiceSession(sessionId)) {
                emitNativeVoiceEvent(navigationGeneration, pageUrl, "started", null, null);
            }
        } catch (SecurityException securityException) {
            if (activeNativeVoiceSessionId == sessionId) {
                destroyNativeVoiceRecognizer();
            }
            emitNativeVoiceFailure(navigationGeneration, pageUrl, "not-allowed");
        } catch (RuntimeException unavailable) {
            if (activeNativeVoiceSessionId == sessionId) {
                destroyNativeVoiceRecognizer();
            }
            emitNativeVoiceFailure(navigationGeneration, pageUrl, "unavailable");
        }
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
        destroyNativeVoiceRecognizer();
        int sessionId = nextNativeVoiceSessionId();
        int navigationGeneration = topLevelNavigationGeneration;
        String pageUrl = currentTopLevelPageUrl;
        pendingNativeVoiceSessionId = sessionId;
        pendingNativeVoiceNavigationGeneration = navigationGeneration;
        pendingNativeVoicePageUrl = pageUrl;

        if (!isOnDeviceVoiceAvailableOnUiThread()) {
            clearPendingNativeVoiceStart();
            emitNativeVoiceFailure(navigationGeneration, pageUrl, "unavailable");
            return;
        }

        if (hasRecordAudioPermission()) {
            beginNativeVoiceRecognition(sessionId, navigationGeneration, pageUrl);
            return;
        }

        // Native voice has priority over a generic WebView capture request; the latter is never
        // used as a recognition fallback and is denied before requesting the Android permission.
        denyPendingAudioPermissionRequest();
        if (!nativeVoicePermissionRequestInFlight) {
            nativeVoicePermissionRequestInFlight = true;
            requestPermissions(
                    new String[] { Manifest.permission.RECORD_AUDIO },
                    NATIVE_VOICE_RECORD_AUDIO_PERMISSION_REQUEST);
        }
    }

    private void stopNativeVoice() {
        clearPendingNativeVoiceStart();
        if (nativeVoiceRecognizer == null || activeNativeVoiceSessionId == 0) {
            return;
        }
        try {
            nativeVoiceRecognizer.stopListening();
        } catch (RuntimeException ignored) {
            int navigationGeneration = activeNativeVoiceNavigationGeneration;
            String pageUrl = activeNativeVoicePageUrl;
            destroyNativeVoiceRecognizer();
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
        boolean hadActiveSession = nativeVoiceRecognizer != null || activeNativeVoiceSessionId != 0;
        int navigationGeneration = activeNativeVoiceNavigationGeneration;
        String pageUrl = activeNativeVoicePageUrl;
        destroyNativeVoiceRecognizer();
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

    private void denyPendingAudioPermissionRequest() {
        PermissionRequest pendingRequest = pendingAudioPermissionRequest;
        pendingAudioPermissionRequest = null;
        if (pendingRequest != null) {
            pendingRequest.deny();
        }
    }

    private void handleAudioPermissionRequest(PermissionRequest request) {
        if (!isTrustedAudioPermissionRequest(request)
                || nativeVoicePermissionRequestInFlight
                || isFinishing()
                || isDestroyed()) {
            request.deny();
            return;
        }

        if (hasRecordAudioPermission()) {
            request.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
            return;
        }

        if (pendingAudioPermissionRequest != null) {
            request.deny();
            return;
        }

        pendingAudioPermissionRequest = request;
        requestPermissions(
                new String[] { Manifest.permission.RECORD_AUDIO },
                RECORD_AUDIO_PERMISSION_REQUEST);
    }

    @Override
    @SuppressLint("SetJavaScriptEnabled") // The simulator is a bundled, CSP-restricted offline application.
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

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
                denyPendingAudioPermissionRequest();
                cancelNativeVoice();
                view.destroy();
                MainActivity.this.runOnUiThread(MainActivity.this::recreate);
                return true;
            }
        });

        simulator.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                handleAudioPermissionRequest(request);
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                if (request == pendingAudioPermissionRequest) {
                    pendingAudioPermissionRequest = null;
                }
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
        if (requestCode != RECORD_AUDIO_PERMISSION_REQUEST) {
            return;
        }

        PermissionRequest pendingRequest = pendingAudioPermissionRequest;
        pendingAudioPermissionRequest = null;
        if (pendingRequest == null) {
            return;
        }

        if (hasRecordAudioPermission()
                && !isFinishing()
                && !isDestroyed()
                && isTrustedAudioPermissionRequest(pendingRequest)) {
            pendingRequest.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
        } else {
            pendingRequest.deny();
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
        denyPendingAudioPermissionRequest();
        cancelNativeVoice();
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
