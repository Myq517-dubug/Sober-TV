import React, { useEffect } from 'react';
import { NavLink, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { Home } from './screens/Home';
import { Search } from './screens/Search';
import { Detail } from './screens/Detail';
import { Live } from './screens/Live';
import { Library } from './screens/Library';
import { Mine } from './screens/Mine';
import { Settings } from './screens/Settings';
import { Sources } from './screens/Sources';
import { Diagnostics } from './screens/Diagnostics';
import { installRemoteNav, installAndroidRemote } from './hooks/useRemoteNav';
import { useEdgeSwipeBack } from './hooks/useEdgeSwipeBack';
import './App.css';

/**
 * App 外壳
 * 底部导航：首页 / 搜索 / 片库 / 设置
 * 详情页与播放页全屏覆盖，不显示导航
 */
export function App() {
  const location = useLocation();
  const navigate = useNavigate();

  const showNav =
    location.pathname === '/' ||
    location.pathname === '/search' ||
    location.pathname === '/library' ||
    location.pathname === '/mine' ||
    location.pathname === '/live' ||
    location.pathname === '/settings';
  // 遥控器 / 键盘导航
  useEffect(() => {
    const uninstall = installRemoteNav({
      onBack: () => {
        if (window.location.pathname !== '/') navigate(-1);
      },
    });
    const uninstallAndroid = installAndroidRemote();
    return () => {
      uninstall();
      uninstallAndroid();
    };
  }, [navigate]);

  // 侧边手势：左边缘右滑返回首页（首页自身禁用）
  const edge = useEdgeSwipeBack(location.pathname !== '/', () => navigate('/'));

  return (
    <div className="app">
      <main
        className={`app__main${edge.shift ? ' is-swiping' : ''}`}
        key={location.pathname}
        style={
          edge.shift
            ? { transform: `translate3d(${edge.shift}px,0,0)`, transition: 'none' }
            : undefined
        }
      >
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/search" element={<Search />} />
          <Route path="/library" element={<Library />} />
          <Route path="/live" element={<Live />} />
          <Route path="/mine" element={<Mine />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/sources" element={<Sources />} />
          <Route path="/diagnostics" element={<Diagnostics />} />
          <Route path="/detail/:id" element={<Detail />} />
          <Route path="*" element={<Home />} />
        </Routes>
      </main>

      <EdgeIndicator state={edge} />

      {showNav && (
        <nav className="nav" aria-label="主导航">
          <NavLink
            to="/"
            end
            className={({ isActive }) => `nav__item${isActive ? ' is-active' : ''}`}
          >
            <NavIcon name="home" />
            <span>首页</span>
          </NavLink>
          <NavLink
            to="/search"
            className={({ isActive }) => `nav__item${isActive ? ' is-active' : ''}`}
          >
            <NavIcon name="search" />
            <span>搜索</span>
          </NavLink>
          <NavLink
            to="/library"
            className={({ isActive }) => `nav__item${isActive ? ' is-active' : ''}`}
          >
            <NavIcon name="library" />
            <span>片库</span>
          </NavLink>
          <NavLink
            to="/mine"
            className={({ isActive }) => `nav__item${isActive ? ' is-active' : ''}`}
          >
            <NavIcon name="mine" />
            <span>我的</span>
          </NavLink>
          <NavLink
            to="/settings"
            className={({ isActive }) => `nav__item${isActive ? ' is-active' : ''}`}
          >
            <NavIcon name="settings" />
            <span>设置</span>
          </NavLink>
          <NavLink
            to="/live"
            className={({ isActive }) => `nav__item${isActive ? ' is-active' : ''}`}
          >
            <NavIcon name="live" />
            <span>直播</span>
          </NavLink>
        </nav>
      )}
    </div>
  );
}

/**
 * 侧边手势进度指示器
 * 滑动时从左边缘浮出，箭头随进度填充，完成时变薄荷绿
 */
function EdgeIndicator({ state }: { state: { progress: number; active: boolean; triggered: boolean } }) {
  if (!state.active) return null;
  const p = state.progress;
  return (
    <div
      className={`edge-ind${state.triggered ? ' is-done' : ''}`}
      style={{ opacity: Math.min(1, 0.35 + p * 0.65) }}
      aria-hidden="true"
    >
      <div className="edge-ind__ring" style={{ '--p': p } as React.CSSProperties}>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 5l-7 7 7 7" />
        </svg>
      </div>
      <span className="edge-ind__label">返回首页</span>
    </div>
  );
}

function NavIcon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    home: <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1v-9.5Z" />,
    search: (
      <>
        <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M16 16l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      </>
    ),
    library: (
      <>
        <rect x="4" y="5" width="4" height="14" rx="1.4" />
        <rect x="10" y="5" width="4" height="14" rx="1.4" />
        <path d="m16.6 6.2 3.2 1-3.4 12.4-3.2-1 3.4-12.4Z" />
      </>
    ),
    mine: (
      <>
        <circle cx="12" cy="8.4" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path
          d="M4.8 20a7.2 7.2 0 0 1 14.4 0"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </>
    ),
    live: (
      <>
        <rect x="3" y="6.6" width="18" height="12.4" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M8.5 21h7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M10.2 10.8v3.6l3.2-1.8-3.2-1.8Z" fill="currentColor" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path
          d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 8.9 19a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 5 8.9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9.5a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      </>
    ),
  };

  return (
    <svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true" fill="currentColor">
      {paths[name]}
    </svg>
  );
}
