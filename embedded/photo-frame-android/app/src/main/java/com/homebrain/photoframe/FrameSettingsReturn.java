package com.homebrain.photoframe;

import android.content.Context;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.Button;

/** A small return control for ROMs that omit SystemUI and all navigation buttons. */
final class FrameSettingsReturn {
    private final Context context;
    private final WindowManager windows;
    private Button button;

    FrameSettingsReturn(Context context) {
        this.context = context;
        windows = context.getSystemService(WindowManager.class);
    }

    @SuppressWarnings("deprecation") // Android 6 uses TYPE_PHONE, before TYPE_APPLICATION_OVERLAY.
    boolean show() {
        if (button != null) return true;
        if (!Settings.canDrawOverlays(context)) return false;
        Button view = new Button(context);
        view.setText("Return to HomeBrain");
        view.setAllCaps(false);
        view.setTextSize(16);
        view.setTextColor(Color.WHITE);
        view.setBackgroundTintList(ColorStateList.valueOf(Color.rgb(24, 74, 100)));
        int margin = Math.round(8 * context.getResources().getDisplayMetrics().density);
        view.setElevation(margin);
        view.setOnClickListener(clicked -> {
            hide();
            context.startActivity(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP));
        });
        int type = Build.VERSION.SDK_INT >= 26 ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY : WindowManager.LayoutParams.TYPE_PHONE;
        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT, type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
        params.y = margin;
        try {
            windows.addView(view, params);
            button = view;
            return true;
        } catch (WindowManager.BadTokenException | SecurityException error) {
            Log.w("HomeBrainFrame", "Settings return control could not open", error);
            return false;
        }
    }

    void hide() {
        if (button == null) return;
        windows.removeView(button);
        button = null;
    }
}
