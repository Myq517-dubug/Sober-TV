# Sober TV

高端简约的 Android 影视客户端。曜石黑 + 薄荷绿，Material 3 Expressive 设计语言。

**v1.6.0 重点：继续观看入口、横屏全屏、播放记忆（集数+线路）、DLNA 投屏。**

---

## v1.6.0：四项新能力

### 1. 继续观看入口（首页）

首页 Hero 之后插入「继续观看」行，卡片带**进度条**、**集数角标**、
**剩余时长**与**上次线路**。

关键设计：**记忆里直接存片名与海报**，
所以这一行**不需要发任何网络请求**就能渲染 —— 首页不因它变慢。

### 2. 横屏全屏

- 原生插件 `ScreenOrientationPlugin`：`setRequestedOrientation(SENSOR_LANDSCAPE)`
  + `WindowInsetsControllerCompat` 沉浸式（隐藏状态栏与导航栏）
- Manifest 原本是 `fullUser`（跟随系统）—— 用户关了自动旋转就转不了，
  所以必须提供**主动**切换的入口
- 退出播放页自动恢复方向（不能把 App 永久留在横屏）
- 横屏时舞台尺寸重算（控制条改为浮在画面上，可用高度占满）

### 3. 播放记忆（集数 + 线路）

进详情页自动恢复：上次看到**第几集** + 上次用的**哪条线路**
（线路用 keep 语义，优先复用上次成功的那条）。

### 4. DLNA 投屏

**选型对比**：

| 方案 | 依赖 | 包体 | 国内可用性 | 控制能力 |
|---|---|---|---|---|
| **DLNA（采用）** | 系统自带 MediaRouter，**无 Google 服务** | +780KB | ✅ 电视/盒子即可 | 弱（进度不回传） |
| Google Cast | **强依赖 GMS** | +3MB | ❌ 无 GMS 的 ROM 装上也没用 | 强（可当遥控器） |

机制：把 m3u8 URL **推给电视端**，电视自己去拉流。
好处是**完全不经过手机的解码与 CORS 限制** —— 同一批源在电视端没有 CORS 问题。

入口在播放器控制条（与倍速/画质并列），点击弹出设备列表面板。

---

## 观看记忆的数据结构（v1.5.0 → v1.6.0 的重构）

```localStorage
sober.memory.<mediaId> → {
  title, poster, mediaType,   // 展示用（继续观看行零请求渲染）
  episode, keepLabel,          // 播放记忆：集数 + 线路
  position, duration,          // 续播：进度
  totalEpisodes,
  updatedAt
}
```

**为什么从「影片+集数」改成「影片」**：
v1.5.0 用 `sober.progress.<mediaId>.<episode>` 分集存储，
结果是「继续观看」行无法直接出行（一个剧会散成多条记录），
而且用户心智是「回来继续看这剧」而不是「继续看第 5 集」。
改为按影片组织后，一部剧只保留最新那集的进度。

旧数据在首次读取时自动迁移（`migrateLegacy`），用户不丢进度。

### 记忆的边界规则

| 规则 | 值 | 原因 |
|---|---|---|
| 少于 15 秒不记录 | `MIN_RECORD_SEC` | 避免误触产生垃圾记录 |
| 播放超 95% 视为看完 | `FINISHED_RATIO` | 不再出现在「继续观看」 |
| 续播回看 10 秒 | `REWIND_OFFSET` | 直接接上会漏掉开头 |
| 最多 60 条 | `MAX_RECORDS` | 按 `updatedAt` 淘汰 |

---

## v1.5.0：播放器组件

v1.4.0 把播放打通后，播放器只具备「返回 / 换源 / 全部线路」三个按钮 ——
连进度条和暂停都没有。这版补齐了完整的观看体验。

### 新增能力

