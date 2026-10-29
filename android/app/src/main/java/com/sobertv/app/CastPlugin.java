package com.sobertv.app;

import android.content.Context;
import android.net.Uri;
import android.os.Bundle;

import androidx.mediarouter.media.MediaControlIntent;
import androidx.mediarouter.media.MediaItemMetadata;
import androidx.mediarouter.media.MediaItemStatus;
import androidx.mediarouter.media.MediaRouteSelector;
import androidx.mediarouter.media.MediaRouter;
import androidx.mediarouter.media.MediaSessionStatus;
import androidx.mediarouter.media.RemotePlaybackClient;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.List;

/**
 * DLNA 投屏（MediaRouter + RemotePlaybackClient）
 *
 * ── 为什么选 DLNA 而不是 Google Cast ────────────────
 * · Cast SDK **强依赖 Google Play 服务** —— 国内 ROM（无 GMS 的机型）
 *   装上也是废的，且还需要用户额外装 Receiver 应用。
 * · DLNA 走系统自带的 MediaRouter，**不依赖任何 Google 服务**，
 *   电视/盒子只要支持 DLNA 就能投。
 * · 包体只 +780KB（mediarouter aar），Cast 要 3MB+。
 *
 * ── 工作方式 ────────────────────────────────────────
 * 把 m3u8 URL **推给电视端**，电视自己去拉流播放。
 * 好处：完全不经过手机的解码与 CORS 限制 ——
 *      这些源在手机上有 CORS 问题，但电视端拉的是同一个 CDN，没这问题。
 * 代价：控制能力弱（进度无法实时回传到手机）。
 *
 * ── API 说明 ────────────────────────────────────────
 * `RemotePlaybackClient.play(Uri, sessionId, metadata, position, extras, callback)`
 * —— sessionId 为 null 表示新建会话；
 *    metadata 是 Bundle，标题用 `MediaItemMetadata.KEY_TITLE`。
 * 状态回调是 `StatusCallback.onItemStatusChanged(...)`，
 * 播放状态从 `MediaItemStatus.getPlaybackState()` 取。
 *
 * ── 兼容性 ──────────────────────────────────────────
 * MediaRouter 的 DLNA provider 是系统组件（com.android.mediarouter），
 * 部分定制 ROM 可能裁剪掉了它 —— 此时 `listDevices` 返回空列表，
 * 前端提示「未发现可投屏设备」，不影响其余功能。
 */
@CapacitorPlugin(name = "CastPlugin")
public class CastPlugin extends BasePlugin {

    /** 设备条目（原生播放界面直接读取，避免再走一层 JS 往返） */
    public static class CastDeviceInfo {
        public final String id;
        public final String name;
        public final String description;

        CastDeviceInfo(String id, String name, String description) {
            this.id = id;
            this.name = name;
            this.description = description;
        }
    }

    private static CastPlugin instance;

    public static CastPlugin get() {
        return instance;
    }

    private MediaRouter mediaRouter;
    private MediaRouteSelector routeSelector;
    private RemotePlaybackClient remoteClient;
    private String currentRouteId;

    @Override
    public void load() {
        super.load();
        instance = this;
        Context ctx = getContext();
        if (ctx == null) return;

        mediaRouter = MediaRouter.getInstance(ctx);

        // 选出支持「远程播放」的路由 —— DLNA 电视走这条
        routeSelector = new MediaRouteSelector.Builder()
                .addControlCategory(MediaControlIntent.CATEGORY_REMOTE_PLAYBACK)
                .addControlCategory(MediaControlIntent.CATEGORY_LIVE_VIDEO)
                .build();

        mediaRouter.addCallback(
                routeSelector,
                new MediaRouter.Callback() {
                    @Override
                    public void onRouteSelected(MediaRouter router, MediaRouter.RouteInfo route) {
                        if (route == null) return;
                        // 只有支持远程播放的路由才能推流
                        if (!route.supportsControlCategory(
                                MediaControlIntent.CATEGORY_REMOTE_PLAYBACK)) {
                            return;
                        }
                        currentRouteId = route.getId();
                        try {
                            // mediarouter 1.7.0 没有 getRemotePlaybackClient()
                            remoteClient = new RemotePlaybackClient(getContext(), route);
                            if (remoteClient != null) {
                                remoteClient.setStatusCallback(
                                        new RemotePlaybackClient.StatusCallback() {
                                            @Override
                                            public void onItemStatusChanged(
                                                    Bundle extras, String sessionId,
                                                    MediaSessionStatus sessionStatus,
                                                    String mediaItemId,
                                                    MediaItemStatus itemStatus) {
                                                notifyStatus(sessionId, sessionStatus, itemStatus);
                                            }

                                            @Override
                                            public void onSessionStatusChanged(
                                                    Bundle extras, String sessionId,
                                                    MediaSessionStatus sessionStatus) {
                                                notifyStatus(sessionId, sessionStatus, null);
                                            }
                                        });
                            }
                        } catch (Exception ex) {
                            remoteClient = null;
                        }
                    }

                    @Override
                    public void onRouteUnselected(
                            MediaRouter router, MediaRouter.RouteInfo route) {
                        remoteClient = null;
                        currentRouteId = null;
                        JSObject e = new JSObject();
                        e.put("connected", false);
                        notifyListeners("castState", e);
                    }
                });
    }

