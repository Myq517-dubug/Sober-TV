package com.sobertv.app;

import android.app.Activity;
import android.content.pm.ActivityInfo;
import android.os.Build;
import android.view.View;
import android.view.WindowManager;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 屏幕方向与沉浸式模式
 *
 * ── 为什么单独一个插件 ──────────────────────────────
 * AndroidManifest 里写的是 `screenOrientation="fullUser"`，
 * 意思是「跟随用户的自动旋转设置」—— 但很多用户的系统自动旋转是关的，
 * 或者在播放时 they'd 期望强制横屏。
 *
 * 前端要能**主动**要求横屏/竖屏，必须调用 Activity 的
 * `setRequestedOrientation()`，这是纯原生 API，Web 侧没有对应能力。
 *
 * ── 沉浸式（隐藏状态栏/导航栏）─────────────────────
 * 视频播放时全屏观感更好。用 `WindowInsetsControllerCompat` 实现，
 * 兼容 API 23+（不用 WindowInsetsController，那是 API 30+）。
 *
 * ⚠️ 关键：旋转屏幕 / 窗口失去再获得焦点时，系统会把系统栏重新显示出来，
 *    所以必须用静态标记 + onWindowFocusChanged 重新应用沉浸式，
 *    否则表现为「切了横屏但状态栏还在」（用户实测反馈）。
 */
@CapacitorPlugin(name = "ScreenOrientation")
public class ScreenOrientationPlugin extends BasePlugin {

    /** 是否处于沉浸式（全屏）状态 —— 静态，供 Activity 重建/失焦时重新应用 */
    private static boolean sImmersive = false;

    @PluginMethod
    public void setLandscape(PluginCall call) {
        boolean enable = Boolean.TRUE.equals(call.getBoolean("enable", true));
        runOnUi(() -> {
            try {
                Activity act = getActivity();
                if (act == null) {
                    call.reject("Activity 不可用");
                    return;
                }
                act.setRequestedOrientation(
                        enable
                                ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                                : ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT);
                // 横屏时进入沉浸式（隐藏状态栏与导航栏）
                setImmersive(act, enable);
                call.resolve();
            } catch (Exception e) {
                call.reject("切换横屏失败: " + e.getMessage());
            }
        });
    }

