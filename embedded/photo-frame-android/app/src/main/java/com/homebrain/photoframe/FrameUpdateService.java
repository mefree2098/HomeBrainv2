package com.homebrain.photoframe;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

/** Runs separately from WebView so the hub can repair a failed display runtime. */
public final class FrameUpdateService extends Service {
    static final String PLAYER_STORE = "homebrain_frame_player";
    static void start(Context context, String link) {
        Intent intent = new Intent(context, FrameUpdateService.class);
        if (link != null) intent.putExtra("player_url", link);
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent); else context.startService(intent);
    }
    @Override public void onCreate() {
        super.onCreate();
        Notification.Builder notification;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager manager = getSystemService(NotificationManager.class);
            manager.createNotificationChannel(new NotificationChannel("frame_management", "Frame management", NotificationManager.IMPORTANCE_LOW));
            notification = new Notification.Builder(this, "frame_management");
        } else notification = new Notification.Builder(this);
        Intent display = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent openDisplay = PendingIntent.getActivity(this, 0, display, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        startForeground(1, notification.setSmallIcon(android.R.drawable.stat_notify_sync).setContentTitle("HomeBrain Frame").setContentText("Tap to return to the display").setContentIntent(openDisplay).setOngoing(true).build());
        FrameUpdates.start(this);
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && intent.hasExtra("player_url")) {
            try { FrameUpdates.configure(this, intent.getStringExtra("player_url")); } catch (IllegalArgumentException ignored) { /* Preserve the last valid connection. */ }
        }
        return START_STICKY;
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