    /**
     * 当前可投屏设备快照（原生播放界面用）
     *
     * 必须运行在 UI 线程：MediaRouter.getRoutes() 不是线程安全的。
     */
    public java.util.List<CastDeviceInfo> listDevicesNow() {
        java.util.List<CastDeviceInfo> out = new java.util.ArrayList<>();
        if (mediaRouter == null) return out;
        try {
            for (MediaRouter.RouteInfo r : mediaRouter.getRoutes()) {
                if (!r.supportsControlCategory(MediaControlIntent.CATEGORY_REMOTE_PLAYBACK)) continue;
                out.add(new CastDeviceInfo(
                        r.getId(),
                        String.valueOf(r.getName()),
                        String.valueOf(r.getDescription())));
            }
        } catch (Exception ignored) {
            /* 部分 ROM 的 MediaRouter 会抛异常，按无设备处理 */
        }
        return out;
    }

    /** 是否正在投屏 */
    public boolean isCasting() {
        return remoteClient != null;
    }

    /**
     * 推流到指定设备（供原生播放界面直接调用）
     *
     * @return null 表示已发起；非 null 为失败原因
     */
    public String castToDevice(String routeId, String url, String title, long positionMs) {
        if (mediaRouter == null) return "系统投屏服务不可用";
        if (url == null || url.isEmpty()) return "缺少播放地址";
        try {
            MediaRouter.RouteInfo target = null;
            for (MediaRouter.RouteInfo r : mediaRouter.getRoutes()) {
                if (r.getId().equals(routeId)) {
                    target = r;
                    break;
                }
            }
            if (target == null) return "设备不存在或已离线";

            mediaRouter.selectRoute(target);
            if (remoteClient == null) {
                remoteClient = new RemotePlaybackClient(getContext(), target);
            }
            if (remoteClient == null) return "该设备不支持远程播放控制";
            if (!remoteClient.isRemotePlaybackSupported()) return "该设备不支持远程播放";

            Bundle metadata = new Bundle();
            metadata.putString(MediaItemMetadata.KEY_TITLE, title == null ? "" : title);

            final String rid = target.getId();
            remoteClient.play(
                    Uri.parse(url),
                    null,
                    metadata,
                    positionMs,
                    null,
                    new RemotePlaybackClient.ItemActionCallback() {
                        @Override
                        public void onResult(
                                Bundle extras, String sessionId,
                                MediaSessionStatus sessionStatus,
                                String mediaItemId,
                                MediaItemStatus itemStatus) {
                            currentRouteId = rid;
                            JSObject e = new JSObject();
                            e.put("success", true);
                            e.put("sessionId", sessionId);
                            e.put("connected", true);
                            notifyListeners("castState", e);
                        }

                        @Override
                        public void onError(String errorCode, int errorCodeInt, Bundle extras) {
                            JSObject e = new JSObject();
                            e.put("error", errorCode + " (" + errorCodeInt + ")");
                            notifyListeners("castError", e);
                        }
                    });
            currentRouteId = target.getId();
            return null;
        } catch (Exception e) {
            return e.getMessage() == null ? "投屏失败" : e.getMessage();
        }
    }

    /** 停止投屏（供原生播放界面直接调用） */
    public void stopCast() {
        try {
            if (remoteClient != null) {
                remoteClient.stop(null, null);
                remoteClient.release();
                remoteClient = null;
            }
            currentRouteId = null;
            JSObject e = new JSObject();
            e.put("connected", false);
            notifyListeners("castState", e);
        } catch (Exception ignored) {
            /* 停止失败不影响本地播放恢复 */
        }
    }

    /** 扫描局域网内的可投屏设备 */
    @PluginMethod
    public void listDevices(PluginCall call) {
        runOnUi(() -> {
            try {
                if (mediaRouter == null) {
                    call.reject("MediaRouter 未初始化");
                    return;
                }
                MediaRouter.RouteInfo current = mediaRouter.getSelectedRoute();
                List<MediaRouter.RouteInfo> all = mediaRouter.getRoutes();

                JSArray arr = new JSArray();
                for (MediaRouter.RouteInfo r : all) {
                    // 只保留支持远程播放的（能推流的那种）
                    if (!r.supportsControlCategory(
                            MediaControlIntent.CATEGORY_REMOTE_PLAYBACK)) {
                        continue;
                    }
                    JSObject o = new JSObject();
                    o.put("id", r.getId());
                    o.put("name", String.valueOf(r.getName()));
                    o.put("description", String.valueOf(r.getDescription()));
                    o.put("selected", current != null && current.getId().equals(r.getId()));
                    arr.put(o);
                }

                JSObject ret = new JSObject();
                ret.put("devices", arr);
                ret.put("count", arr.length());
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("扫描设备失败: " + e.getMessage());
            }
        });
    }

