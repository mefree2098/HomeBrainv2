package com.homebrain.photoframe;

import android.Manifest;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.util.Base64;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/** Native-only installer. The WebView has no access to this class. */
final class FrameUpdates {
    static final String STORE = "homebrain_frame";
    private static final String HARDWARE = "humblestead-10.1-1280x800";
    private static boolean started;
    private final Context context;
    private final SharedPreferences preferences;
    private String installedDigest;

    private FrameUpdates(Context context) { this.context = context.getApplicationContext(); preferences = context.getSharedPreferences(STORE, Context.MODE_PRIVATE); }
    static synchronized void start(Context context) {
        if (started) return;
        started = true;
        FrameUpdates worker = new FrameUpdates(context);
        Executors.newSingleThreadScheduledExecutor().scheduleWithFixedDelay(worker::tick, 5, 30, TimeUnit.SECONDS);
    }
    private static final class Connection {
        final String base, token, pin;
        Connection(String link) {
            Uri uri = Uri.parse(link);
            Uri fragment = Uri.parse("https://pair.invalid/?" + (uri.getFragment() == null ? "" : uri.getFragment()));
            String frame = fragment.getQueryParameter("frame");
            token = fragment.getQueryParameter("token"); pin = fragment.getQueryParameter("key");
            if (!("https".equals(uri.getScheme()) || "http".equals(uri.getScheme())) || uri.getHost() == null || uri.getUserInfo() != null || !"/api/photo-frames/player/".equals(uri.getPath()) || frame == null || !frame.matches("[a-fA-F0-9]{24}") || token == null || !token.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("Invalid frame connection");
            base = uri.buildUpon().path("/api/photo-frames/" + frame + "/device/updates").clearQuery().fragment(null).build().toString();
        }
    }
    private HttpURLConnection open(Connection connection, String suffix) throws Exception {
        HttpURLConnection request = (HttpURLConnection)new URL(connection.base + suffix).openConnection();
        request.setConnectTimeout(15000); request.setReadTimeout(30000); request.setInstanceFollowRedirects(false);
        request.setRequestProperty("X-HomeBrain-Frame-Token", connection.token);
        return request;
    }
    private static byte[] read(InputStream input, int max) throws Exception {
        try (InputStream stream = input; ByteArrayOutputStream result = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192]; int count;
            while ((count = stream.read(buffer)) != -1) { if (result.size() + count > max) throw new SecurityException("Response exceeds size limit"); result.write(buffer, 0, count); }
            return result.toByteArray();
        }
    }
    private JSONObject get(Connection connection) throws Exception {
        HttpURLConnection request = open(connection, "");
        try {
            if (request.getResponseCode() != 200) throw new java.io.IOException("Update service unavailable");
            return new JSONObject(new String(read(request.getInputStream(), 65536), StandardCharsets.UTF_8));
        } finally { request.disconnect(); }
    }
    @SuppressWarnings("deprecation")
    private PackageInfo installed() throws Exception { return context.getPackageManager().getPackageInfo(context.getPackageName(), PackageManager.GET_SIGNATURES); }
    @SuppressWarnings("deprecation")
    private static long version(PackageInfo info) { return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode; }
    private boolean capable(Connection connection) {
        return connection.pin != null && connection.pin.matches("[a-f0-9]{64}") && context.checkSelfPermission(Manifest.permission.INSTALL_PACKAGES) == PackageManager.PERMISSION_GRANTED;
    }
    private void report(Connection connection, String job, String status, int progress, String message) throws Exception {
        PackageInfo installed = installed();
        JSONObject body = new JSONObject().put("software", new JSONObject().put("versionCode", version(installed)).put("versionName", installed.versionName).put("sha256", installedDigest()).put("otaCapable", capable(connection)));
        if (job != null) body.put("jobId", job).put("status", status).put("progress", progress).put("message", message);
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        HttpURLConnection request = open(connection, "/report");
        try {
            request.setRequestMethod("POST"); request.setDoOutput(true); request.setRequestProperty("Content-Type", "application/json"); request.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream output = request.getOutputStream()) { output.write(bytes); }
            if (request.getResponseCode() != 200) throw new java.io.IOException("Update report rejected");
        } finally { request.disconnect(); }
    }
    private String installedDigest() throws Exception {
        // Package replacement restarts this process, so this cache always belongs
        // to its actual installed APK, including after a lost completion report.
        if (installedDigest == null) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (InputStream input = new FileInputStream(context.getApplicationInfo().sourceDir)) {
                byte[] buffer = new byte[32768]; int count;
                while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
            }
            StringBuilder hex = new StringBuilder();
            for (byte value : digest.digest()) hex.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
            installedDigest = hex.toString();
        }
        return installedDigest;
    }
    private void clearPending() { preferences.edit().remove("update_job").remove("update_started").remove("update_error").remove("update_session").commit(); }
    private String phase(String current, String next) {
        String[] phases = {"queued", "downloading", "verifying", "installing", "restarting"};
        int oldIndex = 0, newIndex = 0;
        for (int i = 0; i < phases.length; i++) { if (phases[i].equals(current)) oldIndex = i; if (phases[i].equals(next)) newIndex = i; }
        return phases[Math.max(oldIndex, newIndex)];
    }
    private void tick() {
        Connection connection;
        try { connection = new Connection(preferences.getString("player_url", "")); } catch (Exception ignored) { return; }
        String job = null;
        try {
            report(connection, null, null, 0, "");
            JSONObject response = get(connection);
            JSONObject update = response.optJSONObject("update");
            if (update == null) { clearPending(); return; }
            job = update.getString("jobId");
            if (!job.matches("[a-f0-9-]{36}")) throw new SecurityException("Invalid update assignment");
            if (!capable(connection)) throw new SecurityException("OTA installer permission or hub key pin is missing; reprovision or pair this frame");
            String payload = update.getString("payload");
            UpdateTrust.verify(Base64.decode(response.getString("publicKey"), Base64.DEFAULT), connection.pin, payload.getBytes(StandardCharsets.UTF_8), Base64.decode(update.getString("signature"), Base64.DEFAULT));
            JSONObject release = new JSONObject(payload);
            if (release.getInt("protocol") != 1 || !"runtime-apk".equals(release.getString("kind")) || !context.getPackageName().equals(release.getString("packageName")) || !HARDWARE.equals(release.getString("hardwareProfile"))) throw new SecurityException("Release is incompatible with this frame");
            long target = release.getLong("versionCode");
            if (version(installed()) == target) {
                if (!installedDigest().equals(release.getString("sha256"))) throw new SecurityException("Installed APK does not match the assigned release");
                report(connection, job, "complete", 100, "Installed and restarted successfully"); clearPending(); new File(context.getCacheDir(), "frame-update.apk").delete(); return;
            }
            UpdateTrust.checkUpgrade(version(installed()), target, release.getLong("bytes"));
            if (job.equals(preferences.getString("update_job", ""))) {
                String installError = preferences.getString("update_error", "");
                if (!installError.isEmpty()) throw new SecurityException(installError);
                if (System.currentTimeMillis() - preferences.getLong("update_started", 0) < 600000) return;
                int sessionId = preferences.getInt("update_session", -1);
                if (sessionId >= 0) { try { context.getPackageManager().getPackageInstaller().abandonSession(sessionId); } catch (Exception ignored) { /* session may have finished */ } }
                throw new SecurityException("Installation did not restart within ten minutes");
            }
            String current = update.getString("status");
            report(connection, job, phase(current, "downloading"), 10, "Downloading signed release");
            File file = new File(context.getCacheDir(), "frame-update.apk");
            HttpURLConnection request = open(connection, "/" + job + "/apk");
            try {
                if (request.getResponseCode() != 200) throw new java.io.IOException("Download unavailable; will retry");
                MessageDigest digest = MessageDigest.getInstance("SHA-256"); long count = 0;
                try (InputStream input = request.getInputStream(); FileOutputStream output = new FileOutputStream(file, false)) {
                    byte[] buffer = new byte[32768]; int length;
                    while ((length = input.read(buffer)) != -1) { count += length; if (count > release.getLong("bytes") || count > UpdateTrust.MAX_BYTES) throw new SecurityException("APK exceeds declared size"); output.write(buffer, 0, length); digest.update(buffer, 0, length); }
                    output.getFD().sync();
                }
                byte[] expected = new byte[32]; String hex = release.getString("sha256");
                if (!hex.matches("[a-f0-9]{64}")) throw new SecurityException("Invalid release digest");
                for (int i = 0; i < 32; i++) expected[i] = (byte)Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
                if (count != release.getLong("bytes") || !MessageDigest.isEqual(expected, digest.digest())) throw new SecurityException("APK checksum mismatch");
            } finally { request.disconnect(); }
            report(connection, job, phase(current, "verifying"), 80, "Verifying APK identity and signer");
            verifyApk(file, release);
            report(connection, job, phase(current, "installing"), 95, "Installing; waiting for restart confirmation");
            install(file, job);
        } catch (SecurityException error) {
            if (job != null) { try { report(connection, job, "failed", 0, error.getMessage()); clearPending(); } catch (Exception ignored) { /* preserve state and retry the report */ } }
        } catch (Exception ignored) { /* Offline or hub restarting: retain the assignment and retry. Never report success without the installed target version. */ }
    }
    @SuppressWarnings("deprecation")
    private void verifyApk(File file, JSONObject release) throws Exception {
        PackageInfo archive = context.getPackageManager().getPackageArchiveInfo(file.getAbsolutePath(), PackageManager.GET_SIGNATURES | PackageManager.GET_PERMISSIONS | PackageManager.GET_RECEIVERS | PackageManager.GET_ACTIVITIES);
        PackageInfo current = installed();
        if (archive == null || archive.signatures == null || archive.signatures.length != 1 || current.signatures == null || current.signatures.length != 1) throw new SecurityException("APK signature is missing or unsupported");
        UpdateTrust.checkApk(context.getPackageName(), archive.packageName, release.getLong("versionCode"), version(archive), current.signatures[0].toByteArray(), archive.signatures[0].toByteArray());
        if (!release.getString("versionName").equals(archive.versionName)) throw new SecurityException("APK version name does not match the release");
        if (archive.requestedPermissions == null || !java.util.Arrays.asList(archive.requestedPermissions).containsAll(java.util.Arrays.asList(Manifest.permission.INTERNET, Manifest.permission.INSTALL_PACKAGES, Manifest.permission.RECEIVE_BOOT_COMPLETED))) throw new SecurityException("Release would remove a required OTA permission");
        boolean activity = false;
        if (archive.activities != null) for (android.content.pm.ActivityInfo candidate : archive.activities) {
            if (candidate.enabled && MainActivity.class.getName().equals(candidate.name)) activity = true;
        }
        if (!activity || archive.applicationInfo == null || !archive.applicationInfo.enabled) throw new SecurityException("Release would remove or disable the display startup activity");
        boolean startReceiver = false, installReceiver = false;
        if (archive.receivers != null) for (android.content.pm.ActivityInfo receiver : archive.receivers) {
            if (receiver.enabled && !receiver.exported && FrameStartReceiver.class.getName().equals(receiver.name)) startReceiver = true;
            if (receiver.enabled && !receiver.exported && FrameInstallReceiver.class.getName().equals(receiver.name)) installReceiver = true;
        }
        if (!startReceiver || !installReceiver) throw new SecurityException("Release would remove OTA restart or installation callbacks");
    }
    private void install(File file, String job) throws Exception {
        PackageInstaller installer = context.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(context.getPackageName()); params.setSize(file.length());
        int id = installer.createSession(params);
        try (PackageInstaller.Session session = installer.openSession(id)) {
            try (InputStream input = new FileInputStream(file); OutputStream output = session.openWrite("base.apk", 0, file.length())) {
                byte[] buffer = new byte[32768]; int length;
                while ((length = input.read(buffer)) != -1) output.write(buffer, 0, length);
                session.fsync(output);
            }
            // Persist before commit, which can kill this process as its APK is replaced.
            if (!preferences.edit().putString("update_job", job).putLong("update_started", System.currentTimeMillis()).putInt("update_session", id).remove("update_error").commit()) throw new SecurityException("Cannot persist update recovery state");
            Intent intent = new Intent(context, FrameInstallReceiver.class).setAction("com.homebrain.photoframe.INSTALL_RESULT").putExtra("job", job);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            PendingIntent callback = PendingIntent.getBroadcast(context, id, intent, flags);
            session.commit(callback.getIntentSender());
        } catch (Exception error) {
            try { installer.abandonSession(id); } catch (Exception ignored) { /* already committed */ }
            preferences.edit().putString("update_job", job).putLong("update_started", 0).putString("update_error", "Android rejected the update installation").commit();
            throw error;
        }
    }
}