| 能力 | 说明 | 实现 |
|---|---|---|
| **进度条** | 可拖动 seek，显示已播/总时长，缓冲进度单独一层 | `PlayerBar.tsx` |
| **播放/暂停** | 一键切换，图标随状态变化 | `PlayerBar.tsx` |
| **倍速** | 0.5× / 0.75× / 1× / 1.25× / 1.5× / 2× | `PlayerController.setPlaybackRate()` |
| **画质** | 多码率源可手动锁定，否则交给 ABR 自动 | `PlayerController.setQuality()` |
| **选集面板** | 底部抽屉式，集名来自季数据 | `episodes-panel` |
| **续播** | 自动跳到上次位置（回看 10 秒），并提示 | `src/lib/progress.ts` |
| **手势** | 单击显隐控制条、双击暂停、左右滑动快进退 | `PlayerGestures.tsx` |
| **屏幕常亮** | 播放时保持屏幕不熄灭 | 原生 `keepAwake()` |

### 几个关键设计决策

**1. 进度条用原生 `<input type="range">` 而非自绘**

触摸惯性、边界处理、无障碍、TV 遥控器焦点全都免费拿到。
自绘 div 要把这些重新实现一遍，且很难做对。

拖动时用 `scrubbing` 状态冻结进度显示，
否则会出现「手指还在拖、条子自己跳」的廉价感。

**2. 播放台按视频宽高比计算像素尺寸**

原先 video 直接 `100% × 100%` + `object-fit: contain`，
竖屏播横屏视频时上下有**大片黑边**，而控制条固定在屏幕最底部 → 离画面很远。

现在 JS 按 `videoWidth/videoHeight` 算出舞台的像素宽高
（`宽 = min(屏幕宽, 可用高 × 宽高比)`），控制条贴着**画面底边**而非屏幕底边。

> 踩坑：最初用 CSS `aspect-ratio` + `max-height` 实现，
> 两者互相约束导致画面被裁切 —— 改成 JS 直接算像素值才彻底解决。

**3. 「换一条线 / 全部线路」收进「更多」菜单**

原来它们独立浮在屏幕底部，和控制条分离，观感割裂。
现在统一在控制条右侧的「更多」里，与倍速/画质一致。

**4. 续播进度按「影片 id + 集数」分键存储**

```localStorage
sober.progress.<mediaId>.<episode> → { position, duration, updatedAt }
```

- 续播时从 `position - 10 秒` 开始（回看一点更符合习惯）
- 播放超过 95% 视为看完，不再提示续播
- 少于 15 秒不记录（避免误触产生垃圾数据）
- 最多保留 100 条，超出按时间淘汰

### 事实核查（都是实测，不是推测）

| 项 | 结论 |
|---|---|
| 手动切清晰度 | ⚠️ **这些源普遍单码率**（实测主清单只有 1 条 `EXT-X-STREAM-INF`）→ 手动切换意义不大，但 hls.js 的 **ABR 自动切换**有效，故做成「自动 / 手动」的混合档位 |
| 字幕 | ❌ **做不到**：m3u8 无 `EXT-X-MEDIA`，采集源也无字幕文件字段。虽拿到 `vod_douban_id`（如 36922748）可对接外部字幕源，但实测可用的字幕接口均不可达，故不做 |
| 屏幕常亮 | ⚠️ 原本只有原生引擎有（`FLAG_KEEP_SCREEN_ON` 设在 Dialog 上），Web 引擎下会息屏 → 新增对 Activity 窗口的 `keepAwake()` |

### 交互验证

用真实构建产物在 Chromium 里跑，逐项确认：

| 项 | 结果 |
|---|---|
| 控制条渲染 | ✅ 进度条 + 播放键 + 时间 + 倍速/选集/更多 |
| 暂停/恢复 | ✅ `paused: false → true → false` |
| **拖动 seek** | ✅ 从 9s 拖到 **1484s**（目标 1484，误差 0） |
| 倍速 | ✅ 选 1.5× → `video.playbackRate = 1.5` |
| 选集面板 | ✅ 打开并显示集数 |
| 更多菜单 | ✅ 「换一条线 / 全部线路（1）」 |
| 线路面板 | ✅ 打开并显示线路 |

---

## v1.4.0：播放架构修正（重要）

### 之前为什么错

v1.1 ~ v1.3 的结论是「**播放必须下沉到原生 ExoPlayer**」，依据是两条实测事实：

1. 公网影视源几乎全部不返回 `Access-Control-Allow-Origin`
2. CapacitorHttp 的 XHR 补丁会丢弃 `responseType`，hls.js 拿不到二进制分片

