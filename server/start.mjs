/**
 * 服务端启动脚本
 * 用法：node server/start.mjs [--port 8787]
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const PORT = portIdx >= 0 ? args[portIdx + 1] : process.env.PORT || '8787';

const child = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
  stdio: 'inherit',
  env: { ...process.env, PORT },
});

child.on('exit', (code) => process.exit(code ?? 0));

process.on('SIGINT', () => {
  console.log('\n[sober-tv] 正在停止服务...');
  child.kill('SIGTERM');
});
