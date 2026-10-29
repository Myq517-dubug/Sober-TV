# Sober TV 服务端部署

零依赖 Node 服务，源码自带 Dockerfile。

---

## 本机运行

```bat
npm run server
```

默认监听 `0.0.0.0:8787`，局域网内其他设备可访问。

```bat
npm run server:dev        REM 开发模式（文件变更自动重启）
node server/start.mjs --port 9000   REM 指定端口
```

---

## Docker 部署

```bash
# 构建
docker build -t sober-tv-server .

# 运行
docker run -d --name sober-tv \
  -p 8787:8787 \
  -v $(pwd)/server/config:/app/config \
  -v $(pwd)/server/data:/app/data \
  sober-tv-server
```

挂载两个目录：

- `/app/config` —— 源配置，宿主机改完 5 秒内自动热更
- `/app/data` —— 黑名单等运行时状态

---

## 反向代理

```nginx
server {
    listen 80;
    server_name sober.example.com;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;

        # 直播/长连接需要关闭缓冲
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}
```

---

## 客户端连接

App 内「设置 → 聚合服务端」填地址：

| 场景 | 地址 |
|---|---|
| Android 模拟器访问宿主机 | `http://10.0.2.2:8787` |
| 真机访问同一局域网 | `http://192.168.x.x:8787` |
| 域名访问 | `https://sober.example.com` |

---

## 源配置

编辑 `server/config/sources.json`，保存后服务端自动热更（5 秒内），无需重启。

### 三种源类型

**direct —— 直连固定地址**

```json
{
  "id": "my-cdn",
  "name": "我的 CDN",
  "type": "direct",
  "categories": ["movie", "tv"],
  "enabled": true,
  "order": 50,
  "weight": 990,
  "official": true,
  "url": "https://cdn.example.com/master.m3u8"
}
```

**aggregator —— 苹果 CMS 采集站**

```json
{
  "id": "cms-station",
  "name": "某某采集站",
  "type": "aggregator",
  "categories": ["movie", "tv", "anime"],
  "endpoint": "https://example.com/api.php/provide/vod",
  "enabled": true,
  "order": 100,
  "weight": 800
}
```

**scraper —— 自建刮削 API**

```json
{
  "id": "my-scraper",
  "name": "自建刮削",
  "type": "scraper",
  "categories": ["movie"],
  "endpoint": "https://api.example.com/scrape",
  "enabled": true,
  "order": 150,
  "weight": 700
}
```

刮削 API 约定：

```
GET {endpoint}?type={mediaType}&id={mediaId}&season={n}&episode={n}
```

返回：

```json
[
  {
    "url": "https://cdn.example.com/movie/master.m3u8",
    "quality": "1080P",
    "label": "线路 A · 1080P",
    "headers": { "Referer": "https://example.com" },
    "subtitles": [{ "url": "https://cdn.example.com/sub.vtt", "lang": "zh" }]
  }
]
```

### 字段说明

| 字段 | 说明 |
|---|---|
| `id` | 唯一标识，不可重复 |
| `name` | 展示名 |
| `type` | `direct` / `scraper` / `aggregator` |
| `categories` | 覆盖分类：`movie` `tv` `anime` `live` `variety` `doc` |
| `enabled` | 是否启用 |
| `order` | 排序权重，越小越靠前（默认 500） |
| `weight` | 线路优先级，越大越优先（官方线路建议 990+） |
| `official` | 是否官方线路，影响排序与 UI 标注 |

---

## 线路黑名单

```bash
# 查看
curl http://127.0.0.1:8787/api/blocks

# 拉黑
curl -X POST http://127.0.0.1:8787/api/blocks \
  -H "Content-Type: application/json" \
  -d '{"label":"某采集站"}'

# 解黑
curl -X POST http://127.0.0.1:8787/api/blocks \
  -H "Content-Type: application/json" \
  -d '{"label":"某采集站","action":"unblock"}'
```

App 内「片库 → 线路管理」也可查看。

---

## 运维

```bash
curl http://127.0.0.1:8787/api/healthz   # 健康检查
curl http://127.0.0.1:8787/api/logs      # 最近 200 条日志
curl -X POST http://127.0.0.1:8787/api/config/reload   # 手动触发热更
```

---

## 安全提示

1. **服务端会代理 m3u8 与采集站请求** —— 请勿暴露在公网而不加鉴权，否则可能被当作跳板
2. **远程配置热更是攻击面** —— 生产环境建议给 `config/sources.json` 加签名校验，或只允许内网访问
3. **采集站内容的版权与合规由使用者自行承担** —— 服务端默认不内置任何站点地址
