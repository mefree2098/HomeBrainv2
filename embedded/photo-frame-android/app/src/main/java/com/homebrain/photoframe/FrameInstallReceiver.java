package com.homebrain.photoframe;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInstaller;

public final class FrameInstallReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        SharedPreferences preferences = context.getSharedPreferences(FrameUpdates.STORE, Context.MODE_PRIVATE);
        if (!preferences.getString("update_job", "").equals(intent.getStringExtra("job"))) return;
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (status != PackageInstaller.STATUS_SUCCESS) {
            String reason = status == PackageInstaller.STATUS_PENDING_USER_ACTION ? "Silent installation permission is missing; reprovision this frame" : "Android rejected the APK (status " + status + ")";
            preferences.edit().putString("update_error", reason).commit();
        }
        FrameUpdateService.start(context, null);
    }
}
