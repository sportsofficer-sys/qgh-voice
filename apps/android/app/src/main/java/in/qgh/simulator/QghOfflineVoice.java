package in.qgh.simulator;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.vosk.Model;
import org.vosk.Recognizer;
import org.vosk.android.RecognitionListener;
import org.vosk.android.SpeechService;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

/**
 * Local Vosk adapter. It deliberately exposes only final text to its caller and never makes a
 * network request. The model archive is bundled in Android assets and extracted to private app
 * storage on first use.
 */
final class QghOfflineVoice {
    interface Listener {
        void onStarted();
        void onFinalText(String transcript);
        void onError(String code);
        void onEnded();
    }

    // Android's asset packager expands the source .tar.gz asset and exposes it under the
    // corresponding .tar name inside the APK. Read that packaged TAR stream directly.
    private static final String MODEL_ARCHIVE =
            "voice-models/qgh-vosk-en-us-small-0.15.tar";
    private static final String MODEL_DIRECTORY = "qgh-vosk-model-v1";
    private static final String MODEL_ROOT = "vosk-model-small-en-us-0.15";
    private static final int TAR_BLOCK_SIZE = 512;
    private static final int MAX_GRAMMAR_BYTES = 500_000;
    private static final int MAX_GRAMMAR_PHRASES = 12_000;
    private static final float SAMPLE_RATE = 16_000.0f;
    private static final Pattern SAFE_GRAMMAR_PHRASE = Pattern.compile("[a-z0-9\\[\\] -]+");

    private enum ModelState { PREPARING, READY, FAILED, CLOSED }

    private final Context context;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Object lifecycleLock = new Object();

    private volatile ModelState modelState = ModelState.PREPARING;
    private volatile Model model;
    private Recognizer recognizer;
    private SpeechService speechService;
    private Listener activeListener;
    private String grammar = "[\"[unk]\"]";

    QghOfflineVoice(Context sourceContext) {
        context = sourceContext.getApplicationContext();
        prepareModel();
    }

    String capability() {
        return modelState == ModelState.READY && model != null
                ? "available"
                : modelState == ModelState.PREPARING ? "preparing" : "unavailable";
    }

    void setGrammar(String candidate) {
        String sanitized = sanitizeGrammar(candidate);
        if (!sanitized.equals(grammar)) {
            grammar = sanitized;
        }
    }

    private static String sanitizeGrammar(String candidate) {
        if (candidate == null || candidate.length() > MAX_GRAMMAR_BYTES) {
            return "[\"[unk]\"]";
        }
        try {
            JSONArray input = new JSONArray(candidate);
            JSONArray approved = new JSONArray();
            boolean hasUnknown = false;
            for (int index = 0; index < input.length() && index < MAX_GRAMMAR_PHRASES; index += 1) {
                String phrase = input.optString(index, "").trim().toLowerCase();
                if (phrase.isEmpty()
                        || phrase.length() > 120
                        || !SAFE_GRAMMAR_PHRASE.matcher(phrase).matches()) {
                    continue;
                }
                if ("[unk]".equals(phrase)) {
                    hasUnknown = true;
                }
                approved.put(phrase);
            }
            if (!hasUnknown) {
                approved.put("[unk]");
            }
            return approved.toString();
        } catch (JSONException ignored) {
            return "[\"[unk]\"]";
        }
    }

    void start(Listener listener) {
        if (modelState != ModelState.READY || model == null) {
            listener.onError(modelState == ModelState.PREPARING ? "preparing" : "unavailable");
            listener.onEnded();
            return;
        }
        cancel();
        Recognizer nextRecognizer = null;
        SpeechService nextService = null;
        boolean sessionAttached = false;
        try {
            nextRecognizer = new Recognizer(model, SAMPLE_RATE, grammar);
            nextService = new SpeechService(nextRecognizer, SAMPLE_RATE);
            synchronized (lifecycleLock) {
                if (modelState != ModelState.READY || model == null) {
                    throw new IllegalStateException("Offline voice is no longer available");
                }
                recognizer = nextRecognizer;
                speechService = nextService;
                activeListener = listener;
                sessionAttached = true;
            }
            final SpeechService serviceForListener = nextService;
            serviceForListener.startListening(new RecognitionListener() {
                @Override
                public void onPartialResult(String hypothesis) {
                    // Partial transcription is never routed to simulator controls.
                }

                @Override
                public void onResult(String hypothesis) {
                    // The final result is emitted only after the local session finishes.
                }

                @Override
                public void onFinalResult(String hypothesis) {
                    final String transcript = transcriptFrom(hypothesis);
                    mainHandler.post(() -> finishCurrentSession(transcript, null));
                }

                @Override
                public void onError(Exception exception) {
                    mainHandler.post(() -> finishCurrentSession(null, "unavailable", true));
                }

                @Override
                public void onTimeout() {
                    mainHandler.post(() -> finishCurrentSession(null, "no-speech"));
                }
            });
            listener.onStarted();
        } catch (SecurityException denied) {
            handleStartFailure(nextService, nextRecognizer, listener, sessionAttached, "not-allowed");
        } catch (IOException | RuntimeException unavailable) {
            handleStartFailure(nextService, nextRecognizer, listener, sessionAttached, "unavailable");
        }
    }

