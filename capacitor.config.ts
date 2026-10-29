import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.sobertv.app',
  appName: 'Sober TV',
  webDir: 'dist',
  android: {
    allowMixedContent: true,
    backgroundColor: '#0A0A0A',
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0A0A0A',
      overlaysWebView: false,
    },
    // ── CapacitorHttp 的 enabled 开关：必须保持 false ──────────
    //
    // enabled=true 会全局劫持 window.fetch / XMLHttpRequest 走原生实现，
    // 而该实现会丢弃 responseType（见 native-bridge.js 的 readData 分支），
    // 导致 hls.js 拿到 base64 文本而非二进制分片 → 播放失败。
    //
    // enabled=false（当前设置）带来两个关键收益：
    //   1. XHR 不被劫持 → responseType 得以保留 → hls.js 能读到二进制分片
    //   2. 播放 CDN 实测带 Access-Control-Allow-Origin: * →
    //      WebView 内跨域拉清单和分片都能成功
    //
    // 所以分工是：
    //   接口层（CMS 采集接口，确实无 CORS）→ 显式调用 CapacitorHttp.request()
    //                                    （原生网络栈，无同源策略限制）
    //   播放层（播放 CDN，有 CORS）        → hls.js 在 WebView 内直接播
    CapacitorHttp: {
      enabled: false,
    },
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
