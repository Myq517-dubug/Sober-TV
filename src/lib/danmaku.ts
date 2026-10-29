/**
 * 直播弹幕客户端
 *
 * ── 支持哪些平台 ──────────────────────────────────────
 *   · B站 —— 16 字节包头 + JSON 认证包；认证通过后 op=5 的帧里是弹幕 JSON。
 *     需要先拿真实 room_id 和 token，公开接口即可，不需要登录。
 *   · 斗鱼 —— STT 文本协议（type@=chatmsg/…），WSS 六个端口轮换，
 *     登录 + 入组 + 45 秒心跳，同样不需要登录。
 *   · 虎牙 —— 腾讯 TARS 二进制协议，匿名订阅，房间页里抠出主播 uid 即可连上
 *     （老版本还要 lChannelId / lSubChannelId，这里两套进房包都实现了）。
 *   · 抖音 —— WebSocket 传 protobuf，且要签名参数，暂不接入。
 *
 * ── 失败不是致命问题 ──────────────────────────────────
 *   连不上只会让弹幕层显示「弹幕连接失败」，直播画面不受影响，
 *   所以这里所有异常都内部吞掉，只通过 onStatus 上报。
 */

import { httpJson, httpText } from './net';

export type DanmakuStatus = 'idle' | 'connecting' | 'open' | 'unsupported' | 'error';

export interface DanmakuMsg {
  text: string;
  /** 昵称，Web 层会写成「昵称：内容」 */
  name?: string;
}

export interface DanmakuSession {
  close(): void;
}

interface ConnectOptions {
  /** 平台 ID（bili / huya / douyu / douyin） */
  platform: string;
  /** 平台房间号（B 站可能是短号） */
  roomId: string;
  onMessage(msg: DanmakuMsg): void;
  onStatus?(state: DanmakuStatus, detail?: string): void;
}

/** 一条弹幕的最大长度，超长的多半是广告或复读 */
const MAX_LEN = 48;
/** 每秒最多上屏多少条，热门直播间一秒能推几十条，不限制会糊成一片 */
const MAX_PER_SEC = 8;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function sanitize(text: string): string {
  return text.replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_LEN);
}

/** 每秒限流：超出的直接丢弃（弹幕允许丢，保住流畅度） */
function makeGate() {
  let windowStart = 0;
  let count = 0;
  return (): boolean => {
    const now = Date.now();
    if (now - windowStart >= 1000) {
      windowStart = now;
      count = 0;
    }
    if (count >= MAX_PER_SEC) return false;
    count++;
    return true;
  };
}

export function danmakuSupported(platform: string): boolean {
  return platform === 'bili' || platform === 'douyu' || platform === 'huya';
}

/**
 * 直播弹幕开关偏好
 *
 * 与点播的「弹幕显示」不同：直播单独一份，默认开启。
 * 原生 Activity 与 Web 播放层共用这一个键，保证两套引擎一致。
 */
export function readLiveDanmakuPref(): boolean {
  return localStorage.getItem('sober.liveDanmaku') !== '0';
}

export function writeLiveDanmakuPref(on: boolean): void {
  localStorage.setItem('sober.liveDanmaku', on ? '1' : '0');
}

// ── 斗鱼：STT 文本协议 ─────────────────────────────────

const DOUYU_PORTS = [8501, 8502, 8503, 8504, 8505, 8506];