**这两条结论只对「CMS 采集接口」成立，对「播放 CDN」不成立。**
我当时只测了采集接口的响应头，**从没测过播放地址所在 CDN 的响应头** ——
这是整个三轮黑屏修复翻车的根源。

### 实测结论（两层证据）

**证据一 · 响应头实测**：逐源测播放 CDN，主清单 / 子清单 / 分片：

| 源 | 播放 CDN | 主清单 ACAO | 分片 ACAO |
|---|---|---|---|
| 非凡 | vod.ffzy-bofang.com | `*` | `*` |
| 电影天堂 | vip.dytt-cinema.com | `*` | `*` |
| 360资源 | vod1.maowushi.com | `*` | `*` |
| 豪华 | play.hhuus.com | `*` | `*` |
| 索尼 | v14.rstu6.com | `*` | ✗ 无 |
| 暴风 | v.fengbao14.com | `*` | ✗ 无 |

**证据二 · 真实浏览器实播**（Chromium，模拟 WebView 的 origin 与同源策略）：
4/4 源成功出画面，`FRAG_LOADED` 正常，抽帧确认画面有真实内容
（颜色块 150~250，非黑屏）。

同时，**用户真机的诊断页也印证了**：诊断用的 `m3u8 可访问` 是 WebView 原生 fetch
（`CapacitorHttp.enabled=false` 不劫持 XHR），却拿到 `HTTP 200 · 合法 HLS`。

而 `CapacitorHttp.enabled=false` 恰好让 XHR **不被劫持** → `responseType` 得以保留
→ hls.js 能正确读到二进制分片。当初「必须下沉原生」的第二个理由同样不成立。

### 现在的架构

```
接口层（CMS 采集接口，确实无 CORS）
  └─► CapacitorHttp.request()   原生网络栈，无同源策略限制

播放层（播放 CDN，实测带 ACAO: *）
  └─► hls.js 在 WebView 内直接播   画面就是 WebView 的一部分
        └─ 起播失败 → 自动降级原生 ExoPlayer（覆盖分片无 CORS 的少数源）
```

**收益**：画面直接渲染在 WebView 里，此前三轮黑屏修复引入的全部复杂度
（Dialog 承载 + TextureView + 触摸穿透 + Surface 层级）一次性消失 ——
那些问题本身就不该存在。

设置页提供「强制使用原生播放器」开关，应对个别线路始终无法起播的情况。

### 端到端验证

用真实构建产物在 Chromium 里跑完整应用（模拟原生网络栈 + 真实跨域播放）：

- 首页 17 行 / 140 卡片
- 详情页正确解析出 m3u8 线路
- 播放：`readyState=4`、**1998×1080**、时长 555s、`paused=false`
- 抽帧：21831 非黑采样 / 270 颜色块 → **有真实画面**

---

## v1.2.0 改了什么

用户反馈「资源太卡、加载不出来、类型不全」，实测定位到三个根因并逐一解决：

### 根因一：并发 ≠ 快（最主要）

旧实现对多个源用 `Promise.all`，总耗时 = **最慢那个源**的耗时。
只要有一个源不可达（要等满 10 秒超时），整屏就卡住 10 秒。

**实测对比**：

| | 优化前 | 优化后 |
|---|---|---|
| 片库列表 | 10.0s（等满超时） | **489ms** |
| 搜索 | 5.0s | **491ms** |
| 详情直连 | 247ms | 395ms |

**解法：竞速（race）** —— 第一个成功的源立刻用于渲染，其余在后台继续。
新增 `raceFirst()`（首个即返回）与 `raceWithTimeout()`（带上限的竞速），
见 `src/lib/cms.ts`。

### 根因二：分类表与列表串行两阶段

旧实现先取分类表（等 5s），再取列表（等 6s），累计 11 秒。
**解法：两阶段并行发起** —— 实测降到 6.08s，配合竞速后实际 489ms。

### 根因三：TMDB 被墙时拖垮首屏

