package com.sobertv.app;

import android.content.Context;
import android.graphics.Color;
import android.os.SystemClock;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.animation.LinearInterpolator;
import android.widget.FrameLayout;
import android.widget.TextView;

/**
 * 直播弹幕滚动层
 *
 * ── 为什么不在 WebView 里画 ────────────────────────────
 *   直播走原生 ExoPlayer 时，PlayerActivity 是独立窗口，
 *   Capacitor 的主 WebView 在后台会被 pauseTimers() 冻结，
 *   JS 侧的 WebSocket 回调和定时器都不再执行。
 *   所以弹幕必须由原生自己接收与渲染。
 *
 * ── 实现取舍 ──────────────────────────────────────────
 *   每条弹幕是一个 TextView，用 translationX 线性动画从右侧滑出。
 *   8 条轨道循环使用：同轨上一条必须完全进入屏幕后才放新的，
 *   避免热门直播间弹幕糊成一团。
 */
public class DanmakuLayer extends FrameLayout {

    private static final int MAX_LANES = 8;
    /** 轨道高度（dp），要放得下 15sp 的文字 + 上下间距 */
    private static final int LANE_HEIGHT_DP = 27;
    /** 滚动速度（dp/秒）。太快看不清，太慢屏幕上会堆满 */
    private static final float SPEED_DP_PER_SEC = 92f;
    /** 两条弹幕之间的最小水平间距（dp） */
    private static final int GAP_DP = 36;

    private final int[] laneFreeAt = new int[MAX_LANES];
    private boolean enabled = true;
    private final float density;

    public DanmakuLayer(Context context) {
        super(context);
        density = context.getResources().getDisplayMetrics().density;
        setClickable(false);
        setFocusable(false);
        // 触摸必须透给下层手势层（单击显隐控制条 / 双击暂停）
        setWillNotDraw(true);
    }

    public void setDanmakuEnabled(boolean on) {
        enabled = on;
        setVisibility(on ? VISIBLE : GONE);
        if (!on) clear();
    }

    public boolean isDanmakuEnabled() {
        return enabled;
    }

    public void clear() {
        removeAllViews();
        for (int i = 0; i < laneFreeAt.length; i++) laneFreeAt[i] = 0;
    }

    /** 主线程写入一条弹幕 */
    public void push(final String text, final String name) {
        if (!enabled || TextUtils.isEmpty(text)) return;
        post(() -> spawn(text, name));
    }

    private int laneHeightPx() {
        return (int) (LANE_HEIGHT_DP * density);
    }

    private void spawn(String text, String name) {
        if (getWidth() <= 0 || getHeight() <= 0) return;

        final TextView tv = new TextView(getContext());
        String body = TextUtils.isEmpty(name) ? text : name + "：" + text;
        tv.setText(body);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        tv.setTextColor(Color.WHITE);
        // 画面可能很亮，纯白字会糊掉，用阴影当描边
        tv.setShadowLayer(dp(2), 0, dp(1), 0xCC000000);
        tv.setSingleLine(true);
        tv.setIncludeFontPadding(false);
        tv.setAlpha(0.95f);

        tv.measure(
            MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED),
            MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED)
        );
        final int textW = tv.getMeasuredWidth();
        if (textW <= 0) return;

        final int laneCount = Math.max(2, Math.min(MAX_LANES, getHeight() / laneHeightPx()));
        final long now = SystemClock.uptimeMillis();
        final int lane = pickLane(laneCount, now);
        // 所有轨道都还占着：这条直接丢掉，弹幕允许丢，保住画面流畅
        if (lane < 0) return;

        final float speedPxPerMs = SPEED_DP_PER_SEC * density / 1000f;
        final int gapPx = dp(GAP_DP);
        laneFreeAt[lane] = (int) (now + (textW + gapPx) / speedPxPerMs + 120);

        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        lp.gravity = Gravity.TOP | Gravity.START;
        lp.topMargin = lane * laneHeightPx();

        tv.setTranslationX(getWidth());
        addView(tv, lp);

        // 早于宽度测量完成就启动动画会从错误位置开始，等一帧
        tv.post(() -> {
            if (tv.getParent() == null) return;
            long dur = (long) ((getWidth() + textW) / speedPxPerMs);
            dur = Math.max(4000L, Math.min(13000L, dur));
            tv.animate()
                .translationX(-textW)
                .setDuration(dur)
                .setInterpolator(new LinearInterpolator())
                .withEndAction(() -> removeView(tv))
                .start();
        });
    }

    private int pickLane(int laneCount, long now) {
        for (int i = 0; i < laneCount; i++) {
            if (laneFreeAt[i] <= now) return i;
        }
        return -1;
    }

    private int dp(int v) {
        return (int) (v * density + 0.5f);
    }
}