function sttEscape(s: string): string {
  return s.replace(/@/g, '@A').replace(/\//g, '@S');
}

function sttUnescape(s: string): string {
  return s.replace(/@S/g, '/').replace(/@A/g, '@');
}

function sttSerialize(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}@=${sttEscape(v)}/`)
    .join('');
}

/** 解析 `type@=chatmsg/nn@=小明/txt@=666/` 这种串 */
function sttParse(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const seg of body.split('/')) {
    const i = seg.indexOf('@=');
    if (i <= 0) continue;
    out[seg.slice(0, i)] = sttUnescape(seg.slice(i + 2));
  }
  return out;
}

/**
 * 斗鱼包结构：4 字节长度 + 4 字节长度 + 2 字节消息类型(689) + 2 字节保留 + 正文(\0 结尾)
 * 长度字段 = 正文长度 + 8
 */
function douyuEncode(fields: Record<string, string>): ArrayBuffer {
  const payload = encoder.encode(sttSerialize(fields) + '\0');
  const len = payload.length + 8;
  const buf = new ArrayBuffer(payload.length + 12);
  const view = new DataView(buf);
  view.setUint32(0, len, true);
  view.setUint32(4, len, true);
  view.setUint16(8, 689, true);
  view.setUint16(10, 0, true);
  new Uint8Array(buf).set(payload, 12);
  return buf;
}

function douyuDecode(buf: ArrayBuffer): string[] {
  const view = new DataView(buf);
  const out: string[] = [];
  let pos = 0;
  while (pos + 4 <= buf.byteLength) {
    const len = view.getUint32(pos, true);
    pos += 4;
    if (len < 9 || pos + len > buf.byteLength) break;
    const start = pos + 8;
    const end = pos + len - 1;
    if (end > start) out.push(decoder.decode(new Uint8Array(buf, start, end - start)));
    pos += len;
  }
  return out;
}

// ── B站：16 字节包头 ───────────────────────────────────

const BILI_HEADER = 16;
const BILI_HOST = 'broadcastlv.chat.bilibili.com';
const BILI_REFERER = 'https://live.bilibili.com/';

function biliEncode(op: number, body: string): ArrayBuffer {
  const payload = encoder.encode(body);
  const buf = new ArrayBuffer(BILI_HEADER + payload.length);
  const view = new DataView(buf);
  view.setUint32(0, buf.byteLength, true);
  view.setUint16(4, BILI_HEADER, true);
  // protover = 1：让服务端发明文，省掉 brotli / zlib 解压依赖
  view.setUint16(6, 1, true);
  view.setUint32(8, op, true);
  view.setUint32(12, 1, true);
  new Uint8Array(buf).set(payload, BILI_HEADER);
  return buf;
}

interface BiliFrame {
  op: number;
  body: string;
}

function biliDecode(buf: ArrayBuffer): BiliFrame[] {
  const view = new DataView(buf);
  const frames: BiliFrame[] = [];
  let pos = 0;
  while (pos + BILI_HEADER <= buf.byteLength) {
    const total = view.getUint32(pos, true);
    const headerLen = view.getUint16(pos + 4, true);
    const protover = view.getUint16(pos + 6, true);
    const op = view.getUint32(pos + 8, true);
    if (total < headerLen || pos + total > buf.byteLength) break;
    // 2 / 3 是 zlib / brotli 压缩体；我们只要了 protover=1，遇到压缩帧跳过
    if (protover === 1 && total > headerLen) {
      frames.push({
        op,
        body: decoder.decode(new Uint8Array(buf, pos + headerLen, total - headerLen)),
      });
    }
    pos += total;
  }
  return frames;
}

interface Protocol {
  /** 建连地址候选（握手失败时按顺序轮换） */
  resolveUrls(): Promise<string[]>;
  /** 建连成功后要发的包 */
  greet(url: string): Array<ArrayBuffer | Uint8Array | string>;
  heartbeat?: { every: number; payload: () => ArrayBuffer | Uint8Array | string };
  frames(data: ArrayBuffer | string): DanmakuMsg[];
  /** 连上却迟迟没有弹幕时自愈：返回 true 表示需要换手势重连 */
  watchdog?: { after: number; stalled(): boolean };
}

// ── 虎牙：TARS 二进制协议 ──────────────────────────────

const TARS_INT8 = 0;
const TARS_INT16 = 1;
const TARS_INT32 = 2;
const TARS_INT64 = 3;
const TARS_FLOAT = 4;
const TARS_DOUBLE = 5;
const TARS_STRING1 = 6;
const TARS_STRING4 = 7;
const TARS_MAP = 8;
const TARS_LIST = 9;
const TARS_STRUCT_BEGIN = 10;
const TARS_STRUCT_END = 11;
const TARS_ZERO = 12;
const TARS_BYTES = 13;

const HUYA_WS = 'wss://cdnws.api.huya.com/';
const HUYA_REFERER = 'https://www.huya.com/';

/**
 * 虎牙心跳是固定帧（内部还嵌了「OnUserHeartBeat」等字段），
 * 直接用抓包字节，不参与序列化。
 */
const HUYA_HEARTBEAT = hexToBytes(
  '00031d0000690000006910032c3c4c56086f6e6c696e657569660f4f6e557365724865617274426561747d' +
    '00003c0800010604745265711d00002f0a0a0c1600260036076164725f77617046000b1203aef00f22' +
    '03aef00f3c426d5202605c60017c82000bb01f9cac0b8c980ca80c',
);

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

class TarsWriter {
  private readonly buf: number[] = [];

  private head(tag: number, type: number): void {
    if (tag < 15) {
      this.buf.push((tag << 4) | type);
    } else {
      this.buf.push(0xf0 | type);
      this.buf.push(tag & 0xff);
    }
  }

  private int16(v: number): void {
    this.buf.push((v >> 8) & 0xff, v & 0xff);
  }

  private int32(v: number): void {
    this.buf.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  }

  /** 整数按可容纳的最小类型写，跟官方 TarsOutputStream 的行为一致 */
  writeInt(tag: number, v: number): void {
    if (v === 0) {
      this.head(tag, TARS_ZERO);
      return;
    }
    if (v >= -128 && v <= 127) {
      this.head(tag, TARS_INT8);
      this.buf.push(v & 0xff);
      return;
    }
    if (v >= -32768 && v <= 32767) {
      this.head(tag, TARS_INT16);
      this.int16(v);
      return;
    }
    if (v >= -2147483648 && v <= 2147483647) {
      this.head(tag, TARS_INT32);
      this.int32(v);
      return;
    }
    this.head(tag, TARS_INT64);
    const big = BigInt(v);
    for (let i = 7; i >= 0; i--) {
      this.buf.push(Number((big >> BigInt(i * 8)) & 0xffn));
    }
  }

  /** 布尔在 Tars 里就是 int8 的 0/1 */
  writeBool(tag: number, v: boolean): void {
    this.head(tag, TARS_INT8);
    this.buf.push(v ? 1 : 0);
  }

  writeString(tag: number, s: string): void {
    const bytes = encoder.encode(s);
    if (bytes.length <= 255) {
      this.head(tag, TARS_STRING1);
      this.buf.push(bytes.length);
    } else {
      this.head(tag, TARS_STRING4);
      this.int32(bytes.length);
    }
    for (const b of bytes) this.buf.push(b);
  }

  writeBytes(tag: number, data: Uint8Array): void {
    this.head(tag, TARS_BYTES);
    this.int32(data.length);
    for (const b of data) this.buf.push(b);
  }

  writeStringList(tag: number, list: string[]): void {
    this.head(tag, TARS_LIST);
    this.writeInt(0, list.length);
    for (const s of list) this.writeString(0, s);
  }

  bytes(): Uint8Array {
    return new Uint8Array(this.buf);
  }

  buffer(): ArrayBuffer {
    return this.bytes().buffer as ArrayBuffer;
  }
}

type TarsValue = number | string | Uint8Array | Map<number, TarsValue> | TarsValue[];

/** 只做「把整段流读成 tag → 值」这一件事，够解析弹幕包了 */
class TarsReader {
  private pos = 0;

  constructor(private readonly buf: Uint8Array) {}

  private u8(): number {
    return this.pos < this.buf.length ? this.buf[this.pos++] : 0;
  }

  private take(n: number): Uint8Array {
    const end = Math.min(this.pos + n, this.buf.length);
    const slice = this.buf.subarray(this.pos, end);
    this.pos = end;
    return slice;
  }

  private int32(): number {
    return (this.u8() << 24) | (this.u8() << 16) | (this.u8() << 8) | this.u8();
  }

  private int64(): number {
    let v = 0n;
    for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(this.u8());
    return Number(BigInt.asIntN(64, v));
  }

  private head(): { tag: number; type: number } {
    const b = this.u8();
    const type = b & 0x0f;
    let tag = (b >> 4) & 0x0f;
    if (tag === 0x0f) {
      tag = this.u8();
      if (tag === 0xff) tag = (this.u8() << 8) | this.u8();
    }
    return { tag, type };
  }

  read(): Map<number, TarsValue> {
    const out = new Map<number, TarsValue>();
    while (this.pos < this.buf.length) {
      const { tag, type } = this.head();
      if (type === TARS_STRUCT_END) break;
      out.set(tag, this.value(type));
    }
    return out;
  }

  private value(type: number): TarsValue {
    switch (type) {
      case TARS_INT8:
        return (this.u8() << 24) >> 24;
      case TARS_INT16:
        return (((this.u8() << 8) | this.u8()) << 16) >> 16;
      case TARS_INT32:
        return this.int32();
      case TARS_INT64:
        return this.int64();
      case TARS_FLOAT: {
        const b = this.take(4);
        return new DataView(b.buffer, b.byteOffset, 4).getFloat32(0, false);
      }
      case TARS_DOUBLE: {
        const b = this.take(8);
        return new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, false);
      }
      case TARS_STRING1:
        return decoder.decode(this.take(this.u8()));
      case TARS_STRING4:
        return decoder.decode(this.take(this.int32()));
      case TARS_BYTES:
        return this.take(this.int32()).slice();
      case TARS_ZERO:
        return 0;
      case TARS_LIST: {
        const c = this.head();
        const n = Number(this.value(c.type)) || 0;
        const list: TarsValue[] = [];
        for (let i = 0; i < n; i++) {
          const e = this.head();
          list.push(this.value(e.type));
        }
        return list;
      }
      case TARS_MAP: {
        const c = this.head();
        const n = Number(this.value(c.type)) || 0;
        const map = new Map<number, TarsValue>();
        for (let i = 0; i < n; i++) {
          const k = this.head();
          const key = this.value(k.type);
          const v = this.head();
          map.set(Number(key), this.value(v.type));
        }
        return map;
      }
      case TARS_STRUCT_BEGIN:
        return this.read();
      default:
        return 0;
    }
  }
}

interface HuyaCtx {
  uid: string;
  channelId: string;
  subChannelId: string;
}

/** 房间页里的 lYyid / lUid 就是主播 uid，订阅 live:{uid} 靠它 */
function pickDigits(html: string, key: string): string {
  const m = html.match(new RegExp(`"${key}"\\s*:\\s*"?([0-9]{4,})`, 'i'));
  return m ? m[1] : '';
}

