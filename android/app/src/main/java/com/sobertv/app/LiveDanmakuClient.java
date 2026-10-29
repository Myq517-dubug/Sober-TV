package com.sobertv.app;

import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;

import com.getcapacitor.Logger;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * 直播弹幕客户端（原生侧）
 *
 * 直播的 FLV 线路必须走原生 ExoPlayer，而原生播放窗口在前台时
 * 主 WebView 会被 pauseTimers() 冻结 —— Web 侧的 WebSocket 收不到数据。
 * 于是 B 站 / 斗鱼的公开弹幕协议在这里各实现一份。
 *
 *   · B 站：16 字节小端包头；op=7 认证，op=3 心跳，op=5 消息体（protover=1 明文）。
 *     认证前先请求 room_init 拿真实房间号、getDanmuInfo 拿 token 与弹幕节点。
 *   · 斗鱼：STT 文本协议，4+4+2+2 字节包头；loginreq / joingroup 入房，
 *     mrkl 心跳，chatmsg 为弹幕正文。六个公开 WSS 端口轮换。
 *   · 虎牙：腾讯 TARS 二进制协议，房间页里抠出主播 uid 后匿名订阅；
 *     op=7 内层 cmd=1400 的包里 tag2 是昵称、tag3 是正文，60 秒一次固定心跳帧。
 *
 * 三家都不需要登录。连不上只影响弹幕，不影响画面，所以所有异常都内部吞掉。
 */
public class LiveDanmakuClient {

    public interface Listener {
        void onMessage(String text, String name);
    }

    private static final String UA =
        "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/120.0 Mobile Safari/537.36";
    private static final int MAX_LEN = 48;
    private static final int MAX_PER_SEC = 8;

    private static final String HUYA_WS = "wss://cdnws.api.huya.com/";
    /** 虎牙心跳是固定帧，直接用抓包字节，不参与序列化 */
    private static final byte[] HUYA_HEARTBEAT = hexToBytes(
        "00031d0000690000006910032c3c4c56086f6e6c696e657569660f4f6e557365724865617274426561747d" +
        "00003c0800010604745265711d00002f0a0a0c1600260036076164725f77617046000b1203aef00f22" +
        "03aef00f3c426d5202605c60017c82000bb01f9cac0b8c980ca80c"
    );

    private final String platform;
    private final String roomId;
    private final Listener listener;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final OkHttpClient http;
    private final List<String> urls = new ArrayList<>();

    private WebSocket ws;
    private boolean running;
    private int urlIndex;
    private int reconnectRounds;
    private long windowStart;
    private int windowCount;

    private long biliRoom;
    private String biliToken = "";
    private Runnable heartbeat;

    private String huyaUid = "";
    private String huyaChannel = "";
    private String huyaSub = "";
    private int huyaVariant;
    private int huyaChats;

    public LiveDanmakuClient(String platform, String roomId, Listener listener) {
        this.platform = platform == null ? "" : platform;
        this.roomId = roomId == null ? "" : roomId;
        this.listener = listener;
        this.http = new OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(12, TimeUnit.SECONDS)
            .build();
    }

    public static boolean supported(String platform) {
        return "bili".equals(platform) || "douyu".equals(platform) || "huya".equals(platform);
    }

    public void start() {
        if (running) return;
        running = true;
        reconnectRounds = 0;
        urlIndex = 0;
        new Thread(this::resolve, "live-danmaku-resolve").start();
    }

    public void stop() {
        running = false;
        clearHeartbeat();
        handler.removeCallbacksAndMessages(null);
        if (ws != null) {
            try {
                ws.close(1000, "stop");
            } catch (Exception ignored) {
                /* noop */
            }
            ws = null;
        }
    }

    // ── 建连 ────────────────────────────────────────────

    private void resolve() {
        if (!running) return;
        try {
            if ("douyu".equals(platform)) {
                for (int port = 8501; port <= 8506; port++) {
                    urls.add("wss://danmuproxy.douyu.com:" + port + "/");
                }
            } else if ("huya".equals(platform)) {
                resolveHuya();
            } else {
                resolveBili();
                urls.add("wss://" + biliHost + "/sub");
            }
        } catch (Exception e) {
            Logger.error("[LiveDanmaku] 解析弹幕节点失败: " + e.getMessage());
            scheduleReconnect();
            return;
        }
        if (!running) return;
        handler.post(this::connectNext);
    }

