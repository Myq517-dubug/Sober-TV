package com.sobertv.app;

import com.getcapacitor.Plugin;

/**
 * 自定义插件基类
 *
 * ── 为什么要它 ──────────────────────────────────────
 * Capacitor 的 `Plugin` 基类**没有** `runOnUiThread`，
 * 正确做法是 `getBridge().executeOnMainThread(Runnable)`（见 Bridge.java）。
 *
 * 多个插件都要用这个能力，抽到基类里避免每个插件重复实现一遍
 * （之前 NativePlayerPlugin 里就有私有副本，两个新插件又各写一遍 ——
 * 三处重复，是重构的信号）。
 */
public abstract class BasePlugin extends Plugin {

    /** 切到主线程执行 UI 操作 */
    protected void runOnUi(Runnable r) {
        getBridge().executeOnMainThread(r);
    }
}