function parseHuyaCtx(html: string): HuyaCtx | null {
  const uid = pickDigits(html, 'lYyid') || pickDigits(html, 'lUid');
  if (!uid) return null;
  return {
    uid,
    channelId: pickDigits(html, 'lChannelId'),
    subChannelId: pickDigits(html, 'lSubChannelId'),
  };
}

async function fetchHuyaCtx(roomId: string): Promise<HuyaCtx | null> {
  for (const url of [`https://m.huya.com/${roomId}`, `https://www.huya.com/${roomId}`]) {
    try {
      const res = await httpText(url, {
        referer: HUYA_REFERER,
        timeoutMs: 9000,
        headers: { Accept: 'text/html' },
      });
      if (res.status < 200 || res.status >= 300) continue;
      const ctx = parseHuyaCtx(res.body);
      if (ctx) return ctx;
    } catch {
      /* 换下一个页面继续试 */
    }
  }
  return null;
}

/**
 * 虎牙有两种进房包：
 *   新版（op=16）内层是 `live:{uid}` / `chat:{uid}` 两条订阅，匿名可用；
 *   老版（op=1）内层写 uid + 频道 + 子频道，部分老房间才认。
 * 先发新版，12 秒内一条弹幕都没收到就换老版重连一次。
 */
function huyaProtocol(roomId: string): Protocol {
  let ctx: HuyaCtx | null = null;
  let variant: 0 | 1 = 0;
  let chats = 0;

  const joinNew = (uid: string): ArrayBuffer => {
    const inner = new TarsWriter();
    inner.writeStringList(0, [`live:${uid}`, `chat:${uid}`]);
    inner.writeString(1, '');
    const outer = new TarsWriter();
    outer.writeInt(0, 16);
    outer.writeBytes(1, inner.bytes());
    return outer.buffer();
  };

  const joinOld = (c: HuyaCtx): ArrayBuffer => {
    const inner = new TarsWriter();
    inner.writeInt(0, Number(c.uid) || 0);
    inner.writeBool(1, true);
    inner.writeString(2, '');
    inner.writeString(3, '');
    inner.writeInt(4, Number(c.channelId) || 0);
    inner.writeInt(5, Number(c.subChannelId) || 0);
    inner.writeInt(6, 0);
    inner.writeInt(7, 0);
    const outer = new TarsWriter();
    outer.writeInt(0, 1);
    outer.writeBytes(1, inner.bytes());
    return outer.buffer();
  };

  return {
    async resolveUrls() {
      if (!ctx) ctx = await fetchHuyaCtx(roomId);
      return ctx ? [HUYA_WS] : [];
    },
    greet: () => {
      chats = 0;
      if (!ctx) return [];
      if (variant === 0) return [joinNew(ctx.uid)];
      if (!ctx.channelId) return [joinNew(ctx.uid)];
      return [joinOld(ctx)];
    },
    heartbeat: { every: 60_000, payload: () => HUYA_HEARTBEAT },
    frames(data) {
      if (typeof data === 'string') return [];
      const msgs = huyaFrames(data);
      if (msgs.length) chats++;
      return msgs;
    },
    watchdog: {
      after: 12_000,
      stalled() {
        if (chats > 0 || variant === 1) return false;
        variant = 1;
        return true;
      },
    },
  };
}

