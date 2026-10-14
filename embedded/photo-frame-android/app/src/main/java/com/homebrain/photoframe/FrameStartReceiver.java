package com.homebrain.photoframe;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class FrameStartReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction()) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) return;
        FrameUpdateService.start(context, null);
        // The provisioned PF1007L runs Android 6, which permits its HOME runtime
        // to return after boot and after PackageInstaller replaces its APK.
        context.startActivity(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP));
    }
}
