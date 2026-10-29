package com.sobertv.app;

import android.media.audiofx.BassBoost;
import android.media.audiofx.Equalizer;
import android.media.audiofx.LoudnessEnhancer;
import android.media.audiofx.Virtualizer;
import android.util.Log;

/**
 * 播放音效（系统 audiofx 链路）
 *
 * ── 为什么不用"杜比"命名去接第三方 SDK ──────────────────
 * 手机厂商的杜比/DTS 是私有实现，没有公开 API。这里用 Android 自带的
 * 均衡器 + 响度 + 虚拟环绕组合出接近的听感，所有设备都能用；
 * 设备不支持某个特效时只关掉它，不影响其它效果与正常出声。
 *
 * 所有 effect 都绑定在播放器的 audioSessionId 上，
 * 会话号变化（换集重建播放器）时需要重新 attach。
 */
public class NativeAudioFx {

    private static final String TAG = "[AudioFx]";

    public static final String MODE_OFF = "off";
    /** 杜比全景：响度补偿 + 微笑曲线，人声清晰、低频有力 */
    public static final String MODE_DOLBY = "dolby";
    /** 空间环绕：虚拟器拉宽声场 */
    public static final String MODE_SPATIAL = "spatial";
    /** 人声增强：对白突出，适合外放追剧 */
    public static final String MODE_DIALOG = "dialog";
    /** 低音增强 */
    public static final String MODE_BASS = "bass";

    private int sessionId = -1;
    private Equalizer eq;
    private BassBoost bassBoost;
    private Virtualizer virtualizer;
    private LoudnessEnhancer loudness;
    private String mode = MODE_OFF;

    public String mode() {
        return mode;
    }

    /** 绑定音频会话（同一会话重复调用只重新套用参数） */
    public void attach(int session) {
        if (session == -1 || session == 0) return;
        if (session != sessionId) {
            release();
            sessionId = session;
        }
        apply();
    }

    public void setMode(String m) {
        mode = (m == null || m.isEmpty()) ? MODE_OFF : m;
        apply();
    }

    private void apply() {
        if (sessionId < 0) return;
        // 先全部关掉，再按模式逐个开 —— 避免切换时残留上一种效果
        try { if (eq != null) eq.setEnabled(false); } catch (Exception ignored) { }
        try { if (bassBoost != null) bassBoost.setEnabled(false); } catch (Exception ignored) { }
        try { if (virtualizer != null) virtualizer.setEnabled(false); } catch (Exception ignored) { }
        try { if (loudness != null) loudness.setEnabled(false); } catch (Exception ignored) { }

        if (MODE_OFF.equals(mode)) return;

        try {
            switch (mode) {
                case MODE_DOLBY:
                    ensureEq();
                    setBands(0.4f, 0.15f, -0.05f, 0.1f, 0.3f);
                    ensureLoudness();
                    loudness.setTargetGain(350);
                    break;
                case MODE_SPATIAL:
                    ensureVirtualizer();
                    ensureLoudness();
                    loudness.setTargetGain(180);
                    break;
                case MODE_DIALOG:
                    ensureEq();
                    setBands(-0.1f, 0.15f, 0.4f, 0.45f, 0.2f);
                    ensureLoudness();
                    loudness.setTargetGain(150);
                    break;
                case MODE_BASS:
                    ensureBassBoost();
                    ensureEq();
                    setBands(0.5f, 0.25f, 0f, 0f, 0f);
                    break;
                default:
                    break;
            }
        } catch (Exception e) {
            Log.w(TAG, "应用音效失败: " + e.getMessage());
        }
    }

    private void ensureEq() {
        if (eq != null) {
            eq.setEnabled(true);
            return;
        }
        eq = new Equalizer(0, sessionId);
        eq.setEnabled(true);
    }

    /**
     * 按频段比例设置增益
     *
     * 比例值 → 毫贝：1.0 对应 +900 mB（约 +9dB），
     * 再按设备支持的增益范围夹紧，避免部分机型直接抛异常。
     */
    private void setBands(float... ratios) {
        if (eq == null) return;
        short bands = eq.getNumberOfBands();
        short[] range = eq.getBandLevelRange();
        if (bands <= 0 || range == null || range.length < 2) return;
        short min = range[0];
        short max = range[1];
        for (short b = 0; b < bands; b++) {
            float r = ratios[Math.min(ratios.length - 1, b * ratios.length / bands)];
            int level = Math.round(r * 900f);
            level = Math.max(min, Math.min(max, level));
            try {
                eq.setBandLevel(b, (short) level);
            } catch (Exception ignored) {
                /* 单个频段失败不影响其它频段 */
            }
        }
    }

    private void ensureBassBoost() {
        if (bassBoost != null) {
            bassBoost.setEnabled(true);
            return;
        }
        bassBoost = new BassBoost(0, sessionId);
        if (bassBoost.getStrengthSupported()) bassBoost.setStrength((short) 700);
        bassBoost.setEnabled(true);
    }

    private void ensureVirtualizer() {
        if (virtualizer != null) {
            virtualizer.setEnabled(true);
            return;
        }
        virtualizer = new Virtualizer(0, sessionId);
        if (virtualizer.getStrengthSupported()) virtualizer.setStrength((short) 900);
        virtualizer.setEnabled(true);
    }

    private void ensureLoudness() {
        if (loudness != null) {
            loudness.setEnabled(true);
            return;
        }
        loudness = new LoudnessEnhancer(sessionId);
        loudness.setEnabled(true);
    }

    public void release() {
        try { if (eq != null) eq.release(); } catch (Exception ignored) { }
        try { if (bassBoost != null) bassBoost.release(); } catch (Exception ignored) { }
        try { if (virtualizer != null) virtualizer.release(); } catch (Exception ignored) { }
        try { if (loudness != null) loudness.release(); } catch (Exception ignored) { }
        eq = null;
        bassBoost = null;
        virtualizer = null;
        loudness = null;
        sessionId = -1;
    }
}
