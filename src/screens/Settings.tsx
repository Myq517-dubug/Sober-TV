import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../components/Button';
import { CMS_SOURCES, probeSources } from '../lib/cms';
import { loadCustomSources } from '../lib/customSources';
import { DEFAULT_TMDB_KEY, getTmdbKey, setTmdbKey } from '../lib/tmdb';
import { isNativePlatformOnly } from '../player/nativePlayer';
import { AUDIO_EFFECTS, readAudioEffect, type AudioEffect } from '../player/audioFx';
import './Settings.css';

/**
 * 设置页（公网直连模式）
 * - 资源源管理入口（内置源 + 自建源）
 * - TMDB Key（片库元数据）
 * - 公网采集源健康状态
 * - 播放偏好
 *
 * 说明：本版本不再依赖自建服务端与隧道，全部资源走公网接口直连。
 */

interface SourceStatus {
  id: string;
  name: string;
  ok: boolean;
  total?: number;
  latencyMs?: number;
  error?: string;
}

export function Settings() {
  const navigate = useNavigate();
  const [tmdbKey, setTmdbKeyInput] = useState(getTmdbKey());
  const [sources, setSources] = useState<SourceStatus[]>([]);
  const [customCount, setCustomCount] = useState(0);
  const [checking, setChecking] = useState(false);
  const [saved, setSaved] = useState(false);

  const [autoNext, setAutoNext] = useState(localStorage.getItem('sober.autoNext') !== '0');
  const [stripAds, setStripAds] = useState(localStorage.getItem('sober.stripAds') === '1');
  const [skipIntro, setSkipIntro] = useState(localStorage.getItem('sober.skipIntro') === '1');
  const [skipIntroSec, setSkipIntroSec] = useState(
    Number(localStorage.getItem('sober.skipIntroSec') || 90),
  );
  const [skipOutroSec, setSkipOutroSec] = useState(
    Number(localStorage.getItem('sober.skipOutroSec') || 30),
  );
  const [forceNativeEngine, setForceNativeEngine] = useState(
    localStorage.getItem('sober.forceNativeEngine') === '1',
  );
  /** 播放时自动横屏全屏（默认开启） */
  const [autoLandscape, setAutoLandscape] = useState(
    localStorage.getItem('sober.autoLandscape') !== '0',
  );
  /** 横屏全屏铺满（默认开启）：开启走 cover 裁切，关闭走 contain 完整显示 */
  const [videoFillMode, setVideoFillMode] = useState(
    localStorage.getItem('sober.videoFillMode') !== '0',
  );
  /** 音效增强（原声 / 杜比 / 环绕 / 人声 / 低音） */
  const [audioEffect, setAudioEffect] = useState<AudioEffect>(() => readAudioEffect());
  /** 字幕默认开启 */
  const [subtitleOn, setSubtitleOn] = useState(
    localStorage.getItem('sober.subtitleOn') !== '0',
  );
  const [subtitleSize, setSubtitleSize] = useState(
    localStorage.getItem('sober.subtitleSize') || 'md',
  );
  const [subtitleBg, setSubtitleBg] = useState(
    localStorage.getItem('sober.subtitleBg') || 'shadow',
  );

  useEffect(() => {
    void checkSources();
    setCustomCount(loadCustomSources().filter((s) => s.enabled !== false).length);
  }, []);

  /** 逐个探测采集源可用性 */
  async function checkSources() {
    setChecking(true);
    const results = await probeSources();
    setSources(
      results.map((h) => {
        const meta = CMS_SOURCES.find((s) => s.id === h.id);
        return {
          id: h.id,
          name: meta?.name.trim() ?? h.id,
          ok: h.ok,
          total: h.total,
          latencyMs: h.latencyMs,
          error: h.ok ? undefined : '连接失败',
        } as SourceStatus;
      }),
    );
    setChecking(false);
  }

  function save() {
    setTmdbKey(tmdbKey.trim());
    localStorage.setItem('sober.autoNext', autoNext ? '1' : '0');
    localStorage.setItem('sober.stripAds', stripAds ? '1' : '0');
    localStorage.setItem('sober.skipIntro', skipIntro ? '1' : '0');
    localStorage.setItem('sober.skipIntroSec', String(skipIntroSec));
    localStorage.setItem('sober.skipOutroSec', String(skipOutroSec));
    localStorage.setItem('sober.autoLandscape', autoLandscape ? '1' : '0');
    localStorage.setItem('sober.videoFillMode', videoFillMode ? '1' : '0');
    localStorage.setItem('sober.audioEffect', audioEffect);
    localStorage.setItem('sober.subtitleOn', subtitleOn ? '1' : '0');
    localStorage.setItem('sober.subtitleSize', subtitleSize);
    localStorage.setItem('sober.subtitleBg', subtitleBg);
    // 播放内核偏好：强制原生 / 默认 Web 优先
    if (forceNativeEngine) localStorage.setItem('sober.forceNativeEngine', '1');
    else localStorage.removeItem('sober.forceNativeEngine');
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="settings">
      <header className="settings__head">
        <h1 className="settings__title">设置</h1>
      </header>

      {/* ── 资源源管理 ── */}
      <section className="card">
        <div className="card__head">
          <h2 className="card__title">影视资源源</h2>
          <span className={`status ${checking ? '' : sources.some((s) => s.ok) ? 'is-up' : 'is-down'}`}>
            {checking ? '检测中' : sources.some((s) => s.ok) ? '可用' : '不可用'}
          </span>
        </div>
        <p className="card__desc">
          播放地址直接来自公网采集接口，无需自建服务端或隧道。可自行添加新的聚合资源链接。
        </p>

        <div className="source-list">
          {sources.length === 0 && !checking && <p className="card__note">尚未检测</p>}
          {sources.map((s) => (
            <div className="source-item" key={s.id}>
              <span className={`source-item__dot ${s.ok ? 'is-up' : 'is-down'}`} aria-hidden="true" />
              <div className="source-item__text">
                <p className="source-item__name">{s.name}</p>
                <p className="source-item__meta">
                  {s.ok
                    ? `可用 · ${s.total?.toLocaleString() ?? '—'} 条资源 · ${s.latencyMs}ms`
                    : `不可用 · ${s.error || '连接失败'}`}
                </p>
              </div>
            </div>
          ))}
        </div>

        <div className="card__actions">
          <Button variant="outlined" size="sm" onClick={checkSources} loading={checking}>
            重新检测
          </Button>
          <Button variant="filled" size="sm" onClick={() => navigate('/sources')}>
            管理资源源{customCount > 0 ? `（我的 ${customCount}）` : ''}
          </Button>
        </div>
      </section>

      {/* ── 元数据 ── */}
      <section className="card">
        <div className="card__head">
          <h2 className="card__title">TMDB 接口密钥</h2>
        </div>
        <p className="card__desc">
          可选的增强项：提供评分与简介。片库与播放不依赖它。
          <br />
          <strong style={{ color: 'var(--text-tertiary, #7b8380)', fontWeight: 400 }}>
            注意：TMDB 在部分网络下是域名/IP 双重封锁（实测解析到无关地址、直连真实 IP 也超时），
            此时会自动熔断并改用采集源片库，不影响使用。可在诊断页「重试 TMDB」手动恢复。
          </strong>
        </p>
        <div className="field">
          <input
            className="field__input"
            type="password"
            placeholder={DEFAULT_TMDB_KEY}
            value={tmdbKey}
            onChange={(e) => setTmdbKeyInput(e.target.value)}
            autoComplete="off"
          />
        </div>
        <p className="card__note">
          密钥保存在本机 localStorage。注意：内置密钥会随 APK 一起分发，正式发布建议让用户自填。
        </p>
      </section>

      {/* ── 诊断 ── */}
      <section className="card">
        <div className="card__head">
          <h2 className="card__title">网络与播放诊断</h2>
        </div>
        <p className="card__desc">
          一键检测元数据接口、各采集源、搜索、详情与播放清单的实际连通情况。
          遇到「搜不到 / 加载慢 / 黑屏」时先跑这个。
        </p>
        <div className="card__actions">
          <Button variant="outlined" size="sm" onClick={() => navigate('/diagnostics')}>
            打开诊断
          </Button>
        </div>
      </section>

      {/* ── 播放偏好 ── */}
      <section className="card">
        <div className="card__head">
          <h2 className="card__title">播放偏好</h2>
        </div>

        <Toggle
          label="自动续播下一集"
          desc="当前集播完自动进入下一集，并保持当前线路"
          checked={autoNext}
          onChange={setAutoNext}
        />
        <Toggle
          label="过滤插播广告"
          desc="识别并跳过 m3u8 清单中的广告切片（默认关闭以免误判）"
          checked={stripAds}
          onChange={setStripAds}
        />
        <Toggle
          label="自动跳过片头"
          desc="起播后按下方设置的时长跳过片头；断点续播时不跳，避免丢进度"
          checked={skipIntro}
          onChange={setSkipIntro}
        />
        {skipIntro && (
          <div className="skip-row">
            <label className="skip-row__item">
              <span className="skip-row__label">片头时长</span>
              <select
                className="skip-row__select"
                value={skipIntroSec}
                onChange={(e) => setSkipIntroSec(Number(e.target.value))}
              >
                {[30, 60, 90, 120].map((s) => (
                  <option key={s} value={s}>
                    {s} 秒
                  </option>
                ))}
              </select>
            </label>
            <label className="skip-row__item">
              <span className="skip-row__label">片尾提前</span>
              <select
                className="skip-row__select"
                value={skipOutroSec}
                onChange={(e) => setSkipOutroSec(Number(e.target.value))}
              >
                {[0, 15, 30, 60].map((s) => (
                  <option key={s} value={s}>
                    {s === 0 ? '关闭' : `${s} 秒`}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        <Toggle
          label="播放时自动横屏全屏"
          desc="起播后自动切到横屏并隐藏状态栏、导航栏；关闭后保持竖屏"
          checked={autoLandscape}
          onChange={setAutoLandscape}
        />
        <Toggle
          label="横屏全屏铺满屏幕"
          desc="开启后画面等比放大铺满整屏，超出屏幕的边缘会被裁掉（推荐）；关闭则保留完整画面，两侧或上下可能有黑边"
          checked={videoFillMode}
          onChange={setVideoFillMode}
        />
      </section>

      {/* ── 关于 ── */}
      <section className="card">
        <div className="card__head">
          <h2 className="card__title">关于</h2>
        </div>
        <div className="about">
          <div className="about__logo">
            <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
              <rect x="3" y="7" width="26" height="18" rx="5" fill="none" stroke="currentColor" strokeWidth="1.8" />
              <path d="M13 12.5v7l6-3.5-6-3.5Z" fill="currentColor" />
            </svg>
          </div>
          <div>
            <p className="about__name">Sober TV</p>
            <p className="about__ver">v1.1.0 · 曜石黑 / 薄荷绿</p>
          </div>
        </div>
        <p className="card__note">
          播放引擎：
          {forceNativeEngine
            ? '原生 Media3 ExoPlayer（强制）'
            : isNativePlatformOnly()
              ? 'hls.js（WebView 内直连，失败自动降级原生）'
              : 'hls.js（浏览器预览模式）'}
          。链路含线路体检、失败自动顺延与多源冗余。
        </p>
      </section>

      {/* ── 音效与字幕 ── */}
      <section className="card">
        <div className="card__head">
          <h2 className="card__title">音效与字幕</h2>
        </div>
        <p className="card__desc">
          音效走系统音频链路（原生播放器）或 Web Audio（应用内引擎），无需额外权限；
          杜比/环绕为等效听感模拟，非厂商私有音效。
        </p>

        <div className="skip-row">
          <label className="skip-row__item">
            <span className="skip-row__label">音效增强</span>
            <select
              className="skip-row__select"
              value={audioEffect}
              onChange={(e) => setAudioEffect(e.target.value as AudioEffect)}
            >
              {AUDIO_EFFECTS.map((fx) => (
                <option key={fx.id} value={fx.id}>
                  {fx.label}
                </option>
              ))}
            </select>
          </label>
          <label className="skip-row__item">
            <span className="skip-row__label">字幕字号</span>
            <select
              className="skip-row__select"
              value={subtitleSize}
              onChange={(e) => setSubtitleSize(e.target.value)}
            >
              <option value="sm">小</option>
              <option value="md">标准</option>
              <option value="lg">大</option>
            </select>
          </label>
        </div>

        <div className="skip-row">
          <label className="skip-row__item">
            <span className="skip-row__label">字幕背景</span>
            <select
              className="skip-row__select"
              value={subtitleBg}
              onChange={(e) => setSubtitleBg(e.target.value)}
            >
              <option value="shadow">描边阴影（推荐）</option>
              <option value="box">半透明底板</option>
              <option value="none">无背景</option>
            </select>
          </label>
        </div>

        <Toggle
          label="默认显示字幕"
          desc="导入字幕后自动显示；关闭后仍保留字幕文件，可在播放页「更多 → 字幕」重新打开"
          checked={subtitleOn}
          onChange={setSubtitleOn}
        />

        <p className="card__note">
          播放页「更多」里可以导入本地 SRT / VTT 或粘贴字幕链接，字幕按影片分开保存（最多 5 部）。
        </p>
      </section>

      {/* ── 播放内核 ── */}
      <section className="card">
        <div className="card__head">
          <h2 className="card__title">播放内核</h2>
        </div>
        <p className="card__desc">
          默认使用 hls.js 在应用内直接播放（实测播放 CDN 允许跨域，画面最稳定）。
          若某些线路的分片被跨域策略拦截，会自动切换到原生播放器兜底。
          你也可以强制只用原生播放器。
        </p>

        <Toggle
          label="强制使用原生播放器"
          desc="默认关闭。开启后所有线路都用原生 Media3 ExoPlayer 播放，适合个别线路在应用内核内始终无法起播的情况。"
          checked={forceNativeEngine}
          onChange={setForceNativeEngine}
        />
      </section>

      <div className="settings__foot">
        <Button variant="filled" size="lg" onClick={save}>
          {saved ? '已保存' : '保存设置'}
        </Button>
      </div>
    </div>
  );
}

function Toggle({
  label,
  desc,
  checked,
  onChange,
}: {
  label: string;
  desc?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="toggle-row">
      <div className="toggle-row__text">
        <p className="toggle-row__label">{label}</p>
        {desc && <p className="toggle-row__desc">{desc}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`switch ${checked ? 'is-on' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span className="switch__thumb" />
      </button>
    </div>
  );
}
