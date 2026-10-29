package com.sobertv.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.os.Build;
import android.view.WindowManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/**
 * 原生播放器插件（控制器）
 *
 * ── 职责 ──────────────────────────────────────────────
 *   只做「前端 ↔ 播放界面」的转发：起播、暂停、拖动、换线、显隐、诊断。
 *   真正的播放与界面在 {@link PlayerActivity}。
 *
 * ── 为什么不再用 Dialog 承载画面 ────────────────────────
 *   v1.7.3 ~ v1.7.6 连续四版都是「有声音、画面全黑」，四种承载方式
 *   （手写 TextureView / PlayerView+TextureView / PlayerView+SurfaceView /
 *   SurfaceView+ZOrderOnTop+双窗口）结果一致。共同点是画面放在 Dialog 里：
 *   Dialog 属于 sub-window，部分 ROM 不为下层 surface 开透明区（punch hole
 *   不生效），窗口自己的黑底就把画面盖住了。
 *   换成独立 Activity 后走的是应用主窗口的标准合成路径。
 */
@CapacitorPlugin(name = "NativePlayer")
public class NativePlayerPlugin extends BasePlugin {

    /** 插件实例（供播放界面回传事件） */
    private static NativePlayerPlugin instance;

    /** 画面填充模式：true = 铺满裁切（cover），false = 完整显示（contain） */
    private boolean fillMode = true;

    @Override
    public void load() {
        super.load();
        instance = this;
        Logger.info("[NativePlayer] 插件已加载");
    }

    /** 播放界面 → 前端事件 */
    static void emitFromNative(String event, JSObject data) {
        NativePlayerPlugin p = instance;
        if (p == null) return;
        try {
            p.notifyListeners(event, data);
        } catch (Exception e) {
            Logger.error("[NativePlayer] 事件转发失败: " + event + " " + e.getMessage());
        }
    }

    /** 读取安装包版本号（状态栏与诊断页共用） */
    static String appVersionLabel(Context ctx) {
        if (ctx == null) return "";
        try {
            PackageInfo info = ctx.getPackageManager()
                .getPackageInfo(ctx.getPackageName(), 0);
            return info.versionName == null ? "" : info.versionName;
        } catch (Exception e) {
            return "";
        }
    }

    // ── 起播 ────────────────────────────────────────────