实测 `api.themoviedb.org` 直连会挂到 20 秒超时（部分网络被墙），
而图片 CDN `image.tmdb.org` 是通的（2.4s）。
旧实现首页要等 TMDB 三个接口全失败才回落 CMS。

**解法：熔断 + 缓存秒开**
- TMDB 连续失败 2 次 → 本会话熔断，直接跳过，不再发请求
- 片库结果写 localStorage（TTL 10 分钟），二次启动直接渲染缓存
- 首页「重试」按钮会清缓存并重置熔断

### 附带：源池从 2 个扩到 9 个

实测逐站探测后，可用源从 2 个扩到 **6-9 个**（随网络波动），
片库总量从 4.9 万 → **57 万条**，覆盖电影/剧集/综艺/动漫/纪录片：

| 源 | 片库量 | 状态 |
|---|---|---|
| 暴风资源 | 166,945 | ⚠️ 时通时断 |
| 索尼资源 | 147,647 | ✅ |
| 豪华资源 | 115,661 | ✅ |
| 非凡资源 | 98,817 | ✅ |
| 魔都资源 | 90,835 | ⚠️ 时通时断 |
| 电影天堂 | 84,820 | ✅ |
| 360资源 | 73,849 | ✅ |
| 百度资源 | 49,457 | ✅ |
| 卧龙资源 | — | ⚠️ 解析异常 |

失效源由 `probeSources()` 运行时探测并自动剔除，不会拖慢解析。

---

## 用户自行添加聚合资源链接

**设置 → 影视资源源 → 管理资源源**（或直接进入「资源源」页）

支持粘贴任意苹果 CMS / MacCMS V10 标准接口地址：

```
https://example.com/api.php/provide/vod/
https://example.com/inc/api.php/provide/vod/
example.com                          ← 裸域名自动补全
https://example.com/api.php/provide/vod/?ac=list   ← 自动去掉查询串
```

**添加流程**：
1. 粘贴地址 → 点「测试」→ 立即探测可用性、总条目数、延迟，
   并**实际拉一条详情验证是否有 m3u8 播放地址**
2. 点「添加」→ 存入 localStorage
3. 自建源**权重高于内置源**（用户主动添加的优先使用）
4. 可随时重命名（双击名称）、禁用、删除、重新探测

自建源与内置源合并成统一源池，一同参与片库浏览与播放解析。

---

## 技术栈

| 层 | 选型 |
|---|---|
| 客户端 | Capacitor 7 + React 19 + TypeScript + Vite 6 |
| 元数据 | TMDB 官方 API（增强，可熔断） |
| 播放源 | 苹果 CMS（MacCMS V10）公网采集接口，9 内置 + N 自建 |
| 播放器 | **hls.js（默认，WebView 内直连）** / 原生 Media3 ExoPlayer（自动兜底） |
| 网络 | CapacitorHttp 原生 HTTP（绕开 CORS） |
| 播放器 UI | 自研 `PlayerBar`（原生 range 进度条）+ `PlayerGestures`（手势） |
| 观看记忆 | localStorage（按影片 id 分键，60 条 LRU，含集数+线路+海报） |
| 投屏 | `androidx.mediarouter` 1.7.0（DLNA，RemotePlaybackClient，+780KB） |
| 签名 | 自有 keystore（RSA 2048，30 年） |

---

## 为什么播放必须下沉到原生

三个实测事实决定了这个架构：

### 1. 公网采集源几乎全部不返回 CORS 头

实测 `caiji.dyttzyapi.com`、`cj.ffzyapi.com` 等源的响应头中
**没有 `Access-Control-Allow-Origin`**（只有 TVmaze 这类正规 API 带 `*`）。

Capacitor Android WebView 的 origin 是 `https://localhost`，
跨域 XHR 会被浏览器直接拦截 —— 表现为「所有接口都超时」。

**解决**：接口调用走 `CapacitorHttp.request()`（原生网络栈，无同源策略约束），
见 `src/lib/net.ts`。

### 2. CapacitorHttp 的 XHR 补丁会丢弃 `responseType`

Capacitor 提供的「全局劫持 fetch/XHR」补丁（`native-bridge.js`）中：

