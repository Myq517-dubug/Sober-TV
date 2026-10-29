package com.sobertv.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 注册自定义原生播放器插件（Media3 ExoPlayer）
        registerPlugin(NativePlayerPlugin.class);
        // 横屏/沉浸式
        registerPlugin(ScreenOrientationPlugin.class);
        // DLNA 投屏
        registerPlugin(CastPlugin.class);
        super.onCreate(savedInstanceState);
    }

    /**
     * 窗口焦点变化 → 重新应用沉浸式
     *
     * 旋转屏幕 / 应用切后台再回来时，Android 会自动把状态栏和导航栏显示回来。
     * 若不重新隐藏，用户看到的就是「已经切横屏了，但状态栏还在」——
     * 这正是实测反馈的问题。系统栏回归还会挤压 WebView 高度，
     * 导致播放器组件被遮挡。
     */
    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        ScreenOrientationPlugin.onWindowFocusChanged(this, hasFocus);
    }
}