    @PluginMethod
    public void prepare(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void play(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("缺少播放地址");
            return;
        }
        String headers = call.getString("headers", "");
        String title = call.getString("title", "");
        String episodes = call.getString("episodes", "");
        String episodeUrls = call.getString("episodeUrls", "");
        Integer episode = call.getInt("episode", 1);
        Double skipIntroSec = call.getDouble("skipIntroSec", 0.0);
        Double skipOutroSec = call.getDouble("skipOutroSec", 0.0);
        Boolean autoNext = call.getBoolean("autoNext", true);
        Boolean live = call.getBoolean("live", false);
        String poster = call.getString("poster", "");
        String subtitleText = call.getString("subtitleText", "");
        String subtitleMime = call.getString("subtitleMime", "");
        String danmakuPlatform = call.getString("danmakuPlatform", "");
        String danmakuRoom = call.getString("danmakuRoom", "");
        Boolean danmakuOn = call.getBoolean("danmakuOn", true);
        // fill 不传时由原生侧按「直播 = 完整显示 / 点播 = 上次偏好」决定
        Boolean fill = call.getBoolean("fill", null);
        if (fill != null) fillMode = fill;

        final String subPath = writeSubtitleFile(subtitleText, subtitleMime);

        runOnUi(() -> {
            try {
                Intent intent = new Intent(getContext(), PlayerActivity.class);
                intent.putExtra(PlayerActivity.EXTRA_URL, url);
                intent.putExtra(PlayerActivity.EXTRA_TITLE, title == null ? "" : title);
                intent.putExtra(PlayerActivity.EXTRA_HEADERS, headers == null ? "" : headers);
                if (fill != null) intent.putExtra(PlayerActivity.EXTRA_FILL, fill.booleanValue());
                intent.putExtra(PlayerActivity.EXTRA_POSITION, 0L);
                intent.putExtra(PlayerActivity.EXTRA_EPISODES, episodes == null ? "" : episodes);
                intent.putExtra(PlayerActivity.EXTRA_EPISODE_URLS, episodeUrls == null ? "" : episodeUrls);
                intent.putExtra(PlayerActivity.EXTRA_EPISODE, episode == null ? 1 : episode);
                intent.putExtra(PlayerActivity.EXTRA_SKIP_INTRO, skipIntroSec == null ? 0.0 : skipIntroSec);
                intent.putExtra(PlayerActivity.EXTRA_SKIP_OUTRO, skipOutroSec == null ? 0.0 : skipOutroSec);
                intent.putExtra(PlayerActivity.EXTRA_AUTO_NEXT, autoNext == null || autoNext);
                intent.putExtra(PlayerActivity.EXTRA_LIVE, live != null && live);
                intent.putExtra(PlayerActivity.EXTRA_POSTER, poster == null ? "" : poster);
                intent.putExtra(PlayerActivity.EXTRA_DANMAKU_PLATFORM,
                    danmakuPlatform == null ? "" : danmakuPlatform);
                intent.putExtra(PlayerActivity.EXTRA_DANMAKU_ROOM,
                    danmakuRoom == null ? "" : danmakuRoom);
                intent.putExtra(PlayerActivity.EXTRA_DANMAKU, danmakuOn == null || danmakuOn);
                if (!subPath.isEmpty()) {
                    intent.putExtra(PlayerActivity.EXTRA_SUBTITLE_PATH, subPath);
                    intent.putExtra(PlayerActivity.EXTRA_SUBTITLE_MIME,
                        subtitleMime == null ? "" : subtitleMime);
                }
                intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);

                PlayerActivity a = PlayerActivity.get();
                if (a != null) {
                    a.openIntent(intent);
                } else {
                    getContext().startActivity(intent);
                }
                call.resolve();
            } catch (Exception e) {
                Logger.error("[NativePlayer] 启动播放界面失败: " + e.getMessage());
                call.reject("启动播放界面失败: " + e.getMessage());
            }
        });
    }

    /**
     * 把字幕文本落到应用缓存目录
     *
     * 为什么不直接把文本塞进 Intent：字幕动辄几百 KB，
     * Intent extra 受 Binder 1MB 事务上限约束，超了会直接崩在 startActivity。
     * 写文件后只传路径，稳定且不影响起播速度。
     */
    private String writeSubtitleFile(String text, String mime) {
        if (text == null || text.trim().isEmpty()) return "";
        try {
            File dir = new File(getContext().getCacheDir(), "subtitles");
            if (!dir.exists() && !dir.mkdirs()) return "";
            File[] old = dir.listFiles();
            if (old != null) {
                for (File f : old) f.delete();
            }
            String ext = (mime != null && mime.contains("vtt")) ? ".vtt" : ".srt";
            File f = new File(dir, "current" + ext);
            FileOutputStream fos = new FileOutputStream(f);
            fos.write(text.getBytes(StandardCharsets.UTF_8));
            fos.close();
            return f.getAbsolutePath();
        } catch (Exception e) {
            Logger.error("[NativePlayer] 字幕写入失败: " + e.getMessage());
            return "";
        }
    }

    // ── 字幕 ────────────────────────────────────────────

    @PluginMethod
    public void setSubtitle(PluginCall call) {
        String text = call.getString("text", "");
        String mime = call.getString("mime", "");
        final String path = writeSubtitleFile(text, mime);
        runOnUi(() -> {
            PlayerActivity a = PlayerActivity.get();
            if (a != null) a.applySubtitle(path, mime == null ? "" : mime);
            call.resolve();
        });
    }

    @PluginMethod
    public void clearSubtitle(PluginCall call) {
        runOnUi(() -> {
            PlayerActivity a = PlayerActivity.get();
            if (a != null) a.clearSubtitle();
            call.resolve();
        });
    }

    @PluginMethod
    public void setSubtitleEnabled(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled", true);
        boolean on = enabled == null || enabled;
        runOnUi(() -> {
            PlayerActivity a = PlayerActivity.get();
            if (a != null) a.setSubtitleEnabled(on);
            call.resolve();
        });
    }

    // ── 音效 ────────────────────────────────────────────

    @PluginMethod
    public void setAudioEffect(PluginCall call) {
        String mode = call.getString("mode", "off");
        runOnUi(() -> {
            PlayerActivity a = PlayerActivity.get();
            if (a != null) a.setAudioEffect(mode);
            call.resolve();
        });
    }

    @PluginMethod
    public void getAudioEffect(PluginCall call) {
        runOnUi(() -> {
            PlayerActivity a = PlayerActivity.get();
            JSObject ret = new JSObject();
            ret.put("mode", a != null ? a.audioEffectMode() : "off");
            call.resolve(ret);
        });
    }

    // ── 播放控制 ────────────────────────────────────────

    @PluginMethod
    public void pause(PluginCall call) {
        runOnUi(() -> {
            PlayerActivity a = PlayerActivity.get();
            if (a != null) a.doPause();
            call.resolve();
        });
    }

    @PluginMethod
    public void resume(PluginCall call) {
        runOnUi(() -> {
            PlayerActivity a = PlayerActivity.get();
            if (a != null) a.doResume();
            call.resolve();
        });
    }

    @PluginMethod
    public void seek(PluginCall call) {
        Long position = call.getLong("position", 0L);
        runOnUi(() -> {
            PlayerActivity a = PlayerActivity.get();
            if (a != null) a.doSeek(position == null ? 0L : position);
            call.resolve();
        });
    }

    @PluginMethod
    public void getPosition(PluginCall call) {
        runOnUi(() -> {
            PlayerActivity a = PlayerActivity.get();
            JSObject ret = new JSObject();
            ret.put("position", a != null ? a.positionMs() : 0L);
            ret.put("duration", a != null ? a.durationMs() : 0L);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void setPlaybackSpeed(PluginCall call) {
        Double speed = call.getDouble("speed", 1.0);
        runOnUi(() -> {
            PlayerActivity a = PlayerActivity.get();
            if (a != null) a.doSetSpeed((float) (speed == null ? 1.0 : speed));
            call.resolve();
        });
    }

    @PluginMethod
    public void setFillMode(PluginCall call) {
        Boolean fill = call.getBoolean("fill", true);
        boolean f = fill == null || fill;
        fillMode = f;
        PlayerActivity.rememberFill(f);
        runOnUi(() -> {
            PlayerActivity a = PlayerActivity.get();
            if (a != null) a.applyFillMode(f);
            call.resolve();
        });
    }

    // ── 显隐 / 销毁 ─────────────────────────────────────

    /**
     * 隐藏播放界面（线路面板 / 选集面板要用 WebView）
     *
     * Activity 无法像 Dialog 那样只隐藏窗口，这里关闭界面并记住进度，
     * show() 时会从原位接着播。
     */
    @PluginMethod
    public void hide(PluginCall call) {
        runOnUi(() -> {
            PlayerActivity a = PlayerActivity.get();
            if (a != null) a.closeSelf();
            call.resolve();
        });
    }

    @PluginMethod
    public void show(PluginCall call) {
        runOnUi(() -> {
            try {
                if (PlayerActivity.get() != null) {
                    call.resolve();
                    return;
                }
                String url = PlayerActivity.sessionUrl();
                if (url == null || url.isEmpty()) {
                    call.resolve();
                    return;
                }
                Intent intent = new Intent(getContext(), PlayerActivity.class);
                intent.putExtra(PlayerActivity.EXTRA_URL, url);
                intent.putExtra(PlayerActivity.EXTRA_TITLE, PlayerActivity.sessionTitle());
                intent.putExtra(PlayerActivity.EXTRA_HEADERS, PlayerActivity.sessionHeaders());
                intent.putExtra(PlayerActivity.EXTRA_FILL, fillMode);
                intent.putExtra(PlayerActivity.EXTRA_POSITION, PlayerActivity.sessionPosition());
                intent.putExtra(PlayerActivity.EXTRA_EPISODES, PlayerActivity.sessionEpisodes());
                intent.putExtra(PlayerActivity.EXTRA_EPISODE_URLS, PlayerActivity.sessionEpisodeUrls());
                intent.putExtra(PlayerActivity.EXTRA_EPISODE, PlayerActivity.sessionEpisode());
                intent.putExtra(PlayerActivity.EXTRA_LIVE, PlayerActivity.sessionLive());
                if (!PlayerActivity.sessionSubtitlePath().isEmpty()) {
                    intent.putExtra(PlayerActivity.EXTRA_SUBTITLE_PATH, PlayerActivity.sessionSubtitlePath());
                    intent.putExtra(PlayerActivity.EXTRA_SUBTITLE_MIME, PlayerActivity.sessionSubtitleMime());
                }
                getContext().startActivity(intent);
            } catch (Exception e) {
                Logger.error("[NativePlayer] 恢复播放界面失败: " + e.getMessage());
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void destroy(PluginCall call) {
        runOnUi(() -> {
            PlayerActivity a = PlayerActivity.get();
            if (a != null) a.closeSelf();
            call.resolve();
        });
    }

    // ── 屏幕常亮 ────────────────────────────────────────

    @PluginMethod
    public void keepAwake(PluginCall call) {
        Boolean enable = call.getBoolean("enable", true);
        boolean on = enable == null || enable;
        runOnUi(() -> {
            try {
                Activity act = getActivity();
                if (act == null) {
                    call.resolve();
                    return;
                }
                if (on) {
                    act.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                } else {
                    act.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            } catch (Exception e) {
                Logger.error("[NativePlayer] keepAwake 失败: " + e.getMessage());
            }
            call.resolve();
        });
    }

    // ── 画中画 ──────────────────────────────────────────

    /**
     * 进入画中画小窗
     *
     * 原生引擎下由 PlayerActivity 自己进 PiP（只显示画面）；
     * Web 引擎下播放发生在 WebView 里，退化为让 MainActivity 整体进 PiP。
     */
    @PluginMethod
    public void enterPip(PluginCall call) {
        runOnUi(() -> {
            try {
                PlayerActivity a = PlayerActivity.get();
                if (a != null) {
                    a.enterPip();
                    call.resolve();
                    return;
                }
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
                    call.reject("系统版本不支持画中画");
                    return;
                }
                Activity act = getActivity();
                if (act == null) {
                    call.reject("无法获取当前界面");
                    return;
                }
                act.enterPictureInPictureMode(
                    new android.app.PictureInPictureParams.Builder()
                        .setAspectRatio(new android.util.Rational(16, 9))
                        .build()
                );
            } catch (Exception e) {
                Logger.error("[NativePlayer] 画中画失败: " + e.getMessage());
                call.reject("画中画失败: " + e.getMessage());
                return;
            }
            call.resolve();
        });
    }

    // ── 多集连续缓存 ────────────────────────────────────

    /**
     * 预加载下一集
     *
     * 前端解析出下一集地址后调用；原生侧静音预缓冲，
     * 当前集播完直接接管画面，避免重新建连的等待。
     */
    @PluginMethod
    public void preload(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.resolve();
            return;
        }
        String headers = call.getString("headers", "");
        String title = call.getString("title", "");
        Integer episode = call.getInt("episode", 0);

        runOnUi(() -> {
            PlayerActivity a = PlayerActivity.get();
            if (a != null) {
                a.preloadNext(url, headers == null ? "" : headers,
                    title == null ? "" : title, episode == null ? 0 : episode);
            }
            call.resolve();
        });
    }

    // ── 诊断 ────────────────────────────────────────────

    @PluginMethod
    public void diagnose(PluginCall call) {
        runOnUi(() -> {
            PlayerActivity a = PlayerActivity.get();
            JSObject ret;
            if (a != null) {
                ret = a.diag();
            } else {
                ret = new JSObject();
                ret.put("available", true);
                ret.put("pluginId", "NativePlayer");
                ret.put("hasPlayer", false);
                ret.put("hasDialog", false);
                ret.put("dialogShowing", false);
                ret.put("host", "activity");
                ret.put("version", appVersionLabel(getContext()));
            }
            call.resolve(ret);
        });
    }

    @Override
    protected void handleOnDestroy() {
        instance = null;
        super.handleOnDestroy();
    }
}
