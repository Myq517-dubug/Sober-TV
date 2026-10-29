import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../components/Button';
import { retryTmdb, runDiagnostics, summarize, type DiagItem } from '../lib/diagnostics';
import './Diagnostics.css';

/**
 * 网络与播放诊断页
 *
 * 一键跑完整链路，逐项显示实际结果。
 * 排查「搜不到 / 加载慢 / 黑屏」时先看这里 —— 比反复猜测有效得多。
 */
export function Diagnostics() {
  const navigate = useNavigate();
  const [items, setItems] = useState<DiagItem[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const startedRef = useRef(false);

  const run = useCallback(async () => {
    setRunning(true);
    setDone(false);
    setItems([]);
    try {
      await runDiagnostics((item) => {
        setItems((prev) => [...prev, item]);
      });
    } catch (e) {
      setItems((prev) => [
        ...prev,
        {
          key: 'fatal',
          group: '诊断',
          label: '诊断过程异常',
          status: 'fail',
          error: e instanceof Error ? e.message : String(e),
        },
      ]);
    } finally {
      setRunning(false);
      setDone(true);
    }
  }, []);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void run();
  }, [run]);

  const stat = summarize(items);
  const groups = [...new Set(items.map((i) => i.group))];

  return (
    <div className="diag">
      <header className="diag__head">
        <button className="diag__back" onClick={() => navigate(-1)} aria-label="返回">
          <svg viewBox="0 0 24 24" width="22" height="22">
            <path
              d="M15 5l-7 7 7 7"
              stroke="currentColor"
              strokeWidth="1.8"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <div className="diag__headtext">
          <h1 className="diag__title">网络与播放诊断</h1>
          <p className="diag__sub">
            {running
              ? '检测中…'
              : done
                ? `通过 ${stat.pass} · 失败 ${stat.fail} · 跳过 ${stat.skip}`
                : '准备检测'}
          </p>
        </div>
        <div className="diag__headbtns">
          <Button
            variant="text"
            size="sm"
            onClick={() => {
              // 清除 TMDB 熔断（换网络/开代理后可用）
              retryTmdb();
              void run();
            }}
          >
            重试 TMDB
          </Button>
          <Button variant="outlined" size="sm" onClick={run} loading={running}>
            重跑
          </Button>
        </div>
      </header>

      <div className="diag__summary">
        <div className={`diag__stat ${stat.fail > 0 ? 'is-bad' : stat.pass > 0 ? 'is-ok' : ''}`}>
          <span className="diag__stat-num">{stat.pass}</span>
          <span className="diag__stat-label">通过</span>
        </div>
        <div className={`diag__stat ${stat.fail > 0 ? 'is-bad' : ''}`}>
          <span className="diag__stat-num">{stat.fail}</span>
          <span className="diag__stat-label">失败</span>
        </div>
        <div className="diag__stat">
          <span className="diag__stat-num">{stat.skip}</span>
          <span className="diag__stat-label">跳过</span>
        </div>
      </div>

      {groups.map((g) => (
        <section className="diag__group" key={g}>
          <h2 className="diag__group-title">{g}</h2>
          <div className="diag__list">
            {items
              .filter((i) => i.group === g)
              .map((i) => (
                <div className={`diag__item diag__item--${i.status}`} key={i.key}>
                  <span className="diag__dot" aria-hidden="true" />
                  <div className="diag__body">
                    <div className="diag__row1">
                      <span className="diag__label">{i.label}</span>
                      {i.ms !== undefined && <span className="diag__ms">{i.ms}ms</span>}
                    </div>
                    {i.detail && <p className="diag__detail">{i.detail}</p>}
                    {i.error && <p className="diag__error">{i.error}</p>}
                    {i.url && (
                      <p className="diag__url" title={i.url}>
                        {i.url}
                      </p>
                    )}
                  </div>
                </div>
              ))}
          </div>
        </section>
      ))}

      {done && (
        <div className="diag__foot">
          <p className="diag__hint">
            把本页截图发给开发者即可定位问题。失败项会标红并附上实际错误信息与请求地址。
          </p>
        </div>
      )}
    </div>
  );
}