    /**
     * 选设备并推流
     *
     * @param url      m3u8 直链（电视端自己去拉）
     * @param title    影片名（显示在电视上）
     * @param position 起始位置（毫秒）
     */
    @PluginMethod
    public void play(PluginCall call) {
        runOnUi(() -> {
            try {
                if (mediaRouter == null) {
                    call.reject("MediaRouter 未初始化");
                    return;
                }
                String routeId = call.getString("routeId");
                String url = call.getString("url");
                String title = call.getString("title", "");
                long position = call.getLong("position", 0L);

                if (url == null || url.isEmpty()) {
                    call.reject("缺少播放地址");
                    return;
                }

                // 找到目标路由
                MediaRouter.RouteInfo target = null;
                for (MediaRouter.RouteInfo r : mediaRouter.getRoutes()) {
                    if (r.getId().equals(routeId)) {
                        target = r;
                        break;
                    }
                }
                if (target == null) {
                    call.reject("设备不存在或已离线");
                    return;
                }

                mediaRouter.selectRoute(target);
                if (remoteClient == null) {
                    // mediarouter 1.7.0 没有 MediaRouter.getRemotePlaybackClient()，
                    // 只能直接用构造器创建
                    remoteClient = new RemotePlaybackClient(getContext(), target);
                }
                if (remoteClient == null) {
                    call.reject("该设备不支持远程播放控制");
                    return;
                }
                if (!remoteClient.isRemotePlaybackSupported()) {
                    call.reject("该设备不支持远程播放");
                    return;
                }

                // metadata：标题走 MediaItemMetadata.KEY_TITLE
                Bundle metadata = new Bundle();
                metadata.putString(MediaItemMetadata.KEY_TITLE, title);

                // sessionId 传 null = 新建会话
                remoteClient.play(
                        Uri.parse(url),
                        null,
                        metadata,
                        position,
                        null,
                        new RemotePlaybackClient.ItemActionCallback() {
                            @Override
                            public void onResult(
                                    Bundle extras, String sessionId,
                                    MediaSessionStatus sessionStatus,
                                    String mediaItemId,
                                    MediaItemStatus itemStatus) {
                                JSObject e = new JSObject();
                                e.put("success", true);
                                e.put("sessionId", sessionId);
                                e.put("connected", true);
                                notifyListeners("castState", e);
                            }

                            @Override
                            public void onError(String errorCode, int errorCodeInt,
                                    Bundle extras) {
                                JSObject e = new JSObject();
                                e.put("error", errorCode + " (" + errorCodeInt + ")");
                                notifyListeners("castError", e);
                            }
                        });

                call.resolve();
            } catch (Exception e) {
                call.reject("投屏失败: " + e.getMessage());
            }
        });
    }

    /** 停止投屏 */
    @PluginMethod
    public void stop(PluginCall call) {
        runOnUi(() -> {
            try {
                if (remoteClient != null) {
                    remoteClient.stop(
                            null,
                            new RemotePlaybackClient.SessionActionCallback() {
                                @Override
                                public void onResult(Bundle extras, String sessionId,
                                        MediaSessionStatus sessionStatus) {
                                    JSObject e = new JSObject();
                                    e.put("connected", false);
                                    notifyListeners("castState", e);
                                }

                                @Override
                                public void onError(String errorCode, int errorCodeInt,
                                        Bundle extras) {
                                    /* ignore */
                                }
                            });
                    remoteClient.release();
                    remoteClient = null;
                }
                currentRouteId = null;
                call.resolve();
            } catch (Exception e) {
                call.reject("停止投屏失败: " + e.getMessage());
            }
        });
    }

    /** 当前投屏状态 */
    @PluginMethod
    public void status(PluginCall call) {
        runOnUi(() -> {
            try {
                JSObject ret = new JSObject();
                ret.put("connected", remoteClient != null);
                ret.put("routeId", currentRouteId);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("查询状态失败: " + e.getMessage());
            }
        });
    }

    private void notifyStatus(
            String sessionId, MediaSessionStatus sessionStatus, MediaItemStatus itemStatus) {
        try {
            JSObject e = new JSObject();
            e.put("connected", remoteClient != null);
            e.put("sessionId", sessionId);
            if (sessionStatus != null) {
                e.put("sessionState", sessionStatus.getSessionState());
            }
            if (itemStatus != null) {
                e.put("playbackState", itemStatus.getPlaybackState());
                e.put("position", itemStatus.getContentPosition());
                e.put("duration", itemStatus.getContentDuration());
            }
            notifyListeners("castState", e);
        } catch (Exception ex) {
            // ignore
        }
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) instance = null;
        super.handleOnDestroy();
    }
}