/**
 * 弹幕包路径：op=7 → 内层 cmd=1400 → 内层 tag2 是用户名、tag3 是正文
 * 外层 tag0 是操作码，tag1 是内层二进制；内层 tag1 是命令字，tag2 是消息体
 */
function huyaFrames(data: ArrayBuffer): DanmakuMsg[] {
  const out: DanmakuMsg[] = [];
  const top = new TarsReader(new Uint8Array(data)).read();
  if (Number(top.get(0)) !== 7) return out;

  const payload = top.get(1);
  if (!(payload instanceof Uint8Array)) return out;

  const mid = new TarsReader(payload).read();
  if (Number(mid.get(1)) !== 1400) return out;

  const body = mid.get(2);
  if (!(body instanceof Uint8Array)) return out;

  const chat = new TarsReader(body).read();
  const user = chat.get(0);
  let name = '';
  if (user instanceof Map) {
    const n = user.get(2) ?? user.get(1);
    if (typeof n === 'string') name = n;
  } else if (typeof user === 'string') {
    name = user;
  }
  const text = chat.get(3);
  if (typeof text === 'string' && text) out.push({ text, name });
  return out;
}

function douyuProtocol(roomId: string): Protocol {
  return {
    async resolveUrls() {
      return DOUYU_PORTS.map((p) => `wss://danmuproxy.douyu.com:${p}/`);
    },
    greet: () => [
      douyuEncode({ type: 'loginreq', roomid: roomId }),
      douyuEncode({ type: 'joingroup', rid: roomId, gid: '-9999' }),
    ],
    heartbeat: { every: 40_000, payload: () => douyuEncode({ type: 'mrkl' }) },
    frames(data) {
      if (typeof data === 'string') return [];
      const out: DanmakuMsg[] = [];
      for (const body of douyuDecode(data)) {
        const f = sttParse(body);
        if (f.type === 'chatmsg' && f.txt) out.push({ text: f.txt, name: f.nn });
      }
      return out;
    },
  };
}

