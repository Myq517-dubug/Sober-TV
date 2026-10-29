import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, IconButton } from '../components/Button';
import {
  addCustomSource,
  loadCustomSources,
  removeCustomSource,
  reprobeCustomSource,
  renameCustomSource,
  testSourceUrl,
  toggleCustomSource,
  type CustomSource,
} from '../lib/customSources';
import { CMS_SOURCES, probeSources, type SourceHealth } from '../lib/cms';
import './Sources.css';

/**
 * 资源源管理页
 *
 * 功能：
 *   1. 查看内置源的可用性（延迟 / 资源总量）
 *   2. 自行添加聚合资源链接（自动识别协议 + 自动探测）
 *   3. 启用 / 禁用 / 重命名 / 删除自建源
 *
 * 设计：自建源权重高于内置源 —— 用户主动添加的优先使用。
 */
export function Sources() {
  const navigate = useNavigate();
  const [custom, setCustom] = useState<CustomSource[]>([]);
  const [builtin, setBuiltin] = useState<SourceHealth[]>([]);
  const [checking, setChecking] = useState(false);

  // 添加表单
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
    total?: number;
    latencyMs?: number;
  } | null>(null);
  const [adding, setAdding] = useState(false);
  /** 正在重命名的源 id */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');

  const reload = useCallback(() => {
    setCustom(loadCustomSources());
  }, []);

  useEffect(() => {
    reload();
    void checkBuiltin();
  }, [reload]);

  /** 探测内置源 */
  async function checkBuiltin() {
    setChecking(true);
    const res = await probeSources(CMS_SOURCES);
    setBuiltin(res);
    setChecking(false);
  }

  /** 测试地址（不保存） */
  async function handleTest() {
    if (!url.trim()) return;
    setTesting(true);
    setTestResult(null);
    const r = await testSourceUrl(url);
    if (r.ok) {
      setTestResult({
        ok: true,
        message: r.sample?.hasPlay
          ? `可用 · 共 ${(r.total ?? 0).toLocaleString()} 条 · ${r.latencyMs}ms · 播放地址已验证`
          : `接口可用 · 共 ${(r.total ?? 0).toLocaleString()} 条 · ${r.latencyMs}ms · 未验证到 m3u8 播放地址`,
        total: r.total,
        latencyMs: r.latencyMs,
      });
    } else {
      setTestResult({
        ok: false,
        message: `不可用 · ${r.error || '连接失败'}`,
        latencyMs: r.latencyMs,
      });
    }
    setTesting(false);
  }

  /** 添加源 */
  async function handleAdd() {
    if (!url.trim()) return;
    setAdding(true);
    const r = await addCustomSource(url, name);
    setAdding(false);
    if (r.ok) {
      setUrl('');
      setName('');
      setTestResult(null);
      reload();
    } else {
      setTestResult({ ok: false, message: r.error });
    }
  }

  return (
    <div className="sources">
      <header className="sources__head">
        <button className="sources__back" onClick={() => navigate(-1)} aria-label="返回">
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
        <div>
          <h1 className="sources__title">资源源</h1>
          <p className="sources__sub">自行添加聚合资源链接</p>
        </div>
      </header>

      {/* ── 添加源 ── */}
      <section className="card">
        <div className="card__head">
          <h2 className="card__title">添加聚合资源链接</h2>
        </div>
        <p className="card__desc">
          粘贴苹果 CMS / MacCMS V10 标准接口地址即可，例如
          <code className="code">https://example.com/api.php/provide/vod/</code>
          。系统会自动补全路径、探测可用性并验证播放地址。
        </p>

        <div className="field">
          <input
            className="field__input"
            type="url"
            placeholder="https://example.com/api.php/provide/vod/"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setTestResult(null);
            }}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="field">
          <input
            className="field__input"
            type="text"
            placeholder="源名称（可选，留空自动识别）"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
          />
        </div>

        {testResult && (
          <p className={`sources__result ${testResult.ok ? 'is-ok' : 'is-bad'}`}>
            {testResult.message}
          </p>
        )}

        <div className="card__actions">
          <Button
            variant="outlined"
            size="sm"
            onClick={handleTest}
            loading={testing}
            disabled={!url.trim()}
          >
            测试
          </Button>
          <Button
            variant="filled"
            size="sm"
            onClick={handleAdd}
            loading={adding}
            disabled={!url.trim()}
          >
            添加
          </Button>
        </div>
      </section>

      {/* ── 我的源 ── */}
      <section className="card">
        <div className="card__head">
          <h2 className="card__title">我的源</h2>
          <span className="card__count">{custom.length}</span>
        </div>

        {custom.length === 0 && (
          <p className="card__note">
            还没有自建源。添加后会自动参与片库浏览与播放解析，优先级高于内置源。
          </p>
        )}

        <div className="source-list">
          {custom.map((s) => (
            <div className="source-item" key={s.id}>
              <span
                className={`source-item__dot ${
                  s.enabled === false ? '' : s.lastProbe?.ok ? 'is-up' : 'is-down'
                }`}
                aria-hidden="true"
              />
              <div className="source-item__text">
                {renamingId === s.id ? (
                  <input
                    className="source-item__rename"
                    value={renameText}
                    autoFocus
                    onChange={(e) => setRenameText(e.target.value)}
                    onBlur={() => {
                      renameCustomSource(s.id, renameText);
                      setRenamingId(null);
                      reload();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        renameCustomSource(s.id, renameText);
                        setRenamingId(null);
                        reload();
                      }
                      if (e.key === 'Escape') setRenamingId(null);
                    }}
                  />
                ) : (
                  <p
                    className="source-item__name source-item__name--editable"
                    onDoubleClick={() => {
                      setRenamingId(s.id);
                      setRenameText(s.name);
                    }}
                    title="双击重命名"
                  >
                    {s.name}
                    {s.enabled === false && <span className="source-item__tag">已禁用</span>}
                  </p>
                )}
                <p className="source-item__meta">
                  {s.lastProbe?.ok
                    ? `可用 · ${(s.lastProbe.total ?? 0).toLocaleString()} 条 · ${s.lastProbe.latencyMs}ms`
                    : `不可用 · ${s.lastProbe?.error || '未探测'}`}
                </p>
                <p className="source-item__url">{s.base}</p>
              </div>
              <div className="source-item__ops">
                <IconButton
                  label="重新探测"
                  onClick={async () => {
                    await reprobeCustomSource(s.id);
                    reload();
                  }}
                >
                  <svg viewBox="0 0 24 24" width="16" height="16">
                    <path
                      d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      fill="none"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </IconButton>
                <IconButton
                  label={s.enabled === false ? '启用' : '禁用'}
                  onClick={() => {
                    toggleCustomSource(s.id, s.enabled === false);
                    reload();
                  }}
                >
                  {s.enabled === false ? (
                    <svg viewBox="0 0 24 24" width="16" height="16">
                      <path
                        d="M8 5.5v13l11-6.5-11-6.5Z"
                        fill="currentColor"
                      />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" width="16" height="16">
                      <path
                        d="M7 7v10M17 7v10"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                    </svg>
                  )}
                </IconButton>
                <IconButton
                  label="删除"
                  onClick={() => {
                    removeCustomSource(s.id);
                    reload();
                  }}
                >
                  <svg viewBox="0 0 24 24" width="16" height="16">
                    <path
                      d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      fill="none"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </IconButton>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── 内置源 ── */}
      <section className="card">
        <div className="card__head">
          <h2 className="card__title">内置源</h2>
          <span className={`status ${checking ? '' : builtin.some((s) => s.ok) ? 'is-up' : 'is-down'}`}>
            {checking
              ? '检测中'
              : builtin.filter((s) => s.ok).length > 0
                ? `${builtin.filter((s) => s.ok).length}/${builtin.length} 可用`
                : '全部不可用'}
          </span>
        </div>
        <p className="card__desc">
          失效的源会自动从解析链路中剔除，不影响使用。可自行添加新源作为补充。
        </p>

        <div className="source-list">
          {builtin.map((s) => {
            const meta = CMS_SOURCES.find((x) => x.id === s.id);
            return (
              <div className="source-item" key={s.id}>
                <span
                  className={`source-item__dot ${s.ok ? 'is-up' : 'is-down'}`}
                  aria-hidden="true"
                />
                <div className="source-item__text">
                  <p className="source-item__name">{meta?.name ?? s.id}</p>
                  <p className="source-item__meta">
                    {s.ok
                      ? `可用 · ${(s.total ?? 0).toLocaleString()} 条 · ${s.latencyMs}ms`
                      : `不可用 · ${s.failures} 次连续失败`}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        <div className="card__actions">
          <Button variant="outlined" size="sm" onClick={checkBuiltin} loading={checking}>
            重新检测
          </Button>
        </div>
      </section>
    </div>
  );
}