```js
if (this.responseType === '' || this.responseType === 'text') {
    this.response = typeof nativeResponse.data !== 'string' ? ... : nativeResponse.data;
} else {
    this.response = nativeResponse.data;   // arraybuffer 场景下拿到的是 base64 文本
}
```

hls.js 拉 `.ts` 分片依赖 `responseType='arraybuffer'`，
走这条补丁会拿到 base64 字符串而非二进制 —— **播放必然损坏**。

**解决**：`capacitor.config.ts` 里刻意把 `CapacitorHttp.enabled` 设为 `false`，
不启用全局劫持；只显式调用 `CapacitorHttp.request()`。

### 3. 分片与加密交给 ExoPlayer

原生 ExoPlayer 走系统网络栈，天然无 CORS 约束；
HLS 切片、AES-128 加密、多码率自适应、缓冲策略均由它负责。

实现见 `android/app/src/main/java/com/sobertv/app/NativePlayerPlugin.java`，
JS 封装见 `src/player/nativePlayer.ts`。

---

## 数据链路

```
TMDB(元数据·可熔断)                CMS 采集接口(播放地址)
  trending/popular  ──┐             ?ac=list         → 列表
  search/multi        │             ?ac=list&wd=片名 → 搜索
  movie/{id}          │             ?ac=detail&ids=  → 详情
  tv/{id}            │             ?ac=type         → 分类表
                      │                    │
                      │   中文档名关联（resolve.ts）
                      └─────────┬──────────┘
                                ▼
                    vod_play_url 解析
                    "第1集$url#第2集$url"  +  "$$$" 分隔多线路
                                ▼
                    过滤出 m3u8 直链线路
                                ▼
                    hls.js 在 WebView 内起播
                    （失败 → 原生 ExoPlayer 兜底 → 再失败则顺延下一条）
```

### 片名关联

TMDB 与 CMS 是两套独立数据体系，没有共同 ID。
TMDB 的中文译名（`language=zh-CN`）与 CMS 片名高度重合，
实测「流浪地球」在 CMS 精确命中，是可靠的关联键。

匹配打分（`resolve.ts` 的 `titleScore`）：

| 情况 | 分数 |
|---|---|
| 完全相等 | 100 |
| 前缀匹配 | 80 − 长度差 |
| 包含匹配 | 60 − 长度差 |
| 不匹配 | 0（直接排除） |

### 分类 id 跨源不通用

实测各源 type_id 完全不同（ff 是 1-26、360zy 是 27-38、hhzy 是 45-53），
所以**不能硬编码分类 id**，必须先取 `?ac=type` 分类表再**按名称匹配**
（`matchTypeId`）。

---

## 核心设计：播放链路容错

**护城河不在 UI，在「选到源但播不出来」时的容错工程。**

### 线路体检（`src/providers/health.ts`）

- m3u8 / mp4 直链**免探测**（冷链路探测会白等 0.3~0.5s）
- 探测失败**不阻断**，标记为 `unknown` 交给播放器尝试 —— 避免误杀好源
- 5 分钟 LRU 缓存，避免重复探测

### keep 语义：保持当前源优先

用户手动选的源在自动下一集时不重置，失效了才顺延。
这是最反直觉但最正确的设计 —— 直接跳到「最优源」会打断观看连续性。

### 失败自动顺延

```
播放失败 → 体检该线路 → 死链直接跳过 → 顺延下一条（最多试 8 条）
```

顺延时用户无感，仅以轻提示告知「已切换到 XX」。

### 详情页直连解析

从片库点进详情时，条目本身带 `sourceId + vodId`，
**直接取播放地址**（`resolveDirect`），跳过按片名跨源搜索 ——
搜索是详情页最慢的一步。直连失败才回落到跨源搜索。

---

## 目录结构

