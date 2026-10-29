/**
 * 音效增强
 *
 * 两套引擎各自实现，听感对齐：
 *   · 原生引擎 → Android 系统 audiofx（Equalizer / BassBoost / Virtualizer /
 *     LoudnessEnhancer），见 NativeAudioFx.java
 *   · Web 引擎  → Web Audio API 的滤波 + 压缩器 + 交叉延迟声场
 *
 * 说明：厂商的「杜比/DTS」是私有实现，没有公开 API。
 * 这里用均衡器曲线 + 响度补偿组合出接近的听感，所有设备可用。
 */

export type AudioEffect = 'off' | 'dolby' | 'spatial' | 'dialog' | 'bass';

export const AUDIO_EFFECTS: { id: AudioEffect; label: string; desc: string }[] = [
  { id: 'off', label: '原声', desc: '不做任何处理' },
  { id: 'dolby', label: '杜比全景', desc: '响度补偿 + 微笑曲线，人声与低频更均衡' },
  { id: 'spatial', label: '空间环绕', desc: '拉宽声场，耳机下环绕感最明显' },
  { id: 'dialog', label: '人声增强', desc: '突出对白，适合外放追剧' },
  { id: 'bass', label: '低音增强', desc: '强化低频冲击力' },
];

const PREF_KEY = 'sober.audioEffect';

export function readAudioEffect(): AudioEffect {
  try {
    const v = localStorage.getItem(PREF_KEY) as AudioEffect | null;
    return v && AUDIO_EFFECTS.some((x) => x.id === v) ? v : 'off';
  } catch {
    return 'off';
  }
}

export function saveAudioEffect(mode: AudioEffect): void {
  try {
    localStorage.setItem(PREF_KEY, mode);
  } catch {
    /* ignore */
  }
}

export function audioEffectLabel(mode: AudioEffect): string {
  return AUDIO_EFFECTS.find((x) => x.id === mode)?.label ?? '原声';
}

interface Chain {
  ctx: AudioContext;
  src: MediaElementAudioSourceNode;
  low: BiquadFilterNode;
  mid: BiquadFilterNode;
  high: BiquadFilterNode;
  comp: DynamicsCompressorNode;
  split: ChannelSplitterNode;
  dryL: GainNode;
  dryR: GainNode;
  delayL: DelayNode;
  delayR: DelayNode;
  crossL: GainNode;
  crossR: GainNode;
  merge: ChannelMergerNode;
  out: GainNode;
}

/**
 * Web 引擎的音效链
 *
 * ⚠️ createMediaElementSource 对同一个 video 只能调用一次，
 *    重复调用会抛 InvalidStateError。所以延迟到用户真正选了非「原声」
 *    时才建链，并把实例挂在 PlayerController 上复用。
 */
export class WebAudioFx {
  private chain: Chain | null = null;
  private video: HTMLVideoElement;
  private mode: AudioEffect = 'off';

  constructor(video: HTMLVideoElement) {
    this.video = video;
  }

  get current(): AudioEffect {
    return this.mode;
  }

  setMode(mode: AudioEffect): void {
    this.mode = mode;
    if (mode === 'off' && !this.chain) return;
    const c = this.ensureChain();
    if (!c) return;

    if (c.ctx.state === 'suspended') void c.ctx.resume().catch(() => {});

    // 先归零，避免上一种效果的参数残留
    c.low.gain.value = 0;
    c.mid.gain.value = 0;
    c.high.gain.value = 0;
    c.comp.threshold.value = 0;
    c.comp.ratio.value = 1;
    c.comp.knee.value = 0;
    c.comp.attack.value = 0.003;
    c.comp.release.value = 0.25;
    c.out.gain.value = 1;
    c.dryL.gain.value = 1;
    c.dryR.gain.value = 1;
    c.crossL.gain.value = 0;
    c.crossR.gain.value = 0;

    switch (mode) {
      case 'dolby':
        c.low.gain.value = 3;
        c.mid.gain.value = 1;
        c.high.gain.value = 2;
        c.comp.threshold.value = -20;
        c.comp.ratio.value = 3;
        c.comp.knee.value = 12;
        c.out.gain.value = 1.22;
        break;
      case 'spatial':
        c.high.gain.value = 1.5;
        c.dryL.gain.value = 0.78;
        c.dryR.gain.value = 0.78;
        c.crossL.gain.value = 0.34;
        c.crossR.gain.value = 0.34;
        c.comp.threshold.value = -16;
        c.comp.ratio.value = 2;
        c.out.gain.value = 1.05;
        break;
      case 'dialog':
        c.low.gain.value = -4;
        c.mid.gain.value = 6;
        c.high.gain.value = 2;
        c.comp.threshold.value = -22;
        c.comp.ratio.value = 3.5;
        c.comp.knee.value = 10;
        c.out.gain.value = 1.18;
        break;
      case 'bass':
        c.low.gain.value = 9;
        c.mid.gain.value = -1;
        c.comp.threshold.value = -16;
        c.comp.ratio.value = 2.5;
        c.out.gain.value = 1.05;
        break;
      default:
        break;
    }
  }