function biliProtocol(roomId: string): Protocol {
  let realRoom = Number(roomId) || 0;
  let key = '';
  let host = BILI_HOST;

  return {
    async resolveUrls() {
      try {
        const j = await httpJson<any>(
          `https://api.live.bilibili.com/room/v1/Room/room_init?id=${encodeURIComponent(roomId)}`,
          { timeoutMs: 8000, referer: BILI_REFERER },
        );
        if (Number(j?.data?.room_id) > 0) realRoom = Number(j.data.room_id);
      } catch {
        /* 短号换长号失败：按原房间号试一次 */
      }
      try {
        const j = await httpJson<any>(
          `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo` +
            `?id=${realRoom}&type=0`,
          { timeoutMs: 8000, referer: BILI_REFERER },
        );
        const h = j?.data?.host_list?.[0];
        if (typeof j?.data?.token === 'string') key = j.data.token;
        if (h?.host) host = String(h.host);
      } catch {
        /* 拿不到 token 时退回公共节点，部分房间仍可匿名订阅 */
      }
      return [`wss://${host}/sub`];
    },
    greet: () => [
      biliEncode(
        7,
        JSON.stringify({
          uid: 0,
          roomid: realRoom,
          protover: 1,
          platform: 'web',
          type: 2,
          key,
        }),
      ),
    ],
    heartbeat: {
      every: 30_000,
      payload: () => biliEncode(3, ''),
    },
    frames(data) {
      if (!(data instanceof ArrayBuffer)) return [];
      const out: DanmakuMsg[] = [];
      for (const frame of biliDecode(data)) {
        if (frame.op !== 5 || !frame.body) continue;
        let j: any;
        try {
          j = JSON.parse(frame.body);
        } catch {
          continue;
        }
        if (typeof j?.cmd !== 'string' || !j.cmd.startsWith('DANMU_MSG')) continue;
        const info = j.info;
        const text = Array.isArray(info) ? String(info[1] ?? '') : '';
        const name = Array.isArray(info?.[2]) ? String(info[2][1] ?? '') : '';
        if (text) out.push({ text, name });
      }
      return out;
    },
  };
}