    /** 恢复为「跟随系统」的自动旋转 */
    @PluginMethod
    public void unlock(PluginCall call) {
        runOnUi(() -> {
            try {
                Activity act = getActivity();
                if (act == null) {
                    call.reject("Activity 不可用");
                    return;
                }
                act.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_FULL_USER);
                setImmersive(act, false);
                call.resolve();
            } catch (Exception e) {
                call.reject("恢复方向失败: " + e.getMessage());
            }
        });
    }

    /** 查询当前是否为横屏 */
    @PluginMethod
    public void isLandscape(PluginCall call) {
        runOnUi(() -> {
            try {
                Activity act = getActivity();
                if (act == null) {
                    call.reject("Activity 不可用");
                    return;
                }
                int orientation = act.getResources().getConfiguration().orientation;
                boolean landscape =
                        orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE;
                JSObject ret = new JSObject();
                ret.put("landscape", landscape);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("查询方向失败: " + e.getMessage());
            }
        });
    }

    /**
     * 单独开关沉浸式（不改变屏幕方向）
     *
     * 播放页用：进入播放即全屏，退出播放恢复系统栏。
     */
    @PluginMethod
    public void setImmersive(PluginCall call) {
        boolean enable = Boolean.TRUE.equals(call.getBoolean("enable", true));
        runOnUi(() -> {
            try {
                Activity act = getActivity();
                if (act == null) {
                    call.reject("Activity 不可用");
                    return;
                }
                applyImmersive(act, enable);
                call.resolve();
            } catch (Exception e) {
                call.reject("设置沉浸式失败: " + e.getMessage());
            }
        });
    }

    /**
     * 查询系统栏 / 刘海的安全内边距（单位：dp = CSS px）
     *
     * WebView 里 env(safe-area-inset-*) 在 Android 上不可靠，
     * 横屏时刘海会切掉左/右侧的控制按钮 → 用真实 inset 规避。
     */
    @PluginMethod
    public void getInsets(PluginCall call) {
        runOnUi(() -> {
            try {
                Activity act = getActivity();
                if (act == null) {
                    call.reject("Activity 不可用");
                    return;
                }
                /**
                 * 取真实 inset。
                 *
                 * ⚠️ 注意 API 归属（实测踩坑）：
                 *   - `WindowInsetsControllerCompat` **没有** getInsets(int) 方法
                 *     （那是 API 30+ 的原生 android.view.WindowInsetsController 才有）
                 *   - 正确路径：view.getRootWindowInsets() → WindowInsetsCompat.toWindowInsetsCompat()
                 *     → .getInsets(type)，返回 androidx.core.graphics.Insets
                 *   - androidx.core.graphics.Insets 的 top/bottom/left/right 是 **public final int 字段**
                 *     （不是 getter 方法）
                 */
                android.view.WindowInsets root = act.getWindow().getDecorView().getRootWindowInsets();
                if (root == null) {
                    call.reject("安全区不可用");
                    return;
                }
                WindowInsetsCompat compat = WindowInsetsCompat.toWindowInsetsCompat(root);
                androidx.core.graphics.Insets insets =
                        compat.getInsets(
                                WindowInsetsCompat.Type.systemBars()
                                        | WindowInsetsCompat.Type.displayCutout()
                        );

                float d = act.getResources().getDisplayMetrics().density;
                if (d <= 0f) d = 1f;

                JSObject ret = new JSObject();
                ret.put("top", insets.top / d);
                ret.put("bottom", insets.bottom / d);
                ret.put("left", insets.left / d);
                ret.put("right", insets.right / d);
                ret.put("immersive", sImmersive);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("读取安全区失败: " + e.getMessage());
            }
        });
    }

    /**
     * 沉浸式模式
     *
     * @param immersive true = 隐藏状态栏与导航栏（横屏观影）
     */
    private void setImmersive(Activity act, boolean immersive) {
        applyImmersive(act, immersive);
    }

    /** 实际应用沉浸式（供 Activity 在焦点变化时复用） */
    private static void applyImmersive(Activity act, boolean immersive) {
        try {
            sImmersive = immersive;

            // 允许内容延伸到刘海/系统栏区域 —— 否则沉浸式只是「藏起来」，
            // 布局仍按有系统栏计算，画面无法真正铺满。
            WindowCompat.setDecorFitsSystemWindows(act.getWindow(), false);

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                WindowInsetsControllerCompat c =
                        WindowCompat.getInsetsController(act.getWindow(), act.getWindow().getDecorView());
                if (immersive) {
                    c.hide(WindowInsetsCompat.Type.systemBars());
                    c.setSystemBarsBehavior(
                            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                } else {
                    c.show(WindowInsetsCompat.Type.systemBars());
                }
            } else {
                View decor = act.getWindow().getDecorView();
                if (immersive) {
                    decor.setSystemUiVisibility(
                            View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                                    | View.SYSTEM_UI_FLAG_FULLSCREEN
                                    | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
                } else {
                    decor.setSystemUiVisibility(
                            View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
                }
            }

            if (immersive) {
                act.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }

            // 沉浸式下允许内容画进刘海区域（横屏挖孔屏必需）
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                act.getWindow().getAttributes().layoutInDisplayCutoutMode =
                        WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            }
        } catch (Exception e) {
            // 沉浸式失败不影响主流程
        }
    }

    /**
     * 由 Activity 在窗口焦点变化时调用
     *
     * Android 在旋转屏幕或应用短暂失焦后会自动把系统栏显示回来，
     * 必须重新隐藏，否则用户会看到「切了横屏但状态栏还在」。
     */
    public static void onWindowFocusChanged(Activity act, boolean hasFocus) {
        if (!hasFocus || act == null) return;
        if (!sImmersive) return;
        // 延迟一小会儿，等系统完成旋转动画再隐藏，否则会被系统的动画覆盖
        act.getWindow().getDecorView().postDelayed(() -> applyImmersive(act, true), 120);
    }
}
