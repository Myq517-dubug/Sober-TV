package com.sobertv.app;

import android.app.Activity;
import android.app.PictureInPictureParams;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.ClipDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.LayerDrawable;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.text.TextUtils;
import android.util.Rational;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.LayoutInflater;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.GridLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.TextView;

import androidx.annotation.Nullable;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.Player;
import androidx.media3.common.VideoSize;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.PlayerView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 原生播放界面（独立 Activity）
 *
 * ── 为什么从 Dialog 改成 Activity ────────────────────────
 *   实测轨迹（同一台设备）：
 *     v1.7.3 手写 TextureView   → 有声音，画面全黑
 *     v1.7.4 PlayerView(TextureView) → 首帧OK，画面全黑
 *     v1.7.5 PlayerView(SurfaceView)  → SV✓、首帧OK，画面全黑
 *     v1.7.6 SurfaceView + setZOrderOnTop + 双窗口 → 仍然全黑
 *
 *   四次都黑，唯一的共同点是「画面放在 Dialog 里」。
 *   Dialog 是 sub-window，在部分 ROM 上既不为下层 surface 开透明区
 *   （punch hole 不生效），也不可靠地支持 surface 的 Z 序提升，
 *   于是窗口自己的黑底把画面整个盖住 —— 表现就是「解码正常、首帧已渲染、
 *   状态栏能显示，但屏幕纯黑」。
 *
 *   Activity 是应用主窗口，SurfaceView 走的是最标准、验证最充分的合成路径，
 *   不涉及 sub-window 的任何特殊行为。控制条与画面同窗口，
 *   绘制在窗口 buffer 上，必然可见。
 *
 * ── 交互 ────────────────────────────────────────────────
 *   单点      显示/隐藏控制条（显示后 3.2 秒自动收起）
 *   双击左/右 快退/快进 10 秒，双击中间 播放/暂停
 *   左右滑动  按滑动距离快进/快退
 *   上下滑动  左半屏调亮度，右半屏调音量
 *   长按      临时 3 倍速，松手恢复
 */
@UnstableApi
public class PlayerActivity extends Activity {

    public static final String EXTRA_URL = "url";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_HEADERS = "headers";
    public static final String EXTRA_FILL = "fill";
    public static final String EXTRA_POSITION = "position";
    public static final String EXTRA_EPISODES = "episodes";
    /** 整季地址表（JSON: [{"n":1,"url":"..."}]），换集时直接取用 */
    public static final String EXTRA_EPISODE_URLS = "episodeUrls";
    /** 起播后跳过片头秒数 */
    public static final String EXTRA_SKIP_INTRO = "skipIntroSec";
    /** 剩余不足该秒数时直接进下一集 */
    public static final String EXTRA_SKIP_OUTRO = "skipOutroSec";
    /** 播完是否自动续下一集 */
    public static final String EXTRA_AUTO_NEXT = "autoNext";
    public static final String EXTRA_EPISODE = "episode";
    /** 起播前展示的模糊海报 */
    public static final String EXTRA_POSTER = "poster";
    /** 外挂字幕文件路径（插件先把文本写到 cache 再传路径，避免 Intent 超限） */
    public static final String EXTRA_SUBTITLE_PATH = "subtitlePath";
    /** 字幕 MIME（application/x-subrip / text/vtt） */
    public static final String EXTRA_SUBTITLE_MIME = "subtitleMime";
    /**
     * 直播模式
     *
     * 直播没有「总时长」概念，进度条/±10秒/倍速/上下集/片头片尾跳过
     * 全部无意义，需要整体换成「LIVE」形态。
     */
    public static final String EXTRA_LIVE = "live";
    /** 弹幕平台（bili / douyu），为空表示不开弹幕 */
    public static final String EXTRA_DANMAKU_PLATFORM = "danmakuPlatform";
    /** 平台房间号（B 站可能是短号，原生侧会自己换长号） */
    public static final String EXTRA_DANMAKU_ROOM = "danmakuRoom";
    /** 弹幕是否默认打开 */
    public static final String EXTRA_DANMAKU = "danmakuOn";

    /** 薄荷绿（与 App 主题一致） */
    private static final int MINT = 0xFF4ADE80;
    /** 控制条无操作后自动收起的时间 */
    private static final long HIDE_DELAY_MS = 3200L;
    /** 双击判定窗口 */
    private static final long DOUBLE_TAP_MS = 320L;

    private static final float[] SPEEDS = {0.5f, 0.75f, 1f, 1.25f, 1.5f, 2f};

    // ── 会话状态（hide() 关闭界面后，show() 能接着播） ──────
    private static String sessionUrl = "";
    private static String sessionTitle = "";
    private static String sessionHeaders = "";
    private static String sessionEpisodes = "";
    private static String sessionEpisodeUrls = "";
    private static int sessionEpisode = 1;
    private static long sessionPosition = 0;
    private static boolean sessionFill = true;
    /** 会话是否为直播：hide() 后 show() 重建 Activity 必须带回，否则控制条退回点播形态 */
    private static boolean sessionLive = false;
    private static String sessionSubtitlePath = "";
    private static String sessionSubtitleMime = "";
    /** 直播弹幕会话信息：hide() 后 show() 重建窗口要带回，否则弹幕就断了 */
    private static String sessionDanmakuPlatform = "";
    private static String sessionDanmakuRoom = "";
    private static boolean sessionDanmakuOn = true;

    /** 插件侧跨 Activity 调用的入口 */
    private static PlayerActivity instance;

    @Nullable
    public static PlayerActivity get() {
        return instance;
    }

    public static void rememberFill(boolean fill) {
        // 直播的填充偏好单独存在 SharedPreferences 里，别污染点播的会话值
        if (sessionLive) return;
        sessionFill = fill;
    }

    /** 界面已在前台时，插件直接换源，不再走 startActivity */
    public void openIntent(Intent intent) {
        handleIntent(intent);
    }

    public static String sessionUrl() {
        return sessionUrl == null ? "" : sessionUrl;
    }

    public static String sessionTitle() {
        return sessionTitle == null ? "" : sessionTitle;
    }

    public static boolean sessionLive() {
        return sessionLive;
    }

    public static String sessionHeaders() {
        return sessionHeaders == null ? "" : sessionHeaders;
    }

    public static String sessionEpisodes() {
        return sessionEpisodes == null ? "" : sessionEpisodes;
    }

    public static String sessionEpisodeUrls() {
        return sessionEpisodeUrls == null ? "" : sessionEpisodeUrls;
    }

    public static int sessionEpisode() {
        return sessionEpisode;
    }

    public static long sessionPosition() {
        return sessionPosition;
    }

    public static String sessionSubtitlePath() {
        return sessionSubtitlePath == null ? "" : sessionSubtitlePath;
    }

    public static String sessionSubtitleMime() {
        return sessionSubtitleMime == null ? "" : sessionSubtitleMime;
    }

    public static String sessionDanmakuPlatform() {
        return sessionDanmakuPlatform == null ? "" : sessionDanmakuPlatform;
    }

    public static String sessionDanmakuRoom() {
        return sessionDanmakuRoom == null ? "" : sessionDanmakuRoom;
    }

    public static boolean sessionDanmakuOn() {
        return sessionDanmakuOn;
    }

    /** 选集条目 */
    private static class Ep {
        final int n;
        final String label;

        Ep(int n, String label) {
            this.n = n;
            this.label = label;
        }
    }

    private PlayerView playerView;
    private ExoPlayer player;
    private FrameLayout root;
    private TextView titleView;
    private TextView statusView;
    private TextView hintView;
    private ViewGroup topBar;
    private ViewGroup bottomBar;
    private SeekBar seekBar;
    private TextView timeView;
    private TextView playPauseView;
    private TextView speedView;
    /** 直播模式下的「LIVE」角标 */
    private TextView liveBadge;
    /** 直播时隐藏的 ±10 秒按钮 */
    private TextView back10View;
    private TextView fwd10View;
    /** 直播时隐藏的换线 / 线路按钮 */
    private TextView switchLineView;
    private TextView linesView;
    private TextView episodeView;
    /** 上一集 / 下一集快捷按钮 */
    private TextView epPrevView;
    private TextView epNextView;
    private TextView lockButton;
    private TextView castButton;
    private TextView pipButton;
    private View gestureLayer;
    private FrameLayout episodePanel;
    /** 起播前的模糊海报底图（首帧渲染后淡出） */
    private ImageView posterView;
    private String posterUrl = "";
    /** 缓冲 loading（居中转圈 + 文案） */
    private View loadingOverlay;
    /** 锁屏后唯一可点的解锁小浮标 */
    private TextView lockView;
    /** 锁定后所有触摸都失效，避免躺着看的时候误触 */
    private boolean locked = false;
    /** 选集面板的滚动容器与当前集格子（打开时自动滚到当前集） */
    private ScrollView episodeScroll;
    private TextView episodeCurrentCell;
    private boolean controlsVisible = true;
    private boolean fillMode = true;
    /** 直播弹幕（原生窗口自己连 WebSocket，不依赖被冻结的 WebView） */
    private DanmakuLayer danmakuLayer;
    private LiveDanmakuClient danmakuClient;
    private String danmakuPlatform = "";
    private String danmakuRoom = "";
    private boolean danmakuOn = true;
    private TextView danmakuToggle;
    private TextView fillToggle;
    private TextView orientationToggle;

    // ── 选集 ────────────────────────────────────────────
    private final List<Ep> episodes = new ArrayList<>();
    /** 集号 → 播放地址（整季地址表，换集时直接查，不必回前端解析） */
    private final java.util.LinkedHashMap<Integer, String> episodeUrlMap =
        new java.util.LinkedHashMap<>();
    private int currentEpisode = 1;
    /** 片头跳过毫秒数（0 = 关闭） */
    private long skipIntroMs = 0L;
    /** 片尾跳过毫秒数（0 = 关闭） */
    private long skipOutroMs = 0L;
    /** 播完自动续下一集 */
    private boolean autoNextEnabled = true;
    /** 直播模式（无时长、无进度、无选集） */
    private boolean liveMode = false;
    /** 本集是否已跳片头 / 已触发片尾 */
    private boolean introSkipped = false;
    private boolean outroTriggered = false;
    private boolean panelOpen = false;

    /** 投屏设备面板（复用选集面板的盖层样式） */
    private FrameLayout castPanel;
    private boolean castPanelOpen = false;

    /** 画质切换（多码率 HLS 才有） */
    private TextView qualityButton;
    private FrameLayout qualityPanel;
    private boolean qualityPanelOpen = false;
    /** 当前画质上限，0 = 自动 */
    private int qualityHeight = 0;
    /** 画质偏好跨影片保留：用户选了 720P，下一部片也按 720P 起播 */
    private static final String PREFS_QUALITY = "sober_native_player";
    private static final String KEY_QUALITY_HEIGHT = "quality_height";
    /** 直播的画面填充偏好与弹幕开关（与点播的 sessionFill 分开记，互不影响） */
    private static final String KEY_LIVE_FILL = "live_fill";
    private static final String KEY_LIVE_DANMAKU = "live_danmaku";
    private static final String KEY_BRIGHTNESS = "brightness";
    private static final String KEY_AUDIO_EFFECT = "audio_effect";

    /** 播放音效（杜比 / 空间环绕 / 人声 / 低音） */
    private final NativeAudioFx audioFx = new NativeAudioFx();

    /** 外挂字幕：本地文件 URI 与 MIME（空 = 无字幕） */
    private String subtitleUri = "";
    private String subtitleMime = "";
    /** 字幕开关（关掉只是禁用文本轨，不需要重建播放器） */
    private boolean subtitleEnabled = true;

    // ── 多集连续缓存 ────────────────────────────────────
    /** 下一集预加载实例：静音、不挂画面，只负责把数据缓冲下来 */
    private ExoPlayer preloadPlayer;
    private String preloadUrl = "";
    private String preloadHeaders = "";
    private String preloadTitle = "";
    private int preloadEpisode = -1;

    /** 起播后延迟预缓冲下一集（地址表里存在下一集时才排队） */
    private final Runnable autoPreloadRunnable = new Runnable() {
        @Override
        public void run() {
            if (isFinishing() || isDestroyed()) return;
            if (preloadPlayer != null) return;
            int next = nextEpisode();
            if (next <= 0) return;
            String url = episodeUrl(next);
            if (url == null) return;
            preloadNext(url, sessionHeaders, sessionTitle, next);
        }
    };

    /** 是否处于画中画小窗 */
    private boolean inPip = false;

    // ── 倍速 ────────────────────────────────────────────
    private float speed = 1f;

    /** 用户正在拖动进度条时，不要用播放位置覆盖它 */
    private boolean dragging = false;
    private final Handler uiHandler = new Handler(Looper.getMainLooper());
    private long lastProgressEmit = 0L;
    private final Runnable progressTick = new Runnable() {
        @Override
        public void run() {
            updateProgress();
            uiHandler.postDelayed(this, 500);
        }
    };

    /** 首帧是否已真正渲染 */
    private boolean firstFrameRendered = false;
    /** 本次起播时间（用于判断「续播提示」是否该出现） */
    private long startedAt = 0L;
    private boolean resumeHintShown = false;

    // ── 手势状态 ────────────────────────────────────────
    private static final int G_NONE = 0;
    private static final int G_SEEK = 1;
    private static final int G_VOLUME = 2;
    private static final int G_BRIGHTNESS = 3;