```
SoberTV/
├── src/
│   ├── theme/tokens.ts          设计令牌（曜石黑 + 薄荷绿）
│   ├── styles/global.css        全局基座 + Expressive 动效原语
│   ├── components/              PosterCard / Button
│   ├── screens/                 Home / Search / Detail / Library / Settings / Sources
│   ├── providers/               源契约 / 体检 / 分批并发加载
│   ├── player/                  PlayerController / sourceSelector / nativePlayer
│   └── lib/
│       ├── net.ts               原生 HTTP 封装（绕 CORS）
│       ├── tmdb.ts              TMDB 客户端（含内置密钥）
│       ├── cms.ts               CMS 客户端 + 竞速 + 源健康探测
│       ├── customSources.ts     用户自定义源管理
│       ├── resolve.ts           片名关联 + 播放地址解析 + 直连解析
│       ├── catalogue.ts         片库数据层（缓存 + CMS + TMDB）
│       └── api.ts               本地偏好存储（黑名单）
├── android/
│   └── app/src/main/java/com/sobertv/app/
│       ├── MainActivity.java          注册原生播放器插件
│       └── NativePlayerPlugin.java    Media3 ExoPlayer 封装
├── server/test/
│   ├── algorithms.test.mjs      纯算法单测
│   ├── public.test.mjs          公网链路集成测试
│   ├── perf.test.mjs            性能基线测试
│   ├── perf2.test.mjs           首屏性能实测
│   └── race.test.mjs            竞速策略实测
└── scripts/split-apk.mjs        APK 分发脚本
```

---

## 构建

### 环境要求

- Node.js 22+
- JDK 21（`C:\Program Files\Microsoft\jdk-21.0.12.101-hotspot`）
- Android SDK（`D:\android-sdk`，需 platforms;android-35 与 build-tools;35.0.0）

### 一键构建

```bat
build-apk.bat              REM release APK
build-apk.bat debug        REM debug APK
```

### 手动步骤

```bat
npm install
npm run build              REM 构建前端
REM 同步到原生（Windows 下 cap sync 会被 safe-delete 保护拦截，故手动复制）
xcopy /E /I /Y dist android\app\src\main\assets\public
cd android
gradlew.bat assembleRelease
```

产物位于 `android/app/build/outputs/apk/release/`。

> 注：Capacitor 应用不含原生 `.so` 库，按 ABI 拆包产出的多个 APK 内容完全相同，
> 因此本项目**不启用 splits**，只出单一 universal 包。

---

## 测试

```bat
node --test server/test/algorithms.test.mjs   REM 纯算法单测
node --test server/test/public.test.mjs       REM 公网链路集成测试
node --test server/test/race.test.mjs         REM 竞速策略实测
node --test server/test/perf2.test.mjs        REM 首屏性能实测
```

`public.test.mjs` 直接打真实公网接口，验证：

1. 内置源池至少 3 个可用、片库总量超 10 万
2. 分类接口可用，且能按名称匹配出跨源通用分类
3. 每个可用源都能独立解析出 m3u8 地址
4. m3u8 清单本身可访问且是合法 HLS
5. 地址规范化能把各种写法统一成标准接口路径

`race.test.mjs` / `perf2.test.mjs` 验证竞速与缓存的实际耗时。

---

## 已知限制

| 限制 | 说明 |
|---|---|
| 采集站域名易变 | 源会迁移/关闭，故有运行时健康探测；仍可能需手动添加新源 |
| 无 CORS 头 | 接口调用必须走原生 HTTP，浏览器直接调试 Web 版会失败 |
| 片名关联 | TMDB 与 CMS 无共同 ID，靠中文片名匹配；译名差异大的冷门片可能匹配不到 |
| 列表接口无海报 | CMS 列表只返回 8 个精简字段，海报要逐条查详情（已限并发 4） |
| TMDB 密钥公开 | 内置密钥随 APK 分发，设置页可让用户自填覆盖 |
| 广告过滤默认关闭 | 误杀正片的代价大于放过广告，默认「标注不拦截」 |
| 未真机验证 | 原生 ExoPlayer 播放链路只做了编译期与打包期验证 |

---

## 许可

源码自有。设计思路借鉴自以下开源项目（**仅借鉴思路，未复制代码**）：

- AIStream —— 线路体检 / 自动顺延 / 插播广告识别
- flixquest (GPL-3.0) —— Provider 统一契约 / 分批并发加载
- Nivio (MIT) —— 极简源契约 / 本地推荐
- CineMax —— 源配置外置

内容来源由使用者自行配置与承担。使用采集站请遵守当地法律法规与版权规定。