    private String biliHost = "broadcastlv.chat.bilibili.com";

    private void resolveBili() {
        long realRoom = parseLong(roomId);
        try {
            JSONObject j = getJson(
                "https://api.live.bilibili.com/room/v1/Room/room_init?id=" +
                    java.net.URLEncoder.encode(roomId, "UTF-8")
            );
            JSONObject data = j.optJSONObject("data");
            if (data != null && data.optLong("room_id") > 0) realRoom = data.optLong("room_id");
        } catch (Exception ignored) {
            /* 短号换长号失败时按原号试一次 */
        }
        biliRoom = realRoom;

        try {
            JSONObject j = getJson(
                "https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?id=" +
                    realRoom + "&type=0"
            );
            JSONObject data = j.optJSONObject("data");
            if (data != null) {
                String token = data.optString("token", "");
                if (!TextUtils.isEmpty(token)) biliToken = token;
                JSONArray hosts = data.optJSONArray("host_list");
                if (hosts != null && hosts.length() > 0) {
                    JSONObject h = hosts.optJSONObject(0);
                    String host = h == null ? "" : h.optString("host", "");
                    if (!TextUtils.isEmpty(host)) biliHost = host;
                }
            }
        } catch (Exception ignored) {
            /* 拿不到 token 时退回公共节点，部分房间仍可匿名订阅 */
        }
    }

    private JSONObject getJson(String url) throws Exception {
        Request req = new Request.Builder()
            .url(url)
            .header("User-Agent", UA)
            .header("Referer", "https://live.bilibili.com/")
            .build();
        try (Response resp = http.newCall(req).execute()) {
            String body = resp.body() == null ? "" : resp.body().string();
            return new JSONObject(body);
        }
    }

    private void resolveHuya() {
        String uid = "";
        String cid = "";
        String sid = "";
        String[] pages = {
            "https://m.huya.com/" + roomId,
            "https://www.huya.com/" + roomId,
        };
        for (String url : pages) {
            try {
                String html = getText(url);
                if (TextUtils.isEmpty(html)) continue;
                String u = pickDigits(html, "lYyid");
                if (TextUtils.isEmpty(u)) u = pickDigits(html, "lUid");
                if (TextUtils.isEmpty(u)) continue;
                uid = u;
                cid = pickDigits(html, "lChannelId");
                sid = pickDigits(html, "lSubChannelId");
                break;
            } catch (Exception ignored) {
                /* 换下一个页面继续试 */
            }
        }
        huyaUid = uid;
        huyaChannel = cid;
        huyaSub = sid;
        if (!TextUtils.isEmpty(uid)) urls.add(HUYA_WS);
        else Logger.error("[LiveDanmaku] 虎牙房间页没抠到主播 uid");
    }

    private String getText(String url) throws Exception {
        Request req = new Request.Builder()
            .url(url)
            .header("User-Agent", UA)
            .header("Referer", "https://www.huya.com/")
            .build();
        try (Response resp = http.newCall(req).execute()) {
            return resp.body() == null ? "" : resp.body().string();
        }
    }

    private static String pickDigits(String html, String key) {
        Matcher m = Pattern.compile("\"" + key + "\"\\s*:\\s*\"?([0-9]{4,})").matcher(html);
        return m.find() ? m.group(1) : "";
    }