    /**
     * 手势判定阈值
     *
     * ⚠️ 不能在字段初始化时调用 ViewConfiguration.get(this)：
     *   字段初始化发生在 Activity 构造阶段，此时 attachBaseContext 还没执行，
     *   getResources() 拿不到 base context → 直接 NPE，Activity 一启动就闪退。
     */
    private int touchSlop = 8;
    private float downX;
    private float downY;
    private boolean moving = false;
    private int gestureType = G_NONE;
    private long seekStartMs = 0L;
    private long seekTargetMs = 0L;
    private long lastTapTime = 0L;
    private float lastTapX = 0f;
    private boolean longPressActive = false;
    private int volumeMax = 15;
    private int volumeStart = 0;
    private float brightnessStart = 0.5f;

    // ── 底部状态栏的诊断信息 ────────────────────────────
    private int playerState = Player.STATE_IDLE;
    private int videoTrackCount = 0;
    private int audioTrackCount = 0;
    private String videoMime = "";
    private int videoSizeW = 0;
    private int videoSizeH = 0;

    private final Runnable hideRunnable = new Runnable() {
        @Override
        public void run() {
            if (dragging || panelOpen || castPanelOpen || qualityPanelOpen) return;
            setControlsVisible(false);
        }
    };

    private final Runnable singleTapRunnable = new Runnable() {
        @Override
        public void run() {
            boolean next = !controlsVisible;
            setControlsVisible(next);
            if (next) scheduleHide();
        }
    };

    private final Runnable hintHideRunnable = new Runnable() {
        @Override
        public void run() {
            if (hintView != null) hintView.setVisibility(View.GONE);
        }
    };

    private final Runnable longPressRunnable = new Runnable() {
        @Override
        public void run() {
            if (moving || dragging || player == null || !player.isPlaying()) return;
            longPressActive = true;
            player.setPlaybackParameters(new PlaybackParameters(3f));
            showHint("3× 倍速中", 0);
        }
    };

    /** 缓冲延迟显示：网络轻微抖动时不要让 loading 一闪而过 */
    private final Runnable showLoadingRunnable = new Runnable() {
        @Override
        public void run() {
            if (loadingOverlay == null) return;
            loadingOverlay.setVisibility(View.VISIBLE);
            loadingOverlay.setAlpha(0f);
            loadingOverlay.animate().alpha(1f).setDuration(180).start();
        }
    };

    // ── 生命周期 ────────────────────────────────────────

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        instance = this;
        touchSlop = ViewConfiguration.get(this).getScaledTouchSlop();
        qualityHeight = getSharedPreferences(PREFS_QUALITY, MODE_PRIVATE)
            .getInt(KEY_QUALITY_HEIGHT, 0);
        /**
         * 方向策略：
         *   点播 —— 固定横屏，影视内容本来就是宽画幅；
         *   直播 —— 跟随系统旋转，竖屏也能看（用户反馈「直播永远横屏」）。
         *
         * 这里先按 Intent 里的标记定一次，handleIntent 里还会再同步一次，
         * 因为 Activity 可能被 onNewIntent 复用成另一种播放模式。
         */
        boolean liveIntent = getIntent().getBooleanExtra(EXTRA_LIVE, false);
        setRequestedOrientation(
            liveIntent
                ? ActivityInfo.SCREEN_ORIENTATION_FULL_USER
                : ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        );
        // 直播默认完整显示画面（contain），避免 16:9 源在宽屏上被裁掉两边
        fillMode = liveIntent ? liveFillPref() : sessionFill;
        buildUi();
        applyImmersive();
        applySavedBrightness();
        // 音效偏好跨影片保留（设置页 / 播放面板改过就记住）
        audioFx.setMode(
            getSharedPreferences(PREFS_QUALITY, MODE_PRIVATE)
                .getString(KEY_AUDIO_EFFECT, NativeAudioFx.MODE_OFF)
        );
        handleIntent(getIntent());
        uiHandler.post(progressTick);
        scheduleHide();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    /** 恢复上次手势调过的亮度，避免每次起播都回到系统默认 */
    private void applySavedBrightness() {
        float saved = getSharedPreferences(PREFS_QUALITY, MODE_PRIVATE)
            .getFloat(KEY_BRIGHTNESS, -1f);
        if (saved <= 0) return;
        WindowManager.LayoutParams lp = getWindow().getAttributes();
        lp.screenBrightness = Math.max(0.05f, Math.min(1f, saved));
        getWindow().setAttributes(lp);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applyImmersive();
    }

