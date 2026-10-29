import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useAutoHideControls } from '../hooks/useAutoHideControls';
import '../styles/global.css';
import '../player/PlayerBar.css';
import { injectCssVars } from '../theme/tokens';

/**
 * 控制条自动隐藏 —— 测试夹具
 *
 * 挂载**真实的** useAutoHideControls hook，
 * 通过 window.__autoHide 暴露状态与操作，供 Playwright 断言。
 *
 * 时间参数调小（enterDelay 300 / idleDelay 400），
 * 让测试不必等待真实的 2.5s / 4s。
 */
injectCssVars();

function Fixture() {
  const [landscape, setLandscape] = useState(false);
  const [pinned, setPinned] = useState(false);
  const controls = useAutoHideControls({
    landscape,
    pinned,
    enterDelay: 300,
    idleDelay: 400,
  });

  // 暴露给测试
  (window as unknown as Record<string, unknown>).__autoHide = {
    get visible() {
      return controls.visible;
    },
    get landscape() {
      return landscape;
    },
    get pinned() {
      return pinned;
    },
    setLandscape,
    setPinned,
    toggle: controls.toggle,
    reveal: controls.reveal,
    hide: controls.hide,
  };

  return (
    <div style={{ padding: 24 }}>
      <div id="state" data-visible={String(controls.visible)}>
        visible={String(controls.visible)}
      </div>
      <div id="bar" className={`pbar${controls.visible ? '' : ' is-hidden'}`}>
        <div className="pbar__head">
          <p className="pbar__title">测试控制条</p>
        </div>
        <div className="pbar__seekrow">
          <span className="pbar__time">00:00</span>
          <div className="pbar__track">
            <input type="range" className="pbar__range" min={0} max={100} defaultValue={30} />
          </div>
          <span className="pbar__time pbar__time--total">10:00</span>
        </div>
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('缺少 #root');
createRoot(root).render(<Fixture />);