    void stop() {
        SpeechService service;
        synchronized (lifecycleLock) {
            service = speechService;
        }
        if (service == null) {
            return;
        }
        try {
            service.stop();
        } catch (RuntimeException unavailable) {
            finishCurrentSession(null, "unavailable", true);
        }
    }

    void cancel() {
        finishCurrentSession(null, null, true);
    }

    void close() {
        cancel();
        final Model current;
        synchronized (lifecycleLock) {
            modelState = ModelState.CLOSED;
            current = model;
            model = null;
        }
        closeModel(current);
        worker.shutdownNow();
    }

    private void finishCurrentSession(String transcript, String error) {
        finishCurrentSession(transcript, error, false);
    }

    private void finishCurrentSession(String transcript, String error, boolean cancelService) {
        final SpeechService service;
        final Recognizer currentRecognizer;
        final Listener listener;
        synchronized (lifecycleLock) {
            service = speechService;
            currentRecognizer = recognizer;
            listener = activeListener;
            speechService = null;
            recognizer = null;
            activeListener = null;
        }
        releaseSpeechService(service, cancelService);
        closeRecognizer(currentRecognizer);
        if (listener == null) {
            return;
        }
        if (error != null && !"no-speech".equals(error)) {
            listener.onError(error);
        }
        if (transcript != null && !transcript.isEmpty()) {
            listener.onFinalText(transcript);
        }
        listener.onEnded();
    }

    private void handleStartFailure(
            SpeechService service,
            Recognizer createdRecognizer,
            Listener listener,
            boolean sessionAttached,
            String error
    ) {
        if (sessionAttached) {
            finishCurrentSession(null, error, true);
            return;
        }
        releaseSpeechService(service, true);
        closeRecognizer(createdRecognizer);
        listener.onError(error);
        listener.onEnded();
    }

    private static void releaseSpeechService(SpeechService service, boolean cancelService) {
        if (service == null) {
            return;
        }
        if (cancelService) {
            try {
                service.cancel();
            } catch (RuntimeException ignored) {
                // Cancellation is best-effort while tearing down an active microphone.
            }
        }
        try {
            service.shutdown();
        } catch (RuntimeException ignored) {
            // Service shutdown is best-effort during lifecycle changes.
        }
    }

    private static void closeRecognizer(Recognizer currentRecognizer) {
        if (currentRecognizer == null) {
            return;
        }
        try {
            currentRecognizer.close();
        } catch (RuntimeException ignored) {
            // Recognizer may already be released by the service.
        }
    }

    private static String transcriptFrom(String hypothesis) {
        if (hypothesis == null || hypothesis.isEmpty()) {
            return "";
        }
        try {
            return new JSONObject(hypothesis).optString("text", "").trim();
        } catch (JSONException ignored) {
            return "";
        }
    }

    private void prepareModel() {
        worker.execute(() -> {
            Model prepared = null;
            try {
                File modelDirectory = unpackModelArchive();
                prepared = new Model(modelDirectory.getAbsolutePath());
            } catch (IOException | RuntimeException failure) {
                synchronized (lifecycleLock) {
                    if (modelState != ModelState.CLOSED) {
                        modelState = ModelState.FAILED;
                    }
                }
                closeModel(prepared);
                return;
            }
            boolean closePrepared = false;
            synchronized (lifecycleLock) {
                if (modelState == ModelState.CLOSED) {
                    closePrepared = true;
                } else {
                    model = prepared;
                    modelState = ModelState.READY;
                }
            }
            if (closePrepared) {
                closeModel(prepared);
            }
        });
    }

    private static void closeModel(Model current) {
        if (current == null) {
            return;
        }
        try {
            current.close();
        } catch (RuntimeException ignored) {
            // Closing an already released native model is harmless.
        }
    }

    private File unpackModelArchive() throws IOException {
        File destination = new File(context.getFilesDir(), MODEL_DIRECTORY);
        File modelRoot = new File(destination, MODEL_ROOT);
        if (isValidModelDirectory(modelRoot)) {
            return modelRoot;
        }
        File staging = new File(context.getFilesDir(), MODEL_DIRECTORY + ".staging");
        deletePrivateDirectory(staging);
        if (!staging.mkdirs()) {
            throw new IOException("Could not create the offline voice staging directory");
        }
        try (InputStream archive = new BufferedInputStream(context.getAssets().open(MODEL_ARCHIVE))) {
            extractTarArchive(archive, staging);
        } catch (IOException failure) {
            deletePrivateDirectory(staging);
            throw failure;
        }
        File stagedModel = new File(staging, MODEL_ROOT);
        if (!isValidModelDirectory(stagedModel)) {
            deletePrivateDirectory(staging);
            throw new IOException("The bundled offline voice model is incomplete");
        }
        deletePrivateDirectory(destination);
        if (!staging.renameTo(destination)) {
            deletePrivateDirectory(staging);
            throw new IOException("Could not activate the offline voice model");
        }
        return new File(destination, MODEL_ROOT);
    }