  dispose(): void {
    // 只把参数归零，不关闭 AudioContext 也不断开节点：
    // 一旦 createMediaElementSource 生效，元素的音频就只能从这个图里出去，
    // 断开等于静音；而同一个 video 重复建 source 会抛 InvalidStateError。
    try {
      this.setMode('off');
    } catch {
      /* ignore */
    }
  }

  private ensureChain(): Chain | null {
    if (this.chain) return this.chain;
    const Ctor =
      typeof window !== 'undefined'
        ? window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        : undefined;
    if (!Ctor) return null;

    try {
      const ctx = new Ctor();
      const src = ctx.createMediaElementSource(this.video);

      const low = ctx.createBiquadFilter();
      low.type = 'lowshelf';
      low.frequency.value = 120;

      const mid = ctx.createBiquadFilter();
      mid.type = 'peaking';
      mid.frequency.value = 2000;
      mid.Q.value = 1;

      const high = ctx.createBiquadFilter();
      high.type = 'highshelf';
      high.frequency.value = 8000;

      const comp = ctx.createDynamicsCompressor();

      const split = ctx.createChannelSplitter(2);
      const merge = ctx.createChannelMerger(2);

      const dryL = ctx.createGain();
      const dryR = ctx.createGain();
      const crossL = ctx.createGain();
      const crossR = ctx.createGain();
      crossL.gain.value = 0;
      crossR.gain.value = 0;

      // 左右声道交叉延迟 ~12ms：经典的哈斯效应加宽，不做真实混响
      const delayL = ctx.createDelay(0.1);
      const delayR = ctx.createDelay(0.1);
      delayL.delayTime.value = 0.012;
      delayR.delayTime.value = 0.012;

      const out = ctx.createGain();

      src.connect(low);
      low.connect(mid);
      mid.connect(high);
      high.connect(comp);
      comp.connect(split);
      split.connect(dryL, 0);
      split.connect(dryR, 1);
      dryL.connect(merge, 0, 0);
      dryR.connect(merge, 0, 1);
      split.connect(delayL, 0);
      split.connect(delayR, 1);
      delayL.connect(crossL);
      delayR.connect(crossR);
      crossL.connect(merge, 0, 1);
      crossR.connect(merge, 0, 0);
      merge.connect(out);
      out.connect(ctx.destination);

      this.chain = {
        ctx,
        src,
        low,
        mid,
        high,
        comp,
        split,
        dryL,
        dryR,
        delayL,
        delayR,
        crossL,
        crossR,
        merge,
        out,
      };
      return this.chain;
    } catch {
      // 建链失败（WebView 不支持 / 已被别的实例接管）→ 静默回退为原声
      return null;
    }
  }
}

/**
 * 每个 video 元素只允许有一条音效链
 *
 * 换集时 Detail 会新建 PlayerController，但它们共用同一个 <video>。
 * 第二次 createMediaElementSource 会抛 InvalidStateError，
 * 所以实例按元素缓存，跨控制器复用。
 */
const REGISTRY = new WeakMap<HTMLVideoElement, WebAudioFx>();

export function getWebAudioFx(video: HTMLVideoElement): WebAudioFx {
  let fx = REGISTRY.get(video);
  if (!fx) {
    fx = new WebAudioFx(video);
    REGISTRY.set(video, fx);
  }
  return fx;
}