    /**
     * 画中画模式切换
     *
     * 小窗里只保留画面本身：控制条、标题栏、解锁浮标全部收起；
     * 退出小窗后恢复原来的控制条，用户不会因为切了一次小窗就丢了操作入口。
     */
    @Override
    public void onPictureInPictureModeChanged(
            boolean isInPictureInPictureMode, Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig);
        inPip = isInPictureInPictureMode;
        if (inPip) {
            uiHandler.removeCallbacks(hideRunnable);
            setControlsVisible(false);
            if (hintView != null) hintView.setVisibility(View.GONE);
            if (lockView != null) lockView.setVisibility(View.GONE);
        } else {
            setControlsVisible(true);
            scheduleHide();
            if (locked && lockView != null) lockView.setVisibility(View.VISIBLE);
        }
    }

    @Override
    protected void onDestroy() {
        uiHandler.removeCallbacksAndMessages(null);
        stopDanmaku();
        saveSession();
        releasePlayer();
        instance = null;
        NativePlayerPlugin.emitFromNative("nativeClosed", new JSObject());
        super.onDestroy();
    }

    @Override
    public boolean dispatchTouchEvent(MotionEvent ev) {
        // 任何触摸都重置自动收起计时，避免操作到一半控件消失
        if (ev.getActionMasked() == MotionEvent.ACTION_DOWN && controlsVisible) {
            scheduleHide();
        }
        return super.dispatchTouchEvent(ev);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            Logger.info("[PlayerActivity] 返回键 → 关闭播放");
            NativePlayerPlugin.emitFromNative("nativeClose", new JSObject());
            finish();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    // ── 供插件调用的控制方法 ────────────────────────────

    public void doPause() {
        if (player != null) player.setPlayWhenReady(false);
    }

    public void doResume() {
        if (player != null) player.setPlayWhenReady(true);
    }

    public void doSeek(long ms) {
        if (player == null) return;
        player.seekTo(ms);
        // 起播后 15 秒内的第一次跳转来自「续播记忆」，给用户一个明确提示
        if (!resumeHintShown && startedAt > 0
            && SystemClock.elapsedRealtime() - startedAt < 15000
            && ms > 3000) {
            resumeHintShown = true;
            showHint("继续观看 · " + fmt(ms), 2400);
        }
    }

    public void doSetSpeed(float s) {
        speed = Math.max(0.25f, Math.min(3f, s));
        if (player != null) {
            player.setPlaybackParameters(new PlaybackParameters(speed));
        }
        updateSpeedLabel();
    }

    public void applyFillMode(boolean fill) {
        fillMode = fill;
        if (liveMode) {
            getSharedPreferences(PREFS_QUALITY, MODE_PRIVATE)
                .edit().putBoolean(KEY_LIVE_FILL, fill).apply();
        } else {
            sessionFill = fill;
        }
        if (fillToggle != null) fillToggle.setText(fill ? "铺满" : "完整");
        if (playerView != null) {
            playerView.setResizeMode(
                fill ? AspectRatioFrameLayout.RESIZE_MODE_ZOOM : AspectRatioFrameLayout.RESIZE_MODE_FIT
            );
        }
    }

    private boolean liveFillPref() {
        return getSharedPreferences(PREFS_QUALITY, MODE_PRIVATE)
            .getBoolean(KEY_LIVE_FILL, false);
    }

    public long positionMs() {
        return player == null ? 0L : player.getCurrentPosition();
    }

    // ── 字幕与音效（前端设置页 / 播放面板调用） ─────────

    /**
     * 应用外挂字幕
     *
     * Media3 不支持运行时往已有 MediaItem 上追加字幕轨，
     * 只能带字幕重建 MediaItem 并从当前位置续播（一次短暂缓冲）。
     */
    public void applySubtitle(String path, String mime) {
        subtitleUri = path == null ? "" : path;
        subtitleMime = mime == null ? "" : mime;
        reloadCurrentItem();
    }

    public void clearSubtitle() {
        subtitleUri = "";
        subtitleMime = "";
        reloadCurrentItem();
    }

    private void reloadCurrentItem() {
        if (player == null || sessionUrl == null || sessionUrl.isEmpty()) return;
        long pos = player.getCurrentPosition();
        boolean playing = player.getPlayWhenReady();
        try {
            player.setMediaItem(buildMediaItem(sessionUrl), Math.max(0L, pos));
            player.prepare();
            player.setPlayWhenReady(playing);
        } catch (Exception e) {
            Logger.error("[PlayerActivity] 应用字幕失败: " + e.getMessage());
        }
    }

    public void setSubtitleEnabled(boolean on) {
        subtitleEnabled = on;
        if (player == null) return;
        try {
            player.setTrackSelectionParameters(
                player.getTrackSelectionParameters()
                    .buildUpon()
                    .setDisabledTrackTypes(on
                        ? Collections.emptySet()
                        : Collections.singleton(C.TRACK_TYPE_TEXT))
                    .build()
            );
        } catch (Exception e) {
            Logger.error("[PlayerActivity] 切换字幕失败: " + e.getMessage());
        }
    }

    public void setAudioEffect(String mode) {
        String m = (mode == null || mode.isEmpty()) ? NativeAudioFx.MODE_OFF : mode;
        audioFx.setMode(m);
        getSharedPreferences(PREFS_QUALITY, MODE_PRIVATE)
            .edit()
            .putString(KEY_AUDIO_EFFECT, m)
            .apply();
        if (player != null) audioFx.attach(player.getAudioSessionId());
    }

    public String audioEffectMode() {
        return audioFx.mode();
    }

    public boolean subtitleVisible() {
        return subtitleEnabled && !subtitleUri.isEmpty();
    }

    public long durationMs() {
        return player == null ? 0L : player.getDuration();
    }

    public void saveSession() {
        if (player != null) sessionPosition = player.getCurrentPosition();
        sessionFill = fillMode;
        sessionEpisode = currentEpisode;
        sessionSubtitlePath = subtitleUri;
        sessionSubtitleMime = subtitleMime;
    }

    /** 画中画小窗（Android 8.0+，且系统保留该特性） */
    public void enterPip() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            showHint("系统版本不支持画中画", 1600);
            return;
        }
        if (!getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) {
            showHint("当前设备不支持画中画", 1600);
            return;
        }
        try {
            // 比例取视频真实宽高；没有出画信息时按 16:9。
            // Android 只接受 1:2.39 ~ 2.39:1，超出会被系统拒绝，这里先夹紧。
            double ratio = videoSizeW > 0 && videoSizeH > 0
                ? (double) videoSizeW / videoSizeH
                : 16.0 / 9.0;
            ratio = Math.max(1.0 / 2.39, Math.min(2.39, ratio));
            PictureInPictureParams params = new PictureInPictureParams.Builder()
                .setAspectRatio(new Rational((int) Math.round(ratio * 1000), 1000))
                .build();
            enterPictureInPictureMode(params);
        } catch (Exception e) {
            Logger.error("[PlayerActivity] 画中画启动失败: " + e.getMessage());
            showHint("画中画启动失败", 1600);
        }
    }

    /**
     * 预加载下一集
     *
     * 只建一个静音、不挂画面的 ExoPlayer 提前拉流缓冲。
     * 当前集播完后直接把这个实例挂到画面上接管播放，省掉重新建连/解析清单的时间。
     */
    public void preloadNext(String url, String headersJson, String title, int episode) {
        if (url == null || url.isEmpty()) return;
        if (url.equals(sessionUrl)) return;
        if (preloadPlayer != null && url.equals(preloadUrl)) return;

        releasePreload();
        try {
            Map<String, String> headers = parseHeaders(headersJson);
            ExoPlayer p = buildPlayer(headers);
            p.setMediaItem(buildMediaItem(url));
            p.setVolume(0f);
            p.setPlayWhenReady(false);
            p.prepare();
            preloadPlayer = p;
            preloadUrl = url;
            preloadHeaders = headersJson == null ? "" : headersJson;
            preloadTitle = title == null ? "" : title;
            preloadEpisode = episode;
            Logger.info("[PlayerActivity] 预加载第 " + episode + " 集: " + url);
        } catch (Exception e) {
            Logger.error("[PlayerActivity] 预加载失败: " + e.getMessage());
        }
    }

    /** 投屏到指定设备（返回 null 表示已发起，失败时返回原因） */
    public String castToDevice(CastPlugin.CastDeviceInfo dev) {
        CastPlugin cp = CastPlugin.get();
        if (cp == null || dev == null) return "投屏不可用";
        String err = cp.castToDevice(
            dev.id,
            sessionUrl,
            sessionTitle,
            player == null ? 0L : player.getCurrentPosition()
        );
        if (err == null && player != null) {
            // 手机上暂停，避免电视和手机同时出声
            player.setPlayWhenReady(false);
        }
        return err;
    }

    /** 当前是否正在投屏 */
    public boolean isCasting() {
        CastPlugin cp = CastPlugin.get();
        return cp != null && cp.isCasting();
    }

    /** 停止投屏 */
    public void stopCasting() {
        CastPlugin cp = CastPlugin.get();
        if (cp != null) cp.stopCast();
    }

    /**
     * 关闭自己并立刻释放静态引用
     *
     * finish() 是异步的，若等 onDestroy 才置空，前端紧接着调 show()
     * 会拿到的仍是这个正在关闭的实例 → 界面不会重新出现。
     */
    public void closeSelf() {
        saveSession();
        releasePlayer();
        if (instance == this) instance = null;
        finish();
    }

    /** 诊断信息（字段与原对话框版本保持一致，前端诊断页无需改动） */
    public JSObject diag() {
        JSObject ret = new JSObject();
        ret.put("available", true);
        ret.put("pluginId", "NativePlayer");
        ret.put("hasPlayer", player != null);
        ret.put("hasDialog", false);
        ret.put("dialogShowing", false);
        ret.put("host", "activity");
        ret.put("firstFrameRendered", firstFrameRendered);
        ret.put("version", NativePlayerPlugin.appVersionLabel(this));
        ret.put("videoTrackCount", videoTrackCount);
        ret.put("audioTrackCount", audioTrackCount);
        ret.put("videoMime", videoMime);
        View surface = playerView != null ? playerView.getVideoSurfaceView() : null;
        if (surface != null) {
            ret.put("width", surface.getWidth());
            ret.put("height", surface.getHeight());
            ret.put("visible", surface.getVisibility() == View.VISIBLE);
            ret.put("surfaceType", surface.getClass().getSimpleName());
            ret.put("surfaceReady", surface.isShown());
            ret.put("surfaceOnTop", false);
        }
        if (player != null) {
            ret.put("playbackState", player.getPlaybackState());
            ret.put("isPlaying", player.isPlaying());
            ret.put("playWhenReady", player.getPlayWhenReady());
            VideoSize vs = player.getVideoSize();
            ret.put("videoWidth", vs.width);
            ret.put("videoHeight", vs.height);
        }
        ret.put("episode", currentEpisode);
        ret.put("episodeCount", episodes.size());
        return ret;
    }

    // ── 界面构建 ────────────────────────────────────────

    private void buildUi() {
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        playerView = (PlayerView) LayoutInflater.from(this)
            .inflate(R.layout.native_player_view, root, false);
        playerView.setUseController(false);
        playerView.setShutterBackgroundColor(Color.BLACK);
        // 字幕样式：白字 + 黑描边，底部留一点空间，避开控制条
        if (playerView.getSubtitleView() != null) {
            playerView.getSubtitleView().setStyle(
                new androidx.media3.ui.CaptionStyleCompat(
                    Color.WHITE,
                    Color.TRANSPARENT,
                    Color.TRANSPARENT,
                    androidx.media3.ui.CaptionStyleCompat.EDGE_TYPE_OUTLINE,
                    Color.BLACK,
                    null
                )
            );
            playerView.getSubtitleView().setFixedTextSize(TypedValue.COMPLEX_UNIT_DIP, 18f);
            playerView.getSubtitleView().setBottomPaddingFraction(0.08f);
            playerView.getSubtitleView().setVisibility(View.VISIBLE);
        }
        playerView.setResizeMode(
            fillMode ? AspectRatioFrameLayout.RESIZE_MODE_ZOOM : AspectRatioFrameLayout.RESIZE_MODE_FIT
        );
        root.addView(
            playerView,
            new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        );

        // 起播前海报模糊底图：盖在画面上，首帧渲染后淡出
        posterView = new ImageView(this);
        posterView.setScaleType(ImageView.ScaleType.CENTER_CROP);
        posterView.setVisibility(View.GONE);
        posterView.setClickable(false);
        posterView.setFocusable(false);
        root.addView(
            posterView,
            new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        );

        // 手势层：盖在画面上、控制条之下，统一接管点击/双击/滑动/长按
        gestureLayer = new View(this);
        gestureLayer.setBackgroundColor(Color.TRANSPARENT);
        gestureLayer.setOnTouchListener(this::onGestureTouch);
        root.addView(
            gestureLayer,
            new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        );

        topBar = buildTopBar();
        root.addView(topBar);

        bottomBar = buildBottomBar();
        root.addView(bottomBar);

        loadingOverlay = buildLoadingOverlay();
        FrameLayout.LayoutParams loadLp = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        loadLp.gravity = Gravity.CENTER;
        root.addView(loadingOverlay, loadLp);

        hintView = makeText("", 14, Color.WHITE);
        hintView.setGravity(Gravity.CENTER);
        hintView.setBackground(rounded(0xCC141818, dp(999)));
        hintView.setPadding(dp(18), dp(10), dp(18), dp(10));
        hintView.setVisibility(View.GONE);
        FrameLayout.LayoutParams hintLp = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        hintLp.gravity = Gravity.CENTER;
        root.addView(hintView, hintLp);

        // 锁定后控制条全部收起，只留这一颗解锁浮标
        lockView = makeText("解锁", 12, 0xE6FFFFFF);
        lockView.setGravity(Gravity.CENTER);
        lockView.setBackground(rounded(0x99101414, dp(999)));
        lockView.setPadding(dp(16), dp(10), dp(16), dp(10));
        lockView.setVisibility(View.GONE);
        lockView.setOnClickListener(v -> setLocked(false));
        FrameLayout.LayoutParams lockLp = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        lockLp.gravity = Gravity.END | Gravity.CENTER_VERTICAL;
        lockLp.rightMargin = dp(14);
        root.addView(lockView, lockLp);

        setContentView(root);
    }

    private View buildLoadingOverlay() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);

        ProgressBar pb = new ProgressBar(this);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            pb.setIndeterminateTintList(ColorStateList.valueOf(MINT));
        }
        LinearLayout.LayoutParams pbLp = new LinearLayout.LayoutParams(dp(36), dp(36));
        pbLp.bottomMargin = dp(10);
        box.addView(pb, pbLp);

        box.addView(makeText("正在缓冲…", 12, 0xCCFFFFFF));

        box.setAlpha(0f);
        box.setVisibility(View.GONE);
        return box;
    }

    /** 显示/隐藏缓冲 loading（带淡入淡出，避免闪烁） */
    private void setLoading(boolean on) {
        uiHandler.removeCallbacks(showLoadingRunnable);
        if (loadingOverlay == null) return;
        if (on) {
            // 已出画的缓冲延迟 500ms 再显示；起播阶段立即显示
            uiHandler.postDelayed(showLoadingRunnable, firstFrameRendered ? 500 : 0);
        } else {
            loadingOverlay.animate().cancel();
            loadingOverlay.animate().alpha(0f).setDuration(150).withEndAction(() -> {
                if (loadingOverlay != null) loadingOverlay.setVisibility(View.GONE);
            }).start();
        }
    }

    private void applyImmersive() {
        Window w = getWindow();
        w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        w.addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams lp = w.getAttributes();
            lp.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            w.setAttributes(lp);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            w.setStatusBarColor(Color.BLACK);
            w.setNavigationBarColor(Color.BLACK);
        }
        w.getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        );
    }

    private ViewGroup buildTopBar() {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(16), dp(26), dp(16), dp(14));
        // 顶部渐变遮罩：让标题在亮画面上也清晰，比一块纯色底自然
        bar.setBackground(
            new GradientDrawable(
                GradientDrawable.Orientation.TOP_BOTTOM,
                new int[]{0xCC000000, 0x55000000, 0x00000000}
            )
        );

        TextView back = makeText("‹", 30, Color.WHITE);
        back.setGravity(Gravity.CENTER);
        back.setBackground(rounded(0x66101414, 999));
        back.setOnClickListener(v -> {
            Logger.info("[PlayerActivity] 用户点击返回");
            NativePlayerPlugin.emitFromNative("nativeClose", new JSObject());
            finish();
        });
        LinearLayout.LayoutParams backLp = new LinearLayout.LayoutParams(dp(42), dp(42));
        backLp.rightMargin = dp(12);
        bar.addView(back, backLp);

        titleView = makeText("", 14, Color.WHITE);
        titleView.setMaxLines(1);
        titleView.setEllipsize(TextUtils.TruncateAt.END);
        bar.addView(
            titleView,
            new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        );

        // ── 画质 / 画中画 / 投屏（顶部右侧，和锁定并排）──
        qualityButton = topChip("画质");
        qualityButton.setVisibility(View.GONE);
        qualityButton.setOnClickListener(v -> toggleQualityPanel());
        LinearLayout.LayoutParams qLp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        qLp.rightMargin = dp(8);
        bar.addView(qualityButton, qLp);

        pipButton = topChip("画中画");
        pipButton.setVisibility(pipSupported() ? View.VISIBLE : View.GONE);
        pipButton.setOnClickListener(v -> enterPip());
        LinearLayout.LayoutParams pipLp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        pipLp.rightMargin = dp(8);
        bar.addView(pipButton, pipLp);

        castButton = topChip("投屏");
        castButton.setOnClickListener(v -> toggleCastPanel());
        LinearLayout.LayoutParams castLp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        castLp.rightMargin = dp(8);
        bar.addView(castButton, castLp);

        lockButton = makeText("锁定", 12, 0xE6FFFFFF);
        lockButton.setGravity(Gravity.CENTER);
        lockButton.setBackground(rounded(0x66101414, 999));
        lockButton.setPadding(dp(16), dp(9), dp(16), dp(9));
        lockButton.setOnClickListener(v -> setLocked(true));
        bar.addView(
            lockButton,
            new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        );

        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        lp.gravity = Gravity.TOP;
        bar.setLayoutParams(lp);
        return bar;
    }

    /** 顶部小胶囊按钮 */
    private TextView topChip(String text) {
        TextView t = makeText(text, 12, 0xE6FFFFFF);
        t.setGravity(Gravity.CENTER);
        t.setBackground(rounded(0x66101414, 999));
        t.setPadding(dp(14), dp(9), dp(14), dp(9));
        return t;
    }

    private boolean pipSupported() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            && getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE);
    }

    /** 锁定 / 解锁：锁定后手势层与控制条全部失效，只留解锁浮标 */
    private void setLocked(boolean on) {
        locked = on;
        if (lockView != null) lockView.setVisibility(on ? View.VISIBLE : View.GONE);
        if (lockButton != null) lockButton.setText(on ? "已锁定" : "锁定");
        setControlsVisible(!on);
        if (!on) scheduleHide();
        showHint(on ? "屏幕已锁定 · 点右侧「解锁」恢复" : "已解锁", 1600);
    }

    private ViewGroup buildBottomBar() {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.VERTICAL);
        bar.setPadding(dp(16), dp(20), dp(16), dp(16));
        // 底部渐变遮罩：从画面自然过渡到控制条，避免一条生硬的黑边
        bar.setBackground(
            new GradientDrawable(
                GradientDrawable.Orientation.TOP_BOTTOM,
                new int[]{0x00000000, 0x99000000, 0xE6000000}
            )
        );

        // ── 细进度条（3dp 轨道 + 白色小圆点 + 缓冲层）──
        seekBar = new SeekBar(this);
        seekBar.setMax(1);
        seekBar.setProgress(0);
        seekBar.setBackground(null);
        seekBar.setSplitTrack(false);
        seekBar.setProgressDrawable(buildTrackDrawable());
        seekBar.setThumb(buildThumbDrawable());
        seekBar.setThumbOffset(dp(7));
        seekBar.setPadding(dp(8), 0, dp(8), 0);
        seekBar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar sb, int progress, boolean fromUser) {
                if (fromUser && timeView != null) {
                    timeView.setText(
                        fmt(progress) + " / " + fmt(player == null ? 0 : player.getDuration())
                    );
                }
            }

            @Override
            public void onStartTrackingTouch(SeekBar sb) {
                dragging = true;
                uiHandler.removeCallbacks(hideRunnable);
                if (timeView != null) {
                    timeView.setTextColor(MINT);
                    timeView.setTypeface(Typeface.DEFAULT_BOLD);
                }
            }

            @Override
            public void onStopTrackingTouch(SeekBar sb) {
                dragging = false;
                if (player != null) player.seekTo(sb.getProgress());
                if (timeView != null) {
                    timeView.setTextColor(0xFFB9C0BD);
                    timeView.setTypeface(Typeface.DEFAULT);
                }
                scheduleHide();
            }
        });
        bar.addView(
            seekBar,
            new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(26)
            )
        );

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);

        TextView back10 = pill("−10", 0xFFE6EAE9);
        back10View = back10;
        back10.setOnClickListener(v -> seekBy(-10000));
        LinearLayout.LayoutParams b10Lp = new LinearLayout.LayoutParams(dp(42), dp(36));
        b10Lp.rightMargin = dp(8);
        row.addView(back10, b10Lp);

        playPauseView = makeText("▶", 14, 0xFF0B1210);
        playPauseView.setGravity(Gravity.CENTER);
        playPauseView.setBackground(rounded(0xE6FFFFFF, 999));
        playPauseView.setOnClickListener(v -> togglePlayInternal());
        LinearLayout.LayoutParams ppLp = new LinearLayout.LayoutParams(dp(40), dp(40));
        ppLp.rightMargin = dp(8);
        row.addView(playPauseView, ppLp);

        TextView fwd10 = pill("+10", 0xFFE6EAE9);
        fwd10View = fwd10;
        fwd10.setOnClickListener(v -> seekBy(10000));
        LinearLayout.LayoutParams f10Lp = new LinearLayout.LayoutParams(dp(42), dp(36));
        f10Lp.rightMargin = dp(14);
        row.addView(fwd10, f10Lp);

        timeView = makeText("00:00 / 00:00", 12, 0xFFB9C0BD);
        row.addView(timeView);

        // 直播角标：默认隐藏，直播模式下替代「已播 / 总时长」
        liveBadge = makeText("● LIVE", 12, MINT);
        liveBadge.setTypeface(Typeface.DEFAULT_BOLD);
        liveBadge.setVisibility(View.GONE);
        LinearLayout.LayoutParams lbLp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        lbLp.leftMargin = dp(10);
        row.addView(liveBadge, lbLp);

        // ── 直播专属按钮（点播下隐藏）──────────────────
        danmakuToggle = pill("弹幕开", MINT);
        danmakuToggle.setVisibility(View.GONE);
        danmakuToggle.setOnClickListener(v -> setDanmakuEnabled(!danmakuOn));
        LinearLayout.LayoutParams dmLp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        dmLp.leftMargin = dp(10);
        dmLp.rightMargin = dp(8);
        row.addView(danmakuToggle, dmLp);

        fillToggle = pill("完整", 0xFFE6EAE9);
        fillToggle.setVisibility(View.GONE);
        fillToggle.setOnClickListener(v -> applyFillMode(!fillMode));
        LinearLayout.LayoutParams ftLp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        ftLp.rightMargin = dp(8);
        row.addView(fillToggle, ftLp);

        orientationToggle = pill("横屏", 0xFFE6EAE9);
        orientationToggle.setVisibility(View.GONE);
        orientationToggle.setOnClickListener(v -> toggleOrientation());
        LinearLayout.LayoutParams otLp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        otLp.rightMargin = dp(8);
        row.addView(orientationToggle, otLp);

        View spacer = new View(this);
        row.addView(spacer, new LinearLayout.LayoutParams(0, 1, 1f));

        speedView = makeText(speedLabel(), 12, 0xFFE6EAE9);
        speedView.setGravity(Gravity.CENTER);
        speedView.setBackground(rounded(0x66101414, 999));
        speedView.setPadding(dp(14), dp(8), dp(14), dp(8));
        speedView.setOnClickListener(v -> cycleSpeed());
        LinearLayout.LayoutParams spLp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        spLp.rightMargin = dp(8);
        row.addView(speedView, spLp);

        epPrevView = makeText("上一集", 12, 0xFFE6EAE9);
        epPrevView.setGravity(Gravity.CENTER);
        epPrevView.setBackground(rounded(0x66101414, 999));
        epPrevView.setPadding(dp(14), dp(8), dp(14), dp(8));
        epPrevView.setVisibility(View.GONE);
        epPrevView.setOnClickListener(v -> jumpEpisode(prevEpisode()));
        LinearLayout.LayoutParams epPrevLp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        epPrevLp.rightMargin = dp(8);
        row.addView(epPrevView, epPrevLp);

        epNextView = makeText("下一集", 12, 0xFFE6EAE9);
        epNextView.setGravity(Gravity.CENTER);
        epNextView.setBackground(rounded(0x66101414, 999));
        epNextView.setPadding(dp(14), dp(8), dp(14), dp(8));
        epNextView.setVisibility(View.GONE);
        epNextView.setOnClickListener(v -> jumpEpisode(nextEpisode()));
        LinearLayout.LayoutParams epNextLp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        epNextLp.rightMargin = dp(8);
        row.addView(epNextView, epNextLp);

        episodeView = makeText("选集", 12, 0xFFE6EAE9);
        episodeView.setGravity(Gravity.CENTER);
        episodeView.setBackground(rounded(0x66101414, 999));
        episodeView.setPadding(dp(16), dp(8), dp(16), dp(8));
        episodeView.setVisibility(View.GONE);
        episodeView.setOnClickListener(v -> toggleEpisodePanel());
        LinearLayout.LayoutParams epLp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        epLp.rightMargin = dp(8);
        row.addView(episodeView, epLp);

        TextView next = makeText("换线", 12, MINT);
        switchLineView = next;
        next.setGravity(Gravity.CENTER);
        next.setBackground(rounded(0x66101414, 999));
        next.setPadding(dp(16), dp(8), dp(16), dp(8));
        next.setOnClickListener(v -> {
            Logger.info("[PlayerActivity] 用户点击换线");
            NativePlayerPlugin.emitFromNative("nativeNext", new JSObject());
        });
        LinearLayout.LayoutParams nextLp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        nextLp.rightMargin = dp(8);
        row.addView(next, nextLp);

        TextView all = makeText("线路", 12, 0xFFE6EAE9);
        linesView = all;
        all.setGravity(Gravity.CENTER);
        all.setBackground(rounded(0x66101414, 999));
        all.setPadding(dp(16), dp(8), dp(16), dp(8));
        all.setOnClickListener(v -> {
            Logger.info("[PlayerActivity] 用户点击全部线路");
            // 关闭播放界面，让 WebView 里的线路列表可见
            NativePlayerPlugin.emitFromNative("nativeLines", new JSObject());
            finish();
        });
        row.addView(
            all,
            new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        );

        // 竖屏时按钮较多，横向可滚动，避免挤出屏幕
        HorizontalScrollView rowScroll = new HorizontalScrollView(this);
        rowScroll.setHorizontalScrollBarEnabled(false);
        rowScroll.setFillViewport(true);
        rowScroll.addView(row);
        bar.addView(rowScroll);

        // 诊断状态（最小号，放最下面，不干扰操作）
        statusView = makeText("正在连接…", 10, 0x998A9391);
        LinearLayout.LayoutParams stLp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        stLp.topMargin = dp(8);
        bar.addView(statusView, stLp);

        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        lp.gravity = Gravity.BOTTOM;
        bar.setLayoutParams(lp);
        return bar;
    }

    /** 统一的胶囊按钮（底部操作栏） */
    private TextView pill(String text, int color) {
        TextView t = makeText(text, 12, color);
        t.setGravity(Gravity.CENTER);
        t.setBackground(rounded(0x66101414, 999));
        return t;
    }

    /**
     * 细轨道进度条（与 Web 端 PlayerBar 完全一致）
     *
     * 4dp 轨道：白 16% 底轨 / 白 20% 缓冲 / 薄荷绿已播；
     * 用 LayerDrawable 的 layerHeight + center_vertical 精确居中，
     * 避免系统默认 SeekBar 那根粗灰条。
     */
    private Drawable buildTrackDrawable() {
        int h = dp(4);
        float r = h / 2f;

        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0x29F1F5F3);
        bg.setCornerRadius(r);

        GradientDrawable buf = new GradientDrawable();
        buf.setColor(0x33F1F5F3);
        buf.setCornerRadius(r);
        ClipDrawable bufClip = new ClipDrawable(buf, Gravity.LEFT, ClipDrawable.HORIZONTAL);

        GradientDrawable played = new GradientDrawable();
        played.setColor(MINT);
        played.setCornerRadius(r);
        ClipDrawable playedClip = new ClipDrawable(played, Gravity.LEFT, ClipDrawable.HORIZONTAL);

        LayerDrawable layers = new LayerDrawable(new Drawable[]{bg, bufClip, playedClip});
        layers.setId(0, android.R.id.background);
        layers.setId(1, android.R.id.secondaryProgress);
        layers.setId(2, android.R.id.progress);
        for (int i = 0; i < 3; i++) {
            layers.setLayerHeight(i, h);
            layers.setLayerGravity(i, Gravity.CENTER_VERTICAL);
        }
        return layers;
    }

    /** 进度条滑块：14dp 薄荷绿圆点 + 深色描边，与 Web 端一致 */
    private Drawable buildThumbDrawable() {
        GradientDrawable thumb = new GradientDrawable();
        thumb.setShape(GradientDrawable.OVAL);
        thumb.setColor(MINT);
        thumb.setStroke(dp(2), 0xFF0A0A0A);
        thumb.setSize(dp(14), dp(14));
        return thumb;
    }

    /** 毫秒 → 00:12 / 1:02:03 */
    private String fmt(long ms) {
        if (ms < 0) ms = 0;
        long total = ms / 1000;
        long h = total / 3600;
        long m = (total % 3600) / 60;
        long s = total % 60;
        if (h > 0) return String.format(Locale.US, "%d:%02d:%02d", h, m, s);
        return String.format(Locale.US, "%02d:%02d", m, s);
    }

    /** 刷新进度条 / 时间 / 缓冲 / 播放状态，并把进度同步给前端 */
    private void updateProgress() {
        if (player == null) {
            return;
        }
        long dur = Math.max(player.getDuration(), 0);
        long pos = Math.max(player.getCurrentPosition(), 0);

        if (seekBar != null && !dragging && !liveMode) {
            int max = (int) Math.max(dur, 1);
            if (seekBar.getMax() != max) seekBar.setMax(max);
            seekBar.setProgress((int) Math.min(pos, max));

            long buffered = player.getBufferedPosition();
            if (buffered > 0 && dur > 0) {
                int bp = (int) Math.min(buffered, dur);
                if (seekBar.getSecondaryProgress() != bp) seekBar.setSecondaryProgress(bp);
            }
        }
        if (timeView != null && !dragging && !liveMode) {
            timeView.setText(fmt(pos) + " / " + fmt(dur));
        }
        if (playPauseView != null) {
            playPauseView.setText(player.isPlaying() ? "❚❚" : "▶");
        }

        /**
         * 片尾跳过
         *
         * 剩不到 N 秒就直接进下一集（有下一集时才触发），
         * 避免对着片尾字幕干等；没有下一集则让它自然播完。
         */
        if (autoNextEnabled && skipOutroMs > 0 && dur > skipOutroMs && !outroTriggered
            && dur - pos <= skipOutroMs && nextEpisode() > 0) {
            outroTriggered = true;
            showHint("片尾已跳过", 1200);
            onEndedAutoNext();
        }

        // 每秒同步一次给前端：续播记忆、Web 端进度都依赖这个值
        long now = SystemClock.elapsedRealtime();
        if (now - lastProgressEmit >= 1000) {
            lastProgressEmit = now;
            JSObject o = new JSObject();
            o.put("position", pos);
            o.put("duration", dur);
            NativePlayerPlugin.emitFromNative("progress", o);
        }
    }

    private TextView makeText(String text, float sp, int color) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        return t;
    }

    private GradientDrawable rounded(int color, int radiusPx) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(color);
        d.setCornerRadius(radiusPx);
        return d;
    }

    private int dp(float v) {
        return (int) TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            v,
            getResources().getDisplayMetrics()
        );
    }

    // ── 控制条显隐 ──────────────────────────────────────

    private void setControlsVisible(boolean visible) {
        controlsVisible = visible;
        if (!visible) uiHandler.removeCallbacks(hideRunnable);
        animateBar(topBar, visible);
        animateBar(bottomBar, visible);
    }

    /** 控制条淡入淡出，比直接 GONE 突兀切换自然 */
    private void animateBar(final View bar, final boolean visible) {
        if (bar == null) return;
        bar.animate().cancel();
        if (visible) {
            bar.setVisibility(View.VISIBLE);
            bar.setAlpha(0f);
            bar.animate().alpha(1f).setDuration(160).start();
        } else {
            bar.animate().alpha(0f).setDuration(160).withEndAction(() -> {
                if (!controlsVisible) bar.setVisibility(View.GONE);
            }).start();
        }
    }

    private void scheduleHide() {
        uiHandler.removeCallbacks(hideRunnable);
        if (panelOpen) return;
        uiHandler.postDelayed(hideRunnable, HIDE_DELAY_MS);
    }

    private void togglePlayInternal() {
        if (player == null) return;
        boolean wasPlaying = player.isPlaying();
        player.setPlayWhenReady(!wasPlaying);
        showHint(wasPlaying ? "已暂停" : "继续播放", 700);
        if (controlsVisible) scheduleHide();
    }

    private void showHint(String text, long durationMs) {
        if (hintView == null) return;
        hintView.setText(text);
        hintView.setVisibility(View.VISIBLE);
        uiHandler.removeCallbacks(hintHideRunnable);
        if (durationMs > 0) uiHandler.postDelayed(hintHideRunnable, durationMs);
    }

    private void cycleSpeed() {
        int idx = 0;
        float minDiff = Float.MAX_VALUE;
        for (int i = 0; i < SPEEDS.length; i++) {
            float d = Math.abs(SPEEDS[i] - speed);
            if (d < minDiff) {
                minDiff = d;
                idx = i;
            }
        }
        speed = SPEEDS[(idx + 1) % SPEEDS.length];
        if (player != null) {
            player.setPlaybackParameters(new PlaybackParameters(speed));
        }
        updateSpeedLabel();
        showHint("倍速 " + speedLabel(), 900);
        scheduleHide();
    }

    private void updateSpeedLabel() {
        if (speedView != null) speedView.setText(speedLabel());
    }

    private String speedLabel() {
        String s = String.format(Locale.US, "%.2f", speed);
        s = s.replaceAll("0+$", "").replaceAll("\\.$", "");
        return s + "×";
    }

    // ── 手势 ────────────────────────────────────────────

    private boolean onGestureTouch(View v, MotionEvent e) {
        // 锁屏状态下吞掉一切手势，只有右侧「解锁」浮标可点
        if (locked) return true;
        switch (e.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                downX = e.getX();
                downY = e.getY();
                moving = false;
                gestureType = G_NONE;
                longPressActive = false;
                uiHandler.postDelayed(longPressRunnable, 450);
                return true;

            case MotionEvent.ACTION_MOVE:
                handleGestureMove(e);
                return true;

            case MotionEvent.ACTION_UP:
                handleGestureUp(e);
                return true;

            case MotionEvent.ACTION_CANCEL:
                uiHandler.removeCallbacks(longPressRunnable);
                if (longPressActive) endLongPress();
                gestureType = G_NONE;
                uiHandler.postDelayed(hintHideRunnable, 300);
                return true;

            default:
                return true;
        }
    }

    private void handleGestureMove(MotionEvent e) {
        float dx = e.getX() - downX;
        float dy = e.getY() - downY;

        if (!moving && Math.hypot(dx, dy) > touchSlop) {
            moving = true;
            uiHandler.removeCallbacks(longPressRunnable);
            if (longPressActive) endLongPress();
        }
        if (!moving) return;

        int w = Math.max(gestureLayer.getWidth(), 1);
        int h = Math.max(gestureLayer.getHeight(), 1);

        if (gestureType == G_NONE) {
            if (Math.abs(dx) > Math.abs(dy)) {
                gestureType = G_SEEK;
                seekStartMs = player == null ? 0L : player.getCurrentPosition();
                seekTargetMs = seekStartMs;
            } else if (downX < w / 2f) {
                gestureType = G_BRIGHTNESS;
                WindowManager.LayoutParams lp = getWindow().getAttributes();
                float cur = lp.screenBrightness;
                if (cur < 0) {
                    try {
                        cur = android.provider.Settings.System.getInt(
                            getContentResolver(),
                            android.provider.Settings.System.SCREEN_BRIGHTNESS
                        ) / 255f;
                    } catch (Exception ex) {
                        cur = 0.5f;
                    }
                }
                brightnessStart = Math.max(0.05f, Math.min(1f, cur));
            } else {
                gestureType = G_VOLUME;
                AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
                if (am != null) {
                    volumeMax = Math.max(1, am.getStreamMaxVolume(AudioManager.STREAM_MUSIC));
                    volumeStart = am.getStreamVolume(AudioManager.STREAM_MUSIC);
                }
            }
        }

        switch (gestureType) {
            case G_SEEK: {
                long dur = player == null ? 0L : Math.max(player.getDuration(), 0L);
                long delta = (long) ((dx / w) * 90000);
                seekTargetMs = Math.max(0L, seekStartMs + delta);
                if (dur > 0) seekTargetMs = Math.min(seekTargetMs, dur);
                showHint(
                    (delta >= 0 ? "快进 " : "快退 ") + fmt(Math.abs(delta))
                        + " · " + fmt(seekTargetMs) + " / " + fmt(dur),
                    0
                );
                break;
            }
            case G_VOLUME: {
                float ratio = -dy / (h * 0.7f);
                int target = Math.round(volumeStart + ratio * volumeMax);
                target = Math.max(0, Math.min(volumeMax, target));
                AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
                if (am != null) am.setStreamVolume(AudioManager.STREAM_MUSIC, target, 0);
                int pct = Math.round(target * 100f / Math.max(volumeMax, 1));
                showHint("音量 " + pct + "%", 0);
                break;
            }
            case G_BRIGHTNESS: {
                float ratio = -dy / (h * 0.7f);
                float target = Math.max(0.05f, Math.min(1f, brightnessStart + ratio));
                WindowManager.LayoutParams lp = getWindow().getAttributes();
                lp.screenBrightness = target;
                getWindow().setAttributes(lp);
                showHint("亮度 " + Math.round(target * 100) + "%", 0);
                break;
            }
            default:
                break;
        }
    }

    private void handleGestureUp(MotionEvent e) {
        uiHandler.removeCallbacks(longPressRunnable);

        if (longPressActive) {
            endLongPress();
            gestureType = G_NONE;
            uiHandler.postDelayed(hintHideRunnable, 300);
            return;
        }

        if (gestureType == G_SEEK) {
            if (player != null) player.seekTo(seekTargetMs);
            gestureType = G_NONE;
            uiHandler.postDelayed(hintHideRunnable, 500);
            return;
        }
        if (gestureType != G_NONE) {
            if (gestureType == G_BRIGHTNESS) {
                // 记住这次亮度，下次打开任意影片直接沿用
                WindowManager.LayoutParams lp = getWindow().getAttributes();
                float v = lp.screenBrightness;
                if (v > 0) {
                    getSharedPreferences(PREFS_QUALITY, MODE_PRIVATE)
                        .edit()
                        .putFloat(KEY_BRIGHTNESS, v)
                        .apply();
                }
            }
            gestureType = G_NONE;
            uiHandler.postDelayed(hintHideRunnable, 500);
            return;
        }
        if (moving) {
            // 拖动过但没形成手势（幅度太小）→ 不算点击
            return;
        }

        long now = SystemClock.elapsedRealtime();
        float x = e.getX();
        int w = Math.max(gestureLayer.getWidth(), 1);

        if (now - lastTapTime < DOUBLE_TAP_MS && Math.abs(x - lastTapX) < dp(80)) {
            uiHandler.removeCallbacks(singleTapRunnable);
            lastTapTime = 0L;
            if (x < w / 3f) {
                seekBy(-10000);
            } else if (x > w * 2f / 3f) {
                seekBy(10000);
            } else {
                togglePlayInternal();
            }
            return;
        }

        lastTapTime = now;
        lastTapX = x;
        uiHandler.postDelayed(singleTapRunnable, DOUBLE_TAP_MS);
    }

    private void endLongPress() {
        longPressActive = false;
        if (player != null) {
            player.setPlaybackParameters(new PlaybackParameters(speed));
        }
        uiHandler.removeCallbacks(hintHideRunnable);
        if (hintView != null) hintView.setVisibility(View.GONE);
    }

    private void seekBy(long deltaMs) {
        if (player == null) return;
        long dur = Math.max(player.getDuration(), 0L);
        long target = player.getCurrentPosition() + deltaMs;
        if (target < 0) target = 0;
        if (dur > 0 && target > dur) target = dur;
        player.seekTo(target);
        showHint(
            (deltaMs > 0 ? "快进 " : "快退 ") + (Math.abs(deltaMs) / 1000) + " 秒",
            800
        );
        if (controlsVisible) scheduleHide();
    }

    // ── 选集面板 ────────────────────────────────────────

    private void toggleEpisodePanel() {
        if (episodes.size() <= 1) {
            showHint("当前没有其他剧集", 1200);
            return;
        }
        if (episodePanel == null) {
            episodePanel = buildEpisodePanel();
            episodePanel.setVisibility(View.GONE);
            root.addView(
                episodePanel,
                new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
            );
        }
        panelOpen = episodePanel.getVisibility() != View.VISIBLE;
        episodePanel.setVisibility(panelOpen ? View.VISIBLE : View.GONE);
        if (panelOpen) {
            uiHandler.removeCallbacks(hideRunnable);
            setControlsVisible(true);
            scrollToCurrentEpisode();
        } else {
            scheduleHide();
        }
    }

    /** 打开选集面板时自动滚到当前集，长剧集不用手动翻 */
    private void scrollToCurrentEpisode() {
        if (episodeScroll == null || episodeCurrentCell == null) return;
        episodeScroll.post(() -> {
            int y = episodeCurrentCell.getTop() - dp(8);
            episodeScroll.smoothScrollTo(0, Math.max(0, y));
        });
    }

    private void closeEpisodePanel() {
        // 直接销毁重建：换集后高亮的是「当前集」，沿用旧面板会一直停在打开时那一集
        if (episodePanel != null) {
            root.removeView(episodePanel);
            episodePanel = null;
        }
        episodeScroll = null;
        episodeCurrentCell = null;
        panelOpen = false;
        scheduleHide();
    }

    private FrameLayout buildEpisodePanel() {
        FrameLayout panel = new FrameLayout(this);
        panel.setBackgroundColor(0xD9080A0A);
        panel.setOnClickListener(v -> closeEpisodePanel());

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(20), dp(16), dp(20), dp(16));
        box.setBackground(rounded(0xFF141818, dp(18)));
        box.setOnClickListener(v -> { /* 拦住点击，避免穿透关闭 */ });

        FrameLayout.LayoutParams boxLp = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        );
        boxLp.setMargins(dp(40), dp(20), dp(40), dp(20));
        panel.addView(box, boxLp);

        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(Gravity.CENTER_VERTICAL);
        head.setPadding(0, 0, 0, dp(10));

        TextView title = makeText("选集", 16, Color.WHITE);
        head.addView(
            title,
            new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        );

        TextView close = makeText("×", 24, 0xFFB9C0BD);
        close.setGravity(Gravity.CENTER);
        close.setPadding(dp(16), 0, dp(6), 0);
        close.setOnClickListener(v -> closeEpisodePanel());
        head.addView(
            close,
            new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        );

        box.addView(head);

        ScrollView scroll = new ScrollView(this);
        scroll.setVerticalScrollBarEnabled(true);
        episodeScroll = scroll;
        episodeCurrentCell = null;

        GridLayout grid = new GridLayout(this);
        grid.setColumnCount(6);
        grid.setUseDefaultMargins(false);
        grid.setPadding(0, 0, 0, dp(4));

        for (Ep ep : episodes) {
            boolean on = ep.n == currentEpisode;
            TextView cell = makeText(
                ep.label,
                13,
                on ? 0xFF0B1210 : Color.WHITE
            );
            cell.setGravity(Gravity.CENTER);
            cell.setSingleLine(true);
            cell.setEllipsize(TextUtils.TruncateAt.END);
            cell.setPadding(dp(8), dp(10), dp(8), dp(10));
            cell.setBackground(rounded(on ? MINT : 0xFF1E2422, dp(8)));
            if (on) episodeCurrentCell = cell;
            cell.setOnClickListener(v -> {
                closeEpisodePanel();
                if (ep.n == currentEpisode) return;

                String target = episodeUrl(ep.n);
                if (target != null) {
                    // 有整季地址 → 直接在本进程换集，不经过前端
                    currentEpisode = ep.n;
                    sessionEpisode = ep.n;
                    startPlayback(target, parseHeaders(sessionHeaders), sessionTitle, 0L);
                    JSObject o = new JSObject();
                    o.put("episode", ep.n);
                    o.put("label", ep.label);
                    o.put("auto", false);
                    o.put("handled", true);
                    NativePlayerPlugin.emitFromNative("nativeEpisode", o);
                    return;
                }

                // 没有地址表（单集资源/旧调用）→ 交回前端重新解析起播
                JSObject o = new JSObject();
                o.put("episode", ep.n);
                o.put("label", ep.label);
                o.put("auto", false);
                o.put("handled", false);
                NativePlayerPlugin.emitFromNative("nativeEpisode", o);
            });
            GridLayout.LayoutParams lp = new GridLayout.LayoutParams();
            lp.width = dp(104);
            lp.height = ViewGroup.LayoutParams.WRAP_CONTENT;
            lp.setMargins(dp(4), dp(4), dp(4), dp(4));
            grid.addView(cell, lp);
        }

        scroll.addView(grid);
        box.addView(
            scroll,
            new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        );

        return panel;
    }

    /**
     * 解析整季地址表
     *
     * 前端一次 CMS 详情就把整季地址都拿到了，同步给原生窗口后，
     * 选集点选与播完续播都能在本进程内直接换集 ——
     * 不再依赖「原生 → JS 解析 → 再起播」，也就不会出现
     * 解析失败时静默停在上一集的问题。
     */
    private void parseEpisodeUrls(String json) {
        episodeUrlMap.clear();
        if (json == null || json.isEmpty()) return;
        try {
            JSONArray arr = new JSONArray(json);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                int n = o.optInt("n", i + 1);
                String url = o.optString("url", "");
                if (n > 0 && url != null && !url.isEmpty()) episodeUrlMap.put(n, url);
            }
            Logger.info("[PlayerActivity] 整季地址表: " + episodeUrlMap.size() + " 集");
        } catch (Exception e) {
            Logger.error("[PlayerActivity] 地址表解析失败: " + e.getMessage());
        }
    }

    /** 当前集号对应的地址；没有则返回 null */
    private String episodeUrl(int n) {
        String u = episodeUrlMap.get(n);
        return u == null || u.isEmpty() ? null : u;
    }

    private void parseEpisodes(String json) {
        episodes.clear();
        if (json != null && !json.isEmpty()) {
            try {
                JSONArray arr = new JSONArray(json);
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject o = arr.optJSONObject(i);
                    if (o == null) continue;
                    int n = o.optInt("n", i + 1);
                    String label = o.optString("label", "第 " + n + " 集");
                    episodes.add(new Ep(n, label));
                }
            } catch (Exception e) {
                Logger.error("[PlayerActivity] 选集数据解析失败: " + e.getMessage());
            }
        }
        syncEpisodeUi();
    }

    private void syncEpisodeUi() {
        if (episodeView != null) {
            episodeView.setVisibility(episodes.size() > 1 ? View.VISIBLE : View.GONE);
        }
        if (epPrevView != null) {
            epPrevView.setVisibility(prevEpisode() > 0 ? View.VISIBLE : View.GONE);
        }
        if (epNextView != null) {
            epNextView.setVisibility(nextEpisode() > 0 ? View.VISIBLE : View.GONE);
        }
        if (episodePanel != null) {
            root.removeView(episodePanel);
            episodePanel = null;
            panelOpen = false;
        }
    }

    /** 上一集（比当前小的最大集号），没有则返回 -1 */
    private int prevEpisode() {
        int prev = -1;
        for (Ep e : episodes) {
            if (e.n < currentEpisode && e.n > prev) prev = e.n;
        }
        if (prev > 0) return prev;
        for (Integer k : episodeUrlMap.keySet()) {
            if (k < currentEpisode && k > prev) prev = k;
        }
        return prev > 0 ? prev : -1;
    }

    /**
     * 上一集 / 下一集快捷跳转
     *
     * 有整季地址就在本进程直接换集，没有则交回前端解析，
     * 和选集面板、播完续播共用同一套逻辑。
     */
    private void jumpEpisode(int n) {
        if (n <= 0 || n == currentEpisode) return;
        String target = episodeUrl(n);
        if (target != null) {
            currentEpisode = n;
            sessionEpisode = n;
            startPlayback(target, parseHeaders(sessionHeaders), sessionTitle, 0L);
            JSObject o = new JSObject();
            o.put("episode", n);
            o.put("auto", false);
            o.put("handled", true);
            NativePlayerPlugin.emitFromNative("nativeEpisode", o);
            return;
        }
        JSObject o = new JSObject();
        o.put("episode", n);
        o.put("auto", false);
        o.put("handled", false);
        NativePlayerPlugin.emitFromNative("nativeEpisode", o);
    }

    /** 下一集（按集号顺序找比当前大的最小集号），没有则返回 -1 */
    private int nextEpisodeNumber() {
        int next = Integer.MAX_VALUE;
        for (Ep e : episodes) {
            if (e.n > currentEpisode && e.n < next) next = e.n;
        }
        return next == Integer.MAX_VALUE ? -1 : next;
    }

    /** 下一集：优先选集列表，其次整季地址表（选集列表缺失时也能续播） */
    private int nextEpisode() {
        int n = nextEpisodeNumber();
        if (n > 0) return n;
        int best = Integer.MAX_VALUE;
        for (Integer k : episodeUrlMap.keySet()) {
            if (k > currentEpisode && k < best) best = k;
        }
        return best == Integer.MAX_VALUE ? -1 : best;
    }

    // ── 投屏面板 ────────────────────────────────────────

    /** 顶部「投屏」按钮：没在投时打开设备列表，已在投时直接停止 */
    private void toggleCastPanel() {
        if (castPanelOpen) {
            closeCastPanel();
            return;
        }
        CastPlugin cp = CastPlugin.get();
        if (cp == null) {
            showHint("投屏不可用", 1600);
            return;
        }
        if (cp.isCasting()) {
            stopCasting();
            showHint("已停止投屏", 1600);
            updateCastLabel();
            return;
        }
        java.util.List<CastPlugin.CastDeviceInfo> devs = cp.listDevicesNow();
        if (devs.isEmpty()) {
            showHint("未发现可投屏设备（请确认电视已开启 DLNA 且在同一 WiFi）", 2600);
            return;
        }
        showCastPanel(devs);
    }

    private void showCastPanel(java.util.List<CastPlugin.CastDeviceInfo> devs) {
        if (castPanel != null) {
            root.removeView(castPanel);
            castPanel = null;
        }
        castPanel = buildCastPanel(devs);
        root.addView(
            castPanel,
            new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        );
        castPanelOpen = true;
        uiHandler.removeCallbacks(hideRunnable);
        setControlsVisible(true);
    }

    private void closeCastPanel() {
        if (castPanel != null) {
            root.removeView(castPanel);
            castPanel = null;
        }
        castPanelOpen = false;
        scheduleHide();
    }

    private FrameLayout buildCastPanel(java.util.List<CastPlugin.CastDeviceInfo> devs) {
        FrameLayout panel = new FrameLayout(this);
        panel.setBackgroundColor(0xD9080A0A);
        panel.setOnClickListener(v -> closeCastPanel());

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(20), dp(16), dp(20), dp(16));
        box.setBackground(rounded(0xFF141818, dp(18)));
        box.setOnClickListener(v -> { /* 拦住点击，避免穿透关闭 */ });

        FrameLayout.LayoutParams boxLp = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        boxLp.setMargins(dp(80), dp(20), dp(80), dp(20));
        boxLp.gravity = Gravity.CENTER;
        panel.addView(box, boxLp);

        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(Gravity.CENTER_VERTICAL);
        head.setPadding(0, 0, 0, dp(8));

        TextView title = makeText("投屏到电视", 16, Color.WHITE);
        head.addView(
            title,
            new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        );

        TextView close = makeText("×", 24, 0xFFB9C0BD);
        close.setGravity(Gravity.CENTER);
        close.setPadding(dp(16), 0, dp(6), 0);
        close.setOnClickListener(v -> closeCastPanel());
        head.addView(
            close,
            new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        );
        box.addView(head);

        TextView hint = makeText("选择一台设备，电视将自行拉流播放", 11, 0x99B9C0BD);
        hint.setPadding(0, 0, 0, dp(8));
        box.addView(hint);

        ScrollView scroll = new ScrollView(this);
        LinearLayout list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);

        for (CastPlugin.CastDeviceInfo d : devs) {
            LinearLayout item = new LinearLayout(this);
            item.setOrientation(LinearLayout.VERTICAL);
            item.setPadding(dp(14), dp(11), dp(14), dp(11));
            item.setBackground(rounded(0xFF1E2422, dp(10)));
            item.setOnClickListener(v -> {
                String err = castToDevice(d);
                if (err == null) {
                    closeCastPanel();
                    showHint("已投屏到「" + d.name + "」", 2200);
                    updateCastLabel();
                } else {
                    showHint("投屏失败：" + err, 2400);
                }
            });

            TextView name = makeText(d.name, 13, Color.WHITE);
            name.setSingleLine(true);
            name.setEllipsize(TextUtils.TruncateAt.END);
            item.addView(name);

            if (d.description != null && !d.description.isEmpty()) {
                TextView desc = makeText(d.description, 10, 0x99B9C0BD);
                desc.setSingleLine(true);
                desc.setEllipsize(TextUtils.TruncateAt.END);
                LinearLayout.LayoutParams descLp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                );
                descLp.topMargin = dp(2);
                item.addView(desc, descLp);
            }

            LinearLayout.LayoutParams itemLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            );
            itemLp.bottomMargin = dp(6);
            list.addView(item, itemLp);
        }

        scroll.addView(list);
        box.addView(
            scroll,
            new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        );

        return panel;
    }

    /** 投屏按钮文案：投屏中高亮显示，用户一眼能看出当前状态 */
    private void updateCastLabel() {
        if (castButton == null) return;
        boolean casting = isCasting();
        castButton.setText(casting ? "投屏中" : "投屏");
        castButton.setTextColor(casting ? MINT : 0xE6FFFFFF);
    }

    // ── 起播前海报 ──────────────────────────────────────

    /**
     * 拉取海报并铺成底图
     *
     * 解码时降到 240px 宽再拉伸到全屏，天然带模糊感，
     * 比做高斯模糊省 CPU，也不依赖 RenderScript。
     */
    private void loadPoster(String url) {
        if (posterView == null || url == null || url.isEmpty()) return;
        posterUrl = url;
        posterView.animate().cancel();
        posterView.setAlpha(1f);
        posterView.setVisibility(View.VISIBLE);
        new Thread(() -> {
            Bitmap bmp = fetchPosterBitmap(url);
            if (bmp == null) return;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                if (!url.equals(posterUrl)) return;
                posterView.setImageBitmap(bmp);
                posterView.setVisibility(View.VISIBLE);
                posterView.setAlpha(1f);
            });
        }, "poster-load").start();
    }

    private Bitmap fetchPosterBitmap(String url) {
        java.net.HttpURLConnection conn = null;
        try {
            conn = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
            conn.setRequestProperty(
                "User-Agent",
                "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"
            );
            java.io.InputStream in = conn.getInputStream();
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            in.close();
            byte[] data = bos.toByteArray();

            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(data, 0, data.length, bounds);
            int sample = 1;
            while (bounds.outWidth / (sample * 2) >= 240) sample *= 2;

            BitmapFactory.Options opt = new BitmapFactory.Options();
            opt.inSampleSize = sample;
            opt.inPreferredConfig = Bitmap.Config.RGB_565;
            return BitmapFactory.decodeByteArray(data, 0, data.length, opt);
        } catch (Exception e) {
            Logger.error("[PlayerActivity] 海报加载失败: " + e.getMessage());
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /** 首帧已出画 → 海报淡出，别挡住真正画面 */
    private void fadeOutPoster() {
        if (posterView == null || posterView.getVisibility() != View.VISIBLE) return;
        posterView.animate().alpha(0f).setDuration(380).withEndAction(() -> {
            if (posterView != null) posterView.setVisibility(View.GONE);
        }).start();
    }

    // ── 播放 ────────────────────────────────────────────

    private void handleIntent(Intent intent) {
        if (intent == null) return;
        String url = intent.getStringExtra(EXTRA_URL);
        if (url == null || url.isEmpty()) {
            Logger.error("[PlayerActivity] 缺少播放地址");
            finish();
            return;
        }
        String title = intent.getStringExtra(EXTRA_TITLE);
        String headersJson = intent.getStringExtra(EXTRA_HEADERS);
        /**
         * 直播标记必须在解析其他参数**之前**读出来：
         * 片头/片尾跳过、自动连播、续播位置都要据此强制关闭。
         */
        liveMode = intent.getBooleanExtra(EXTRA_LIVE, false);
        sessionLive = liveMode;
        // 直播跟随系统方向（可竖屏），点播固定横屏
        setRequestedOrientation(
            liveMode
                ? ActivityInfo.SCREEN_ORIENTATION_FULL_USER
                : ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        );
        long startPos = liveMode ? 0L : intent.getLongExtra(EXTRA_POSITION, 0L);

        String epsJson = intent.hasExtra(EXTRA_EPISODES)
            ? intent.getStringExtra(EXTRA_EPISODES)
            : sessionEpisodes;
        String urlsJson = intent.hasExtra(EXTRA_EPISODE_URLS)
            ? intent.getStringExtra(EXTRA_EPISODE_URLS)
            : sessionEpisodeUrls;
        currentEpisode = intent.hasExtra(EXTRA_EPISODE)
            ? intent.getIntExtra(EXTRA_EPISODE, 1)
            : sessionEpisode;
        sessionEpisode = currentEpisode;
        sessionEpisodes = epsJson == null ? "" : epsJson;
        sessionEpisodeUrls = urlsJson == null ? "" : urlsJson;
        parseEpisodes(sessionEpisodes);
        parseEpisodeUrls(sessionEpisodeUrls);

        skipIntroMs = liveMode
            ? 0L
            : Math.max(0L, (long) (intent.getDoubleExtra(EXTRA_SKIP_INTRO, 0) * 1000));
        skipOutroMs = liveMode
            ? 0L
            : Math.max(0L, (long) (intent.getDoubleExtra(EXTRA_SKIP_OUTRO, 0) * 1000));
        autoNextEnabled = !liveMode && intent.getBooleanExtra(EXTRA_AUTO_NEXT, true);
        introSkipped = false;
        outroTriggered = false;
        loadPoster(intent.getStringExtra(EXTRA_POSTER));

        // 字幕：插件已把文本落到缓存文件，这里只收路径
        if (intent.hasExtra(EXTRA_SUBTITLE_PATH)) {
            String p = intent.getStringExtra(EXTRA_SUBTITLE_PATH);
            String mime = intent.getStringExtra(EXTRA_SUBTITLE_MIME);
            subtitleUri = p == null ? "" : p;
            subtitleMime = mime == null ? "" : mime;
        }

        // 填充：直播默认完整显示（contain），点播沿用会话里的偏好
        if (intent.hasExtra(EXTRA_FILL)) {
            applyFillMode(intent.getBooleanExtra(EXTRA_FILL, !liveMode));
        } else {
            applyFillMode(liveMode ? liveFillPref() : fillMode);
        }
        applyLiveUi();
        setupLiveDanmaku(intent);
        startPlayback(url, parseHeaders(headersJson), title == null ? "" : title, startPos);
    }

    /**
     * 控制条形态
     *
     * 直播没有总时长：进度条、±10 秒、倍速、上下集、选集全部隐藏，
     * 换成弹幕 / 画面填充 / 横竖屏切换，并保留换线与线路入口。
     * 换台由 Web 端频道墙负责。
     */
    private void applyLiveUi() {
        if (!liveMode) {
            if (danmakuToggle != null) danmakuToggle.setVisibility(View.GONE);
            if (fillToggle != null) fillToggle.setVisibility(View.GONE);
            if (orientationToggle != null) orientationToggle.setVisibility(View.GONE);
            if (danmakuLayer != null) danmakuLayer.setVisibility(View.GONE);
            return;
        }
        if (danmakuLayer != null) danmakuLayer.setVisibility(View.VISIBLE);
        if (seekBar != null) seekBar.setVisibility(View.GONE);
        if (back10View != null) back10View.setVisibility(View.GONE);
        if (fwd10View != null) fwd10View.setVisibility(View.GONE);
        if (speedView != null) speedView.setVisibility(View.GONE);
        if (episodeView != null) episodeView.setVisibility(View.GONE);
        if (epPrevView != null) epPrevView.setVisibility(View.GONE);
        if (epNextView != null) epNextView.setVisibility(View.GONE);
        // 直播也会卡顿/断流，保留「换线 / 线路」入口，不用退回列表重开
        if (switchLineView != null) switchLineView.setVisibility(View.VISIBLE);
        if (linesView != null) linesView.setVisibility(View.VISIBLE);
        if (liveBadge != null) liveBadge.setVisibility(View.VISIBLE);
        // 时间文本在直播下没有意义，隐藏掉避免出现「直播 ● LIVE」的重复感
        if (timeView != null) timeView.setVisibility(View.GONE);
        if (fillToggle != null) {
            fillToggle.setVisibility(View.VISIBLE);
            fillToggle.setText(fillMode ? "铺满" : "完整");
        }
        if (orientationToggle != null) {
            orientationToggle.setVisibility(View.VISIBLE);
            orientationToggle.setText(isLandscapeNow() ? "竖屏" : "横屏");
        }
        if (danmakuToggle != null) {
            danmakuToggle.setVisibility(
                LiveDanmakuClient.supported(danmakuPlatform) ? View.VISIBLE : View.GONE
            );
        }
    }

    private boolean isLandscapeNow() {
        return getResources().getConfiguration().orientation
            == Configuration.ORIENTATION_LANDSCAPE;
    }

    // ── 直播弹幕 ────────────────────────────────────────

    private void setupLiveDanmaku(Intent intent) {
        stopDanmaku();
        if (!liveMode) {
            if (danmakuLayer != null) danmakuLayer.setDanmakuEnabled(false);
            return;
        }

        danmakuPlatform = intent.hasExtra(EXTRA_DANMAKU_PLATFORM)
            ? safe(intent.getStringExtra(EXTRA_DANMAKU_PLATFORM))
            : sessionDanmakuPlatform;
        danmakuRoom = intent.hasExtra(EXTRA_DANMAKU_ROOM)
            ? safe(intent.getStringExtra(EXTRA_DANMAKU_ROOM))
            : sessionDanmakuRoom;
        boolean defaultOn = intent.hasExtra(EXTRA_DANMAKU)
            ? intent.getBooleanExtra(EXTRA_DANMAKU, true)
            : sessionDanmakuOn;
        sessionDanmakuPlatform = danmakuPlatform;
        sessionDanmakuRoom = danmakuRoom;

        boolean supported = LiveDanmakuClient.supported(danmakuPlatform)
            && !danmakuRoom.isEmpty();
        danmakuOn = supported
            && defaultOn
            && getSharedPreferences(PREFS_QUALITY, MODE_PRIVATE)
                .getBoolean(KEY_LIVE_DANMAKU, true);
        sessionDanmakuOn = danmakuOn;

        if (!supported) {
            if (danmakuToggle != null) danmakuToggle.setVisibility(View.GONE);
            return;
        }

        ensureDanmakuLayer();
        danmakuLayer.setDanmakuEnabled(danmakuOn);
        if (danmakuToggle != null) {
            danmakuToggle.setVisibility(View.VISIBLE);
            danmakuToggle.setText(danmakuOn ? "弹幕开" : "弹幕关");
        }
        if (danmakuOn) startDanmaku();
    }

    /** 弹幕层插在手势层之下、海报之上：不挡点击，也不会被首帧海报永久盖住 */
    private void ensureDanmakuLayer() {
        if (danmakuLayer != null && danmakuLayer.getParent() == root) return;
        if (root == null) return;

        danmakuLayer = new DanmakuLayer(this);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        );
        lp.topMargin = dp(52);
        lp.bottomMargin = dp(86);
        int index = gestureLayer != null ? root.indexOfChild(gestureLayer) : -1;
        if (index < 0) root.addView(danmakuLayer, lp);
        else root.addView(danmakuLayer, index, lp);
    }

    private void startDanmaku() {
        if (danmakuClient != null || !danmakuOn) return;
        if (!LiveDanmakuClient.supported(danmakuPlatform) || danmakuRoom.isEmpty()) return;
        danmakuClient = new LiveDanmakuClient(
            danmakuPlatform,
            danmakuRoom,
            (text, name) -> {
                if (danmakuLayer != null && danmakuOn) danmakuLayer.push(text, name);
            }
        );
        danmakuClient.start();
    }

    private void stopDanmaku() {
        if (danmakuClient != null) {
            danmakuClient.stop();
            danmakuClient = null;
        }
    }

    /** 插件侧调用：播放中开关弹幕 */
    public void setDanmakuEnabled(boolean on) {
        if (!LiveDanmakuClient.supported(danmakuPlatform)) return;
        danmakuOn = on;
        sessionDanmakuOn = on;
        getSharedPreferences(PREFS_QUALITY, MODE_PRIVATE)
            .edit().putBoolean(KEY_LIVE_DANMAKU, on).apply();
        if (danmakuToggle != null) danmakuToggle.setText(on ? "弹幕开" : "弹幕关");
        if (danmakuLayer != null) danmakuLayer.setDanmakuEnabled(on);
        if (on) startDanmaku();
        else stopDanmaku();
    }

    private void toggleOrientation() {
        boolean landscape = isLandscapeNow();
        setRequestedOrientation(
            landscape
                ? ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                : ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        );
        if (orientationToggle != null) orientationToggle.setText(landscape ? "横屏" : "竖屏");
        uiHandler.postDelayed(
            () -> {
                if (orientationToggle != null) {
                    orientationToggle.setText(isLandscapeNow() ? "竖屏" : "横屏");
                }
            },
            600L
        );
    }

    private static String safe(String s) {
        return s == null ? "" : s;
    }

    private Map<String, String> parseHeaders(String headersJson) {
        Map<String, String> headers = new HashMap<>();
        if (headersJson == null || headersJson.isEmpty()) return headers;
        try {
            JSObject h = new JSObject(headersJson);
            java.util.Iterator<String> it = h.keys();
            while (it.hasNext()) {
                String k = it.next();
                Object v = h.get(k);
                if (v != null) headers.put(k, String.valueOf(v));
            }
        } catch (Exception ignored) {
            /* 头解析失败时按无自定义头处理 */
        }
        return headers;
    }

    private void startPlayback(String url, Map<String, String> headers, String title, long startPos) {
        if (titleView != null) {
            String text = title;
            if (episodes.size() > 1) {
                text = title + " · 第 " + currentEpisode + " 集";
            }
            titleView.setText(text);
        }
        sessionUrl = url;
        sessionTitle = title;
        sessionHeaders = toJson(headers);
        // 换集后「上一集 / 下一集」边界会变，重算按钮显隐
        syncEpisodeUi();

        releasePlayer();

        // 每次起播/换线都重置诊断状态，避免沿用上一条线的结论
        firstFrameRendered = false;
        videoTrackCount = 0;
        audioTrackCount = 0;
        videoMime = "";
        videoSizeW = 0;
        videoSizeH = 0;
        playerState = Player.STATE_IDLE;
        startedAt = SystemClock.elapsedRealtime();
        resumeHintShown = false;
        introSkipped = false;
        outroTriggered = false;
        refreshStatus();
        setLoading(true);

        Logger.info("[PlayerActivity] 开始播放: " + url);
        ExoPlayer p = buildPlayer(headers);
        player = p;
        if (playerView != null) playerView.setPlayer(p);
        attachListeners(p);

        p.setMediaItem(buildMediaItem(url));
        if (startPos > 0) p.seekTo(startPos);
        p.prepare();
        p.setPlayWhenReady(true);
        p.setPlaybackParameters(new PlaybackParameters(speed));
        if (startPos > 3000) {
            resumeHintShown = true;
            showHint("继续观看 · " + fmt(startPos), 2400);
        }
        setControlsVisible(true);
        updateCastLabel();
        scheduleHide();
        scheduleAutoPreload();
    }

    /** 起播稳定后，用地址表把下一集先缓冲好（前端没预加载时兜底） */
    private void scheduleAutoPreload() {
        uiHandler.removeCallbacks(autoPreloadRunnable);
        if (episodeUrlMap.size() <= 1) return;
        uiHandler.postDelayed(autoPreloadRunnable, 4000L);
    }

    /** 统一的 MediaItem 构造（起播与预加载共用） */
    private MediaItem buildMediaItem(String url) {
        MediaItem.Builder itemBuilder = new MediaItem.Builder().setUri(url);
        if (url.contains(".m3u8")) {
            itemBuilder.setMimeType(MimeTypes.APPLICATION_M3U8);
        } else if (url.contains(".mpd")) {
            itemBuilder.setMimeType(MimeTypes.APPLICATION_MPD);
        } else if (url.contains(".mp4")) {
            itemBuilder.setMimeType(MimeTypes.VIDEO_MP4);
        }
        if (liveMode) {
            /*
             * 直播延迟补偿
             *
             * ExoPlayer 对没有 LiveConfiguration 的直播流不做播放速度微调，
             * 网络一抖动播放点就往后掉，看十几分钟能攒出十几秒延迟。
             * 这里给 2.5 秒目标延迟 + 0.96~1.08 倍微调，让播放器自己追上直播边缘。
             */
            itemBuilder.setLiveConfiguration(
                new MediaItem.LiveConfiguration.Builder()
                    .setTargetOffsetMs(2500)
                    .setMinPlaybackSpeed(0.96f)
                    .setMaxPlaybackSpeed(1.08f)
                    .build()
            );
        }
        // 外挂字幕：file:// 走 ExoPlayer 内置的 FileDataSource，不额外申请存储权限
        if (!subtitleUri.isEmpty()) {
            try {
                MediaItem.SubtitleConfiguration sub =
                    new MediaItem.SubtitleConfiguration.Builder(Uri.parse(
                        subtitleUri.startsWith("file://") || subtitleUri.startsWith("http")
                            ? subtitleUri
                            : "file://" + subtitleUri
                    ))
                        .setMimeType(subtitleMime.isEmpty()
                            ? MimeTypes.APPLICATION_SUBRIP : subtitleMime)
                        .setLanguage("und")
                        .setSelectionFlags(C.SELECTION_FLAG_DEFAULT)
                        .build();
                itemBuilder.setSubtitleConfigurations(Collections.singletonList(sub));
            } catch (Exception e) {
                Logger.error("[PlayerActivity] 字幕挂载失败: " + e.getMessage());
            }
        }
        return itemBuilder.build();
    }

    private String toJson(Map<String, String> headers) {
        JSObject o = new JSObject();
        for (Map.Entry<String, String> e : headers.entrySet()) {
            o.put(e.getKey(), e.getValue());
        }
        return o.toString();
    }

    private ExoPlayer buildPlayer(Map<String, String> headers) {
        DefaultHttpDataSource.Factory httpFactory = new DefaultHttpDataSource.Factory()
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(15000)
            .setReadTimeoutMs(20000)
            .setUserAgent(
                "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"
            );
        if (!headers.isEmpty()) {
            httpFactory.setDefaultRequestProperties(headers);
        }
        DataSource.Factory dsFactory = httpFactory;
        DefaultMediaSourceFactory msFactory = new DefaultMediaSourceFactory(dsFactory);
        ExoPlayer p = new ExoPlayer.Builder(this).setMediaSourceFactory(msFactory).build();
        // 音频焦点：来电、其他应用起播时自动让出；拔耳机/断开蓝牙时暂停
        p.setAudioAttributes(
            new AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                .build(),
            true
        );
        p.setHandleAudioBecomingNoisy(true);
        if (!subtitleEnabled) {
            // 字幕开关在起播前就关着时，直接禁用文本轨
            p.setTrackSelectionParameters(
                p.getTrackSelectionParameters()
                    .buildUpon()
                    .setDisabledTrackTypes(Collections.singleton(C.TRACK_TYPE_TEXT))
                    .build()
            );
        }
        // 音效在音频会话建立后由 onAudioSessionIdChanged 挂载：
        // 这里不挂，避免预加载实例（静音）抢走 audio session
        applyQualityLimit(p);
        return p;
    }

    // ── 画质切换 ────────────────────────────────────────

    /** 当前线路可选的视频高度（去重、从高到低） */
    private List<Integer> qualityOptions() {
        java.util.TreeSet<Integer> set =
            new java.util.TreeSet<>(java.util.Collections.reverseOrder());
        if (player != null) {
            for (androidx.media3.common.Tracks.Group g : player.getCurrentTracks().getGroups()) {
                if (g.getType() != C.TRACK_TYPE_VIDEO) continue;
                for (int i = 0; i < g.length; i++) {
                    int h = g.getTrackFormat(i).height;
                    if (h > 0) set.add(h);
                }
            }
        }
        return new ArrayList<>(set);
    }

    /** 按当前选择限制视频轨道高度；自动模式恢复默认（不设上限） */
    private void applyQualityLimit(ExoPlayer p) {
        if (p == null) return;
        androidx.media3.common.TrackSelectionParameters.Builder b =
            p.getTrackSelectionParameters().buildUpon();
        // 自动模式恢复不设上限，否则按所选高度封顶
        b.setMaxVideoSize(Integer.MAX_VALUE, qualityHeight > 0 ? qualityHeight : Integer.MAX_VALUE);
        p.setTrackSelectionParameters(b.build());
    }

    /** 画质按钮：只有多码率线路才出现，文案显示当前选择 */
    private void updateQualityLabel() {
        if (qualityButton == null) return;
        if (qualityOptions().size() < 2) {
            qualityButton.setVisibility(View.GONE);
            return;
        }
        qualityButton.setVisibility(View.VISIBLE);
        qualityButton.setText(qualityHeight > 0 ? qualityHeight + "P" : "画质");
        qualityButton.setTextColor(qualityHeight > 0 ? MINT : 0xE6FFFFFF);
    }

    private void toggleQualityPanel() {
        if (qualityPanelOpen) {
            closeQualityPanel();
            return;
        }
        List<Integer> opts = qualityOptions();
        if (opts.isEmpty()) {
            showHint("当前线路不支持画质切换", 1600);
            return;
        }
        showQualityPanel(opts);
    }

    private void showQualityPanel(List<Integer> opts) {
        if (qualityPanel != null) {
            root.removeView(qualityPanel);
            qualityPanel = null;
        }
        qualityPanel = buildQualityPanel(opts);
        root.addView(
            qualityPanel,
            new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        );
        qualityPanelOpen = true;
        uiHandler.removeCallbacks(hideRunnable);
        setControlsVisible(true);
    }

    private void closeQualityPanel() {
        if (qualityPanel != null) {
            root.removeView(qualityPanel);
            qualityPanel = null;
        }
        qualityPanelOpen = false;
        scheduleHide();
    }

    private FrameLayout buildQualityPanel(List<Integer> opts) {
        FrameLayout panel = new FrameLayout(this);
        panel.setBackgroundColor(0xD9080A0A);
        panel.setOnClickListener(v -> closeQualityPanel());

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(20), dp(16), dp(20), dp(16));
        box.setBackground(rounded(0xFF141818, dp(18)));
        box.setOnClickListener(v -> { /* 拦住点击，避免穿透关闭 */ });

        FrameLayout.LayoutParams boxLp = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        boxLp.gravity = Gravity.CENTER;
        boxLp.setMargins(dp(80), dp(20), dp(80), dp(20));
        panel.addView(box, boxLp);

        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(Gravity.CENTER_VERTICAL);
        head.setPadding(0, 0, 0, dp(10));

        TextView title = makeText("画质", 16, Color.WHITE);
        head.addView(
            title,
            new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        );

        TextView close = makeText("×", 24, 0xFFB9C0BD);
        close.setGravity(Gravity.CENTER);
        close.setPadding(dp(16), 0, dp(6), 0);
        close.setOnClickListener(v -> closeQualityPanel());
        head.addView(
            close,
            new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        );
        box.addView(head);

        LinearLayout list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        addQualityRow(list, "自动（推荐）", 0);
        for (Integer h : opts) addQualityRow(list, h + "P", h);
        box.addView(list);

        return panel;
    }

    private void addQualityRow(LinearLayout list, String label, int height) {
        boolean on = qualityHeight == height;
        TextView item = makeText(label, 13, on ? 0xFF0B1210 : Color.WHITE);
        item.setGravity(Gravity.CENTER_VERTICAL);
        item.setPadding(dp(18), dp(10), dp(18), dp(10));
        item.setBackground(rounded(on ? MINT : 0xFF1E2422, dp(10)));
        item.setOnClickListener(v -> {
            qualityHeight = height;
            getSharedPreferences(PREFS_QUALITY, MODE_PRIVATE)
                .edit()
                .putInt(KEY_QUALITY_HEIGHT, height)
                .apply();
            applyQualityLimit(player);
            closeQualityPanel();
            showHint(height == 0 ? "画质：自动" : "画质：" + height + "P", 1500);
            updateQualityLabel();
        });

        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
            dp(180),
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        lp.bottomMargin = dp(6);
        list.addView(item, lp);
    }

    private void attachListeners(ExoPlayer p) {
        p.addListener(
            new Player.Listener() {
                @Override
                public void onPlaybackStateChanged(int state) {
                    Logger.info("[PlayerActivity] 播放状态: " + state);
                    playerState = state;
                    refreshStatus();
                    switch (state) {
                        case Player.STATE_BUFFERING:
                            emitState("buffering");
                            setLoading(true);
                            break;
                        case Player.STATE_READY:
                            emitState("playing");
                            setLoading(false);
                            break;
                        case Player.STATE_ENDED:
                            emitState("ended");
                            setLoading(false);
                            onEndedAutoNext();
                            break;
                        case Player.STATE_IDLE:
                            emitState("idle");
                            setLoading(false);
                            break;
                        default:
                            break;
                    }
                }

                @Override
                public void onIsPlayingChanged(boolean isPlaying) {
                    if (isPlaying) emitState("playing");
                }

                /** 音频会话建立后把音效挂上去（换集重建播放器会换会话号） */
                @Override
                public void onAudioSessionIdChanged(int audioSessionId) {
                    audioFx.attach(audioSessionId);
                }

                @Override
                public void onTracksChanged(androidx.media3.common.Tracks tracks) {
                    int video = 0;
                    int audio = 0;
                    String mime = "";
                    for (androidx.media3.common.Tracks.Group g : tracks.getGroups()) {
                        if (g.getType() == androidx.media3.common.C.TRACK_TYPE_VIDEO) {
                            video += g.length;
                            if (g.isSelected()) {
                                String m = g.getTrackFormat(0).sampleMimeType;
                                if (m != null && !m.isEmpty()) mime = m;
                            }
                        }
                        if (g.getType() == androidx.media3.common.C.TRACK_TYPE_AUDIO) audio += g.length;
                    }
                    videoTrackCount = video;
                    audioTrackCount = audio;
                    videoMime = mime;
                    updateQualityLabel();
                    Logger.info(
                        "[PlayerActivity] 轨道: video=" + video + " audio=" + audio +
                        (mime.isEmpty() ? "" : " mime=" + mime)
                    );
                    refreshStatus();
                }

                @Override
                public void onRenderedFirstFrame() {
                    Logger.info("[PlayerActivity] 首帧已渲染");
                    firstFrameRendered = true;
                    fadeOutPoster();
                    setLoading(false);
                    refreshStatus();

                    /**
                     * 片头跳过
                     *
                     * 只在「几乎从头起播」时生效（<5 秒）：
                     * 断点续播时用户可能就停在片头里，跳过去反而丢进度。
                     */
                    if (!introSkipped && skipIntroMs > 0 && player != null
                        && player.getCurrentPosition() < 5000L) {
                        introSkipped = true;
                        player.seekTo(skipIntroMs);
                        showHint("已跳过片头 " + (skipIntroMs / 1000) + " 秒", 1600);
                    }

                    NativePlayerPlugin.emitFromNative("firstFrame", new JSObject());
                    if (player != null) {
                        VideoSize vs = player.getVideoSize();
                        if (vs.width > 0 && vs.height > 0) {
                            JSObject o = new JSObject();
                            o.put("width", vs.width);
                            o.put("height", vs.height);
                            o.put("pixelAspectRatio", (double) vs.width / (double) vs.height);
                            NativePlayerPlugin.emitFromNative("videoSize", o);
                        }
                    }
                }

                @Override
                public void onVideoSizeChanged(VideoSize size) {
                    videoSizeW = size.width;
                    videoSizeH = size.height;
                    refreshStatus();
                    JSObject o = new JSObject();
                    o.put("width", size.width);
                    o.put("height", size.height);
                    if (size.width > 0 && size.height > 0) {
                        o.put("pixelAspectRatio", (double) size.width / (double) size.height);
                    }
                    NativePlayerPlugin.emitFromNative("videoSize", o);
                }

                @Override
                public void onPlayerError(PlaybackException error) {
                    Logger.error(
                        "[PlayerActivity] 播放错误: " + error.getErrorCodeName() + " " + error.getMessage()
                    );
                    setLoading(false);
                    if (statusView != null) {
                        statusView.setText("播放失败：" + error.getErrorCodeName());
                        statusView.setVisibility(View.VISIBLE);
                    }
                    JSObject o = new JSObject();
                    o.put("state", "error");
                    o.put("message", error.getErrorCodeName() + ": " + error.getMessage());
                    NativePlayerPlugin.emitFromNative("stateChange", o);
                }
            }
        );
    }

    /**
     * 播完自动下一集
     *
     * 优先走「预加载直接接管」：下一集已经在后台缓冲好，切过去几乎无等待。
     * 没有预加载（例如前端没来得及解析出下一集）时，仍把集号交回前端重新起播。
     */
    private void onEndedAutoNext() {
        if (!autoNextEnabled) {
            showHint("播放结束", 2000);
            return;
        }
        if (swapToPreload()) return;

        int next = nextEpisode();
        if (next <= 0) {
            showHint("播放结束", 2000);
            return;
        }

        /**
         * 有整季地址 → 本进程直接续播
         *
         * 之前这里只把集号发给前端，由前端重新解析再起播：
         * 一旦解析失败或事件没回传，画面就停在上一集，用户完全无感。
         */
        String url = episodeUrl(next);
        if (url != null) {
            showHint("即将播放第 " + next + " 集", 1200);
            final String target = url;
            uiHandler.post(() -> {
                if (isFinishing() || isDestroyed()) return;
                currentEpisode = next;
                sessionEpisode = next;
                startPlayback(target, parseHeaders(sessionHeaders), sessionTitle, 0L);
                JSObject o = new JSObject();
                o.put("episode", next);
                o.put("auto", true);
                o.put("preloaded", false);
                NativePlayerPlugin.emitFromNative("nativeAutoAdvanced", o);
            });
            return;
        }

        // 没有地址表 → 交回前端重新解析
        showHint("即将播放第 " + next + " 集", 2500);
        uiHandler.postDelayed(() -> {
            if (isFinishing() || isDestroyed()) return;
            JSObject o = new JSObject();
            o.put("episode", next);
            o.put("auto", true);
            o.put("handled", false);
            NativePlayerPlugin.emitFromNative("nativeEpisode", o);
        }, 1500);
    }

    /**
     * 用预加载实例接管播放
     *
     * 预加载实例已经缓冲了一段数据，直接挂到 PlayerView 上继续播，
     * 比重新建连 + 解析清单快得多。接管后通知前端同步集数（但不重新起播）。
     */
    private boolean swapToPreload() {
        ExoPlayer np = preloadPlayer;
        if (np == null) return false;
        if (np.getPlayerError() != null || np.getPlaybackState() == Player.STATE_IDLE) {
            releasePreload();
            return false;
        }

        String url = preloadUrl;
        String headerJson = preloadHeaders;
        String title = preloadTitle;
        int ep = preloadEpisode;

        // 先摘掉引用，避免 releasePlayer() 把即将接管的实例也释放掉
        preloadPlayer = null;
        preloadUrl = "";
        releasePlayer();

        player = np;
        playerState = Player.STATE_BUFFERING;
        firstFrameRendered = false;
        startedAt = SystemClock.elapsedRealtime();
        resumeHintShown = true;
        currentEpisode = ep;
        sessionEpisode = ep;
        applyQualityLimit(np);
        syncEpisodeUi();
        sessionUrl = url;
        sessionHeaders = headerJson;
        sessionPosition = 0L;

        attachListeners(np);
        if (playerView != null) playerView.setPlayer(np);
        np.setVolume(1f);
        np.setPlayWhenReady(true);
        np.setPlaybackParameters(new PlaybackParameters(speed));

        if (titleView != null) {
            String text = title;
            if (episodes.size() > 1) text = title + " · 第 " + ep + " 集";
            titleView.setText(text);
        }
        refreshStatus();
        setLoading(true);
        showHint("继续播放第 " + ep + " 集", 1600);
        setControlsVisible(true);
        scheduleHide();

        JSObject o = new JSObject();
        o.put("episode", ep);
        o.put("auto", true);
        o.put("preloaded", true);
        NativePlayerPlugin.emitFromNative("nativeAutoAdvanced", o);
        Logger.info("[PlayerActivity] 预加载接管第 " + ep + " 集: " + url);
        return true;
    }

    private void emitState(String state) {
        JSObject o = new JSObject();
        o.put("state", state);
        o.put("position", player == null ? 0L : player.getCurrentPosition());
        o.put("duration", player == null ? 0L : player.getDuration());
        NativePlayerPlugin.emitFromNative("stateChange", o);
    }

    /**
     * 刷新底部状态文本
     *
     * 把「视频轨 / 分辨率 / 编码 / 首帧 / surface」一并显示出来 ——
     * 用户截一张图就能判断是有声无画卡在解码、渲染，还是源本身没有视频轨。
     */
    private void refreshStatus() {
        if (statusView == null) return;
        StringBuilder sb = new StringBuilder();
        switch (playerState) {
            case Player.STATE_BUFFERING:
                sb.append("缓冲中…");
                break;
            case Player.STATE_READY:
                sb.append("播放中");
                break;
            case Player.STATE_ENDED:
                sb.append("播放结束");
                break;
            default:
                sb.append("正在连接…");
                break;
        }
        if (playerState == Player.STATE_READY) {
            if (videoTrackCount == 0) {
                sb.append(audioTrackCount > 0 ? " · 仅音频（无视频轨）" : " · 无轨道");
            } else {
                if (!videoMime.isEmpty()) sb.append(" · ").append(videoMime);
                if (videoSizeW > 0 && videoSizeH > 0) {
                    sb.append(" · ").append(videoSizeW).append("×").append(videoSizeH);
                }
                sb.append(firstFrameRendered ? " · 首帧OK" : " · 未出画");
                sb.append(surfaceSummary());
            }
        }
        String ver = NativePlayerPlugin.appVersionLabel(this);
        if (!ver.isEmpty()) sb.append(" · v").append(ver);
        statusView.setText(sb.toString());
        // 正常播放时收起诊断行，只在异常（缓冲/仅音频/无轨道/失败）时显示，
        // 既保持界面干净，又保留排障能力
        boolean abnormal = playerState != Player.STATE_READY || videoTrackCount == 0;
        statusView.setVisibility(abnormal ? View.VISIBLE : View.GONE);
    }

    private String surfaceSummary() {
        if (playerView == null) return "";
        View sv = playerView.getVideoSurfaceView();
        if (sv == null) return " · 无画面视图";
        String type = sv instanceof android.view.SurfaceView ? "SV" : sv.getClass().getSimpleName();
        return " · " + type + " " + sv.getWidth() + "×" + sv.getHeight()
            + " · act";
    }

    private void releasePlayer() {
        audioFx.release();
        if (playerView != null && player != null) {
            try {
                playerView.setPlayer(null);
            } catch (Exception ignored) {
                /* ignore */
            }
        }
        if (player != null) {
            try {
                player.release();
            } catch (Exception ignored) {
                /* ignore */
            }
            player = null;
        }
        releasePreload();
    }

    /** 释放预加载实例（换集 / 换线 / 关闭界面时都要清掉，避免后台继续跑） */
    private void releasePreload() {
        if (preloadPlayer != null) {
            try {
                preloadPlayer.release();
            } catch (Exception ignored) {
                /* ignore */
            }
            preloadPlayer = null;
        }
        preloadUrl = "";
        preloadHeaders = "";
        preloadTitle = "";
        preloadEpisode = -1;
    }
}