    private static boolean isValidModelDirectory(File directory) {
        return new File(directory, "am/final.mdl").isFile()
                && new File(directory, "conf/model.conf").isFile()
                && new File(directory, "graph/Gr.fst").isFile();
    }

    private static void extractTarArchive(InputStream input, File outputRoot) throws IOException {
        byte[] header = new byte[TAR_BLOCK_SIZE];
        while (readFully(input, header, 0, header.length)) {
            if (isZeroBlock(header)) {
                return;
            }
            String name = tarString(header, 0, 100);
            String prefix = tarString(header, 345, 155);
            String entryName = prefix.isEmpty() ? name : prefix + "/" + name;
            long size = tarNumber(header, 124, 12);
            int entryType = header[156] & 0xff;
            if (!isSafeArchivePath(entryName) || size < 0) {
                throw new IOException("Unsafe bundled offline voice archive entry");
            }
            File target = safeChild(outputRoot, entryName);
            if (entryType == 0 || entryType == '0') {
                File parent = target.getParentFile();
                if (parent == null || (!parent.exists() && !parent.mkdirs())) {
                    throw new IOException("Could not create an offline voice model directory");
                }
                try (FileOutputStream output = new FileOutputStream(target)) {
                    copyExactly(input, output, size);
                }
            } else if (entryType == '5') {
                if (!target.exists() && !target.mkdirs()) {
                    throw new IOException("Could not create an offline voice model directory");
                }
                skipExactly(input, size);
            } else {
                throw new IOException("Unsupported entry in bundled offline voice archive");
            }
            long padding = (TAR_BLOCK_SIZE - (size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
            skipExactly(input, padding);
        }
        throw new IOException("Truncated bundled offline voice archive");
    }

    private static boolean readFully(InputStream input, byte[] buffer, int offset, int length) throws IOException {
        int position = offset;
        while (position < offset + length) {
            int read = input.read(buffer, position, offset + length - position);
            if (read < 0) {
                return position == offset;
            }
            position += read;
        }
        return true;
    }

    private static void copyExactly(InputStream input, FileOutputStream output, long length) throws IOException {
        byte[] buffer = new byte[16 * 1024];
        long remaining = length;
        while (remaining > 0) {
            int read = input.read(buffer, 0, (int) Math.min(buffer.length, remaining));
            if (read < 0) {
                throw new IOException("Truncated bundled offline voice archive");
            }
            output.write(buffer, 0, read);
            remaining -= read;
        }
    }

    private static void skipExactly(InputStream input, long length) throws IOException {
        long remaining = length;
        while (remaining > 0) {
            long skipped = input.skip(remaining);
            if (skipped <= 0) {
                if (input.read() < 0) {
                    throw new IOException("Truncated bundled offline voice archive");
                }
                skipped = 1;
            }
            remaining -= skipped;
        }
    }

    private static boolean isZeroBlock(byte[] block) {
        for (byte value : block) {
            if (value != 0) {
                return false;
            }
        }
        return true;
    }

    private static String tarString(byte[] data, int offset, int length) {
        int end = offset;
        while (end < offset + length && data[end] != 0) {
            end += 1;
        }
        return new String(data, offset, end - offset, java.nio.charset.StandardCharsets.UTF_8).trim();
    }

    private static long tarNumber(byte[] data, int offset, int length) throws IOException {
        long value = 0;
        int index = offset;
        while (index < offset + length && (data[index] == 0 || data[index] == ' ')) {
            index += 1;
        }
        for (; index < offset + length && data[index] >= '0' && data[index] <= '7'; index += 1) {
            value = (value << 3) + (data[index] - '0');
        }
        return value;
    }

    private static boolean isSafeArchivePath(String entryName) {
        return entryName != null
                && !entryName.isEmpty()
                && !entryName.startsWith("/")
                && !entryName.contains("\\")
                && !entryName.equals("..")
                && !entryName.startsWith("../")
                && !entryName.contains("/../");
    }

    private static File safeChild(File root, String entryName) throws IOException {
        File canonicalRoot = root.getCanonicalFile();
        File child = new File(root, entryName).getCanonicalFile();
        String prefix = canonicalRoot.getPath() + File.separator;
        if (!child.getPath().startsWith(prefix)) {
            throw new IOException("Unsafe bundled offline voice archive path");
        }
        return child;
    }

    private static void deletePrivateDirectory(File directory) {
        if (directory == null || !directory.exists()) {
            return;
        }
        File[] children = directory.listFiles();
        if (children != null) {
            for (File child : children) {
                if (child.isDirectory()) {
                    deletePrivateDirectory(child);
                } else {
                    child.delete();
                }
            }
        }
        directory.delete();
    }
}