    private void connectNext() {
        if (!running) return;
        if (urls.isEmpty() || urlIndex >= urls.size()) {
            scheduleReconnect();
            return;
        }
        final String url = urls.get(urlIndex++);
        Request req = new Request.Builder().url(url).header("User-Agent", UA).build();
        ws = http.newWebSocket(req, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                if (!running) {
                    webSocket.close(1000, "closed");
                    return;
                }
                reconnectRounds = 0;
                if ("douyu".equals(platform)) {
                    webSocket.send(ByteString.of(douyuPacket(douyuFields(
                        "type", "loginreq", "roomid", roomId
                    ))));
                    webSocket.send(ByteString.of(douyuPacket(douyuFields(
                        "type", "joingroup", "rid", roomId, "gid", "-9999"
                    ))));
                    startHeartbeat(webSocket, 40_000L, douyuPacket(douyuFields("type", "mrkl")));
                } else if ("huya".equals(platform)) {
                    huyaChats = 0;
                    webSocket.send(ByteString.of(huyaJoinPacket()));
                    startHeartbeat(webSocket, 60_000L, HUYA_HEARTBEAT);
                    handler.removeCallbacks(huyaWatchdog);
                    handler.postDelayed(huyaWatchdog, 12_000L);
                } else {
                    webSocket.send(ByteString.of(biliPacket(7, biliAuthBody())));
                    startHeartbeat(webSocket, 30_000L, biliPacket(3, new byte[0]));
                }
            }

            @Override
            public void onMessage(WebSocket webSocket, ByteString bytes) {
                if (!running) return;
                try {
                    if ("douyu".equals(platform)) {
                        douyuFrames(bytes.toByteArray());
                    } else if ("huya".equals(platform)) {
                        huyaFrames(bytes.toByteArray());
                    } else {
                        biliFrames(bytes.toByteArray());
                    }
                } catch (Exception e) {
                    Logger.error("[LiveDanmaku] 单帧解析失败: " + e.getMessage());
                }
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                if (!running) return;
                Logger.error("[LiveDanmaku] 连接失败: " + t.getMessage());
                clearHeartbeat();
                if (webSocket == ws) ws = null;
                handler.post(LiveDanmakuClient.this::connectNext);
            }

            @Override
            public void onClosed(WebSocket webSocket, int code, String reason) {
                if (!running) return;
                clearHeartbeat();
                if (webSocket == ws) ws = null;
                handler.post(LiveDanmakuClient.this::scheduleReconnect);
            }
        });
    }

    /** 所有节点都失败后才退避重连一次，避免长时间直播里反复握手耗电 */
    private void scheduleReconnect() {
        if (!running) return;
        if (reconnectRounds >= 1) return;
        reconnectRounds++;
        urlIndex = 0;
        handler.postDelayed(() -> {
            if (running) handler.post(LiveDanmakuClient.this::connectNext);
        }, 2500L);
    }

    private void startHeartbeat(final WebSocket socket, long every, final byte[] payload) {
        clearHeartbeat();
        heartbeat = new Runnable() {
            @Override
            public void run() {
                if (!running || socket != ws) return;
                try {
                    socket.send(ByteString.of(payload));
                } catch (Exception ignored) {
                    /* noop */
                }
                handler.postDelayed(this, every);
            }
        };
        handler.postDelayed(heartbeat, every);
    }

    private void clearHeartbeat() {
        if (heartbeat != null) {
            handler.removeCallbacks(heartbeat);
            heartbeat = null;
        }
        handler.removeCallbacks(huyaWatchdog);
    }

    // ── B 站协议 ────────────────────────────────────────

    private byte[] biliAuthBody() {
        JSONObject o = new JSONObject();
        try {
            o.put("uid", 0);
            o.put("roomid", biliRoom);
            o.put("protover", 1);
            o.put("platform", "web");
            o.put("type", 2);
            o.put("key", biliToken);
        } catch (Exception ignored) {
            /* noop */
        }
        return o.toString().getBytes(StandardCharsets.UTF_8);
    }

    private static byte[] biliPacket(int op, byte[] body) {
        int total = 16 + body.length;
        ByteBuffer b = ByteBuffer.allocate(total).order(ByteOrder.LITTLE_ENDIAN);
        b.putInt(total);
        b.putShort((short) 16);
        b.putShort((short) 1);
        b.putInt(op);
        b.putInt(1);
        b.put(body);
        return b.array();
    }

    private void biliFrames(byte[] buf) {
        int pos = 0;
        while (pos + 16 <= buf.length) {
            ByteBuffer head = ByteBuffer.wrap(buf, pos, 16).order(ByteOrder.LITTLE_ENDIAN);
            int total = head.getInt();
            int headerLen = head.getShort() & 0xFFFF;
            int proto = head.getShort() & 0xFFFF;
            int op = head.getInt();
            if (total < headerLen || pos + total > buf.length) break;
            // 2 / 3 是 zlib / brotli 压缩帧；我们只要了 protover=1 的明文
            if (proto == 1 && op == 5 && total > headerLen) {
                String body = new String(buf, pos + headerLen, total - headerLen, StandardCharsets.UTF_8);
                biliMessage(body);
            }
            pos += total;
        }
    }

    private void biliMessage(String body) {
        try {
            JSONObject j = new JSONObject(body);
            String cmd = j.optString("cmd", "");
            if (!cmd.startsWith("DANMU_MSG")) return;
            JSONArray info = j.optJSONArray("info");
            if (info == null || info.length() < 2) return;
            String text = info.optString(1, "");
            String name = "";
            JSONArray user = info.optJSONArray(2);
            if (user != null && user.length() > 1) name = user.optString(1, "");
            emit(text, name);
        } catch (Exception ignored) {
            /* 非 JSON 帧（人气值等）直接跳过 */
        }
    }

    // ── 斗鱼协议 ────────────────────────────────────────

    private static String sttEscape(String s) {
        return s.replace("@", "@A").replace("/", "@S");
    }

    private static String sttUnescape(String s) {
        return s.replace("@S", "/").replace("@A", "@");
    }

    private static String douyuFields(String... kvs) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i + 1 < kvs.length; i += 2) {
            sb.append(kvs[i]).append("@=").append(sttEscape(kvs[i + 1])).append('/');
        }
        return sb.toString();
    }

    private static byte[] douyuPacket(String body) {
        byte[] payload = (body + '\0').getBytes(StandardCharsets.UTF_8);
        int len = payload.length + 8;
        ByteBuffer b = ByteBuffer.allocate(payload.length + 12).order(ByteOrder.LITTLE_ENDIAN);
        b.putInt(len);
        b.putInt(len);
        b.putShort((short) 689);
        b.putShort((short) 0);
        b.put(payload);
        return b.array();
    }

    private void douyuFrames(byte[] buf) {
        ByteBuffer all = ByteBuffer.wrap(buf).order(ByteOrder.LITTLE_ENDIAN);
        int pos = 0;
        while (pos + 4 <= buf.length) {
            all.position(pos);
            int len = all.getInt();
            pos += 4;
            if (len < 9 || pos + len > buf.length) break;
            int start = pos + 8;
            int end = pos + len - 1;
            if (end > start) {
                String body = new String(buf, start, end - start, StandardCharsets.UTF_8);
                douyuMessage(body);
            }
            pos += len;
        }
    }

    private void douyuMessage(String body) {
        String type = null;
        String txt = null;
        String nn = null;
        for (String seg : body.split("/")) {
            int i = seg.indexOf("@=");
            if (i <= 0) continue;
            String k = seg.substring(0, i);
            String v = sttUnescape(seg.substring(i + 2));
            if ("type".equals(k)) {
                type = v;
            } else if ("txt".equals(k)) {
                txt = v;
            } else if ("nn".equals(k)) {
                nn = v;
            }
        }
        if ("chatmsg".equals(type)) emit(txt, nn);
    }

    // ── 虎牙协议（TARS） ────────────────────────────────

    /**
     * 新版进房包（op=16）内层是 live/chat 两条字符串订阅，匿名可用；
     * 老版（op=1）要主播 uid + 频道 + 子频道，部分老房间才认。
     */
    private byte[] huyaJoinPacket() {
        TarsWriter inner = new TarsWriter();
        TarsWriter outer = new TarsWriter();
        if (huyaVariant == 0 || TextUtils.isEmpty(huyaChannel)) {
            inner.writeStringList(0, new String[] { "live:" + huyaUid, "chat:" + huyaUid });
            inner.writeString(1, "");
            outer.writeInt(0, 16);
        } else {
            inner.writeInt(0, parseLong(huyaUid));
            inner.writeBool(1, true);
            inner.writeString(2, "");
            inner.writeString(3, "");
            inner.writeInt(4, parseLong(huyaChannel));
            inner.writeInt(5, parseLong(huyaSub));
            inner.writeInt(6, 0);
            inner.writeInt(7, 0);
            outer.writeInt(0, 1);
        }
        outer.writeBytes(1, inner.bytes());
        return outer.bytes();
    }

    /** 连上却一条弹幕都没有：换老版进房包，关掉连接交给自动重连重发 */
    private final Runnable huyaWatchdog = new Runnable() {
        @Override
        public void run() {
            if (!running || !"huya".equals(platform)) return;
            if (huyaChats > 0 || huyaVariant != 0) return;
            if (TextUtils.isEmpty(huyaChannel)) return;
            huyaVariant = 1;
            if (ws != null) {
                try {
                    ws.close(1000, "switch");
                } catch (Exception ignored) {
                    /* noop */
                }
            }
        }
    };

    private void huyaFrames(byte[] buf) {
        Map<Integer, Object> top = new TarsReader(buf).read();
        if (!isNumber(top.get(0), 7)) return;

        Object payload = top.get(1);
        if (!(payload instanceof byte[])) return;

        Map<Integer, Object> mid = new TarsReader((byte[]) payload).read();
        if (!isNumber(mid.get(1), 1400)) return;

        Object body = mid.get(2);
        if (!(body instanceof byte[])) return;

        Map<Integer, Object> chat = new TarsReader((byte[]) body).read();
        String name = "";
        Object user = chat.get(0);
        if (user instanceof Map) {
            Map<?, ?> um = (Map<?, ?>) user;
            Object n = um.get(2) != null ? um.get(2) : um.get(1);
            if (n instanceof String) name = (String) n;
        } else if (user instanceof String) {
            name = (String) user;
        }
        Object text = chat.get(3);
        if (text instanceof String) {
            huyaChats++;
            emit((String) text, name);
        }
    }

    private static boolean isNumber(Object v, long expect) {
        return v instanceof Number && ((Number) v).longValue() == expect;
    }

    private static byte[] hexToBytes(String hex) {
        int n = hex.length() / 2;
        byte[] out = new byte[n];
        for (int i = 0; i < n; i++) {
            out[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }

    private static final int T_INT8 = 0;
    private static final int T_INT16 = 1;
    private static final int T_INT32 = 2;
    private static final int T_INT64 = 3;
    private static final int T_FLOAT = 4;
    private static final int T_DOUBLE = 5;
    private static final int T_STRING1 = 6;
    private static final int T_STRING4 = 7;
    private static final int T_MAP = 8;
    private static final int T_LIST = 9;
    private static final int T_STRUCT_BEGIN = 10;
    private static final int T_STRUCT_END = 11;
    private static final int T_ZERO = 12;
    private static final int T_BYTES = 13;

    /** 最小可用的 Tars 编码器：整数按最小类型写，跟官方实现一致 */
    private static final class TarsWriter {
        private final ByteArrayOutputStream out = new ByteArrayOutputStream();

        private void head(int tag, int type) {
            if (tag < 15) {
                out.write((tag << 4) | type);
            } else {
                out.write(0xf0 | type);
                out.write(tag & 0xff);
            }
        }

        private void putShort(int v) {
            out.write((v >> 8) & 0xff);
            out.write(v & 0xff);
        }

        private void putInt(int v) {
            putShort(v >> 16);
            putShort(v);
        }

        private void putLong(long v) {
            for (int i = 7; i >= 0; i--) out.write((int) ((v >>> (i * 8)) & 0xff));
        }

        void writeInt(int tag, long v) {
            if (v == 0) {
                head(tag, T_ZERO);
            } else if (v >= -128 && v <= 127) {
                head(tag, T_INT8);
                out.write((int) (v & 0xff));
            } else if (v >= -32768 && v <= 32767) {
                head(tag, T_INT16);
                putShort((int) v);
            } else if (v >= Integer.MIN_VALUE && v <= Integer.MAX_VALUE) {
                head(tag, T_INT32);
                putInt((int) v);
            } else {
                head(tag, T_INT64);
                putLong(v);
            }
        }

        void writeBool(int tag, boolean v) {
            head(tag, T_INT8);
            out.write(v ? 1 : 0);
        }

        void writeString(int tag, String s) {
            byte[] b = s.getBytes(StandardCharsets.UTF_8);
            if (b.length <= 255) {
                head(tag, T_STRING1);
                out.write(b.length);
            } else {
                head(tag, T_STRING4);
                putInt(b.length);
            }
            out.write(b, 0, b.length);
        }

        void writeBytes(int tag, byte[] data) {
            head(tag, T_BYTES);
            putInt(data.length);
            out.write(data, 0, data.length);
        }

        void writeStringList(int tag, String[] list) {
            head(tag, T_LIST);
            writeInt(0, list.length);
            for (String s : list) writeString(0, s);
        }

        byte[] bytes() {
            return out.toByteArray();
        }
    }

    /** 把整段流读成 tag → 值，够解析弹幕包用 */
    private static final class TarsReader {
        private final byte[] buf;
        private int pos;

        TarsReader(byte[] buf) {
            this.buf = buf;
        }

        private int u8() {
            return pos < buf.length ? buf[pos++] & 0xff : 0;
        }

        private int[] head() {
            int b = u8();
            int type = b & 0x0f;
            int tag = (b >> 4) & 0x0f;
            if (tag == 0x0f) {
                tag = u8();
                if (tag == 0xff) tag = (u8() << 8) | u8();
            }
            return new int[] { tag, type };
        }

        private int readInt() {
            return (u8() << 24) | (u8() << 16) | (u8() << 8) | u8();
        }

        private long readLong() {
            long v = 0L;
            for (int i = 0; i < 8; i++) v = (v << 8) | (u8() & 0xffL);
            return v;
        }

        private byte[] take(int n) {
            int end = Math.min(pos + Math.max(n, 0), buf.length);
            byte[] out = new byte[end - pos];
            System.arraycopy(buf, pos, out, 0, out.length);
            pos = end;
            return out;
        }

        Map<Integer, Object> read() {
            Map<Integer, Object> out = new HashMap<>();
            while (pos < buf.length) {
                int[] h = head();
                if (h[1] == T_STRUCT_END) break;
                out.put(h[0], value(h[1]));
            }
            return out;
        }

        private Object value(int type) {
            switch (type) {
                case T_INT8:
                    return (long) (byte) u8();
                case T_INT16:
                    return (long) (short) ((u8() << 8) | u8());
                case T_INT32:
                    return (long) readInt();
                case T_INT64:
                    return readLong();
                case T_FLOAT:
                    return (double) Float.intBitsToFloat(readInt());
                case T_DOUBLE:
                    return Double.longBitsToDouble(readLong());
                case T_STRING1:
                    return new String(take(u8()), StandardCharsets.UTF_8);
                case T_STRING4:
                    return new String(take(readInt()), StandardCharsets.UTF_8);
                case T_BYTES:
                    return take(readInt());
                case T_ZERO:
                    return 0L;
                case T_LIST: {
                    int[] ch = head();
                    long n = asLong(value(ch[1]));
                    List<Object> list = new ArrayList<>();
                    for (int i = 0; i < n; i++) {
                        int[] eh = head();
                        list.add(value(eh[1]));
                    }
                    return list;
                }
                case T_MAP: {
                    int[] ch = head();
                    long n = asLong(value(ch[1]));
                    Map<Object, Object> map = new HashMap<>();
                    for (int i = 0; i < n; i++) {
                        int[] kh = head();
                        Object k = value(kh[1]);
                        int[] vh = head();
                        map.put(k, value(vh[1]));
                    }
                    return map;
                }
                case T_STRUCT_BEGIN:
                    return read();
                default:
                    return 0L;
            }
        }

        private static long asLong(Object v) {
            return v instanceof Number ? ((Number) v).longValue() : 0L;
        }
    }

    // ── 上屏 ────────────────────────────────────────────

    private void emit(String text, String name) {
        if (!running || TextUtils.isEmpty(text)) return;
        String clean = text.replaceAll("[\\r\\n\\t]", " ").replaceAll("\\s+", " ").trim();
        if (clean.isEmpty()) return;
        if (clean.length() > MAX_LEN) clean = clean.substring(0, MAX_LEN);
        if (!allow()) return;
        final String t = clean;
        final String n = TextUtils.isEmpty(name) ? "" : name.substring(0, Math.min(16, name.length()));
        handler.post(() -> {
            if (running && listener != null) listener.onMessage(t, n);
        });
    }

    /** 热门间一秒几十条，限流到 8 条/秒，丢弹幕保流畅 */
    private boolean allow() {
        long now = System.currentTimeMillis();
        if (now - windowStart >= 1000) {
            windowStart = now;
            windowCount = 0;
        }
        if (windowCount >= MAX_PER_SEC) return false;
        windowCount++;
        return true;
    }

    private static long parseLong(String s) {
        try {
            return Long.parseLong(s.trim());
        } catch (Exception e) {
            return 0L;
        }
    }
}