/**
 * 建立一条弹幕连接
 *
 * 断线只自动重连一次：直播动辄几小时，反复重连反而拖累电量，
 * 一次失败就交给用户手动关掉再打开弹幕重试。
 */
export function connectDanmaku(opts: ConnectOptions): DanmakuSession {
  if (!danmakuSupported(opts.platform)) {
    opts.onStatus?.('unsupported');
    return { close() {} };
  }

  const gate = makeGate();
  const protocol =
    opts.platform === 'douyu'
      ? douyuProtocol(opts.roomId)
      : opts.platform === 'huya'
        ? huyaProtocol(opts.roomId)
        : biliProtocol(opts.roomId);

  let closed = false;
  let ws: WebSocket | null = null;
  let beat: number | null = null;
  let watchdog: number | null = null;
  let retryTimer: number | null = null;
  let attempt = 0;

  const emit = (msg: DanmakuMsg) => {
    if (closed) return;
    const text = sanitize(msg.text);
    if (!text || !gate()) return;
    opts.onMessage({ text, name: msg.name ? msg.name.slice(0, 16) : undefined });
  };

  const clearBeat = () => {
    if (beat != null) {
      window.clearInterval(beat);
      beat = null;
    }
  };

  const clearWatchdog = () => {
    if (watchdog != null) {
      window.clearTimeout(watchdog);
      watchdog = null;
    }
  };

  const open = async (urls: string[]) => {
    if (closed) return;
    const url = urls[0];
    if (!url) {
      opts.onStatus?.('error', '没有可用弹幕节点');
      return;
    }

    let sock: WebSocket;
    try {
      sock = new WebSocket(url);
    } catch {
      opts.onStatus?.('error', '无法建立弹幕连接');
      return;
    }
    sock.binaryType = 'arraybuffer';
    ws = sock;

    sock.onopen = () => {
      if (closed) {
        try {
          sock.close();
        } catch {
          /* noop */
        }
        return;
      }
      attempt = 0;
      opts.onStatus?.('open');
      try {
        for (const packet of protocol.greet(url)) sock.send(packet);
      } catch {
        /* noop */
      }
      if (protocol.heartbeat) {
        const { every, payload } = protocol.heartbeat;
        clearBeat();
        beat = window.setInterval(() => {
          if (sock.readyState === WebSocket.OPEN) {
            try {
              sock.send(payload());
            } catch {
              /* noop */
            }
          }
        }, every);
      }
      // 连上却一直没弹幕：让协议自己决定要不要换一套握手重连
      const wd = protocol.watchdog;
      if (wd) {
        clearWatchdog();
        watchdog = window.setTimeout(() => {
          watchdog = null;
          if (closed || !protocol.watchdog?.stalled()) return;
          try {
            sock.close();
          } catch {
            /* noop */
          }
        }, wd.after);
      }
    };

    sock.onmessage = (ev: MessageEvent) => {
      if (closed) return;
      try {
        for (const m of protocol.frames(ev.data)) emit(m);
      } catch {
        /* 单帧解析失败不影响后续弹幕 */
      }
    };

    sock.onerror = () => {
      if (closed) return;
      // 握手阶段失败：斗鱼换下一个端口再试
      if (sock.readyState !== WebSocket.OPEN && urls.length > 1) {
        try {
          sock.close();
        } catch {
          /* noop */
        }
        void open(urls.slice(1));
        return;
      }
      opts.onStatus?.('error', '弹幕连接失败');
    };

    sock.onclose = () => {
      clearBeat();
      clearWatchdog();
      if (closed) return;
      if (attempt >= 1) {
        opts.onStatus?.('error', '弹幕连接已断开');
        return;
      }
      attempt++;
      retryTimer = window.setTimeout(() => {
        if (!closed) void open(urls);
      }, 2500);
    };
  };

  const boot = async () => {
    opts.onStatus?.('connecting');
    let urls: string[] = [];
    try {
      urls = await protocol.resolveUrls();
    } catch {
      urls = [];
    }
    if (closed) return;
    await open(urls);
  };

  void boot();

  return {
    close() {
      closed = true;
      if (retryTimer != null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
      clearBeat();
      clearWatchdog();
      if (ws) {
        try {
          ws.close();
        } catch {
          /* noop */
        }
        ws = null;
      }
      opts.onStatus?.('idle');
    },
  };
}
