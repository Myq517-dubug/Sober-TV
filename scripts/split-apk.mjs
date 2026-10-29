/**
 * APK 分发脚本
 * 收集 Gradle 产出的 APK 到 release 目录，并生成 sha256 校验文件
 *
 * 运行：node scripts/split-apk.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const APK_DIR = path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'release');
const OUT_DIR = path.join(ROOT, 'release');

/** 版本号从 build.gradle 读取，避免打包脚本与 app 版本脱节 */
const VERSION = (() => {
  const gradle = fs.readFileSync(path.join(ROOT, 'android', 'app', 'build.gradle'), 'utf8');
  const m = gradle.match(/versionName\s+"([^"]+)"/);
  if (!m) throw new Error('无法从 build.gradle 读取 versionName');
  return m[1];
})();

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

if (!fs.existsSync(APK_DIR)) {
  console.error(`[错误] 找不到 APK 目录：${APK_DIR}`);
  console.error('请先执行：cd android && gradlew.bat assembleRelease');
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const apks = fs
  .readdirSync(APK_DIR)
  .filter((f) => f.endsWith('.apk'))
  .map((f) => path.join(APK_DIR, f));

if (!apks.length) {
  console.error('[错误] 没有找到任何 APK');
  process.exit(1);
}

const manifest = [];

for (const src of apks) {
  const raw = path.basename(src, '.apk');

  // app-release.apk → universal；app-arm64-v8a-release.apk → arm64-v8a
  let abi = 'universal';
  const m = raw.match(/app-(.+?)-release/);
  if (m) abi = m[1];

  const dstName = `SoberTV_v${VERSION}_${abi}.apk`;
  const dst = path.join(OUT_DIR, dstName);

  fs.copyFileSync(src, dst);
  const size = fs.statSync(dst).size;
  const digest = sha256(dst);

  // 生成同名 .sha256 校验文件（借鉴 LEIMAOTV 的做法）
  fs.writeFileSync(`${dst}.sha256`, `${digest}  ${dstName}\n`, 'utf8');

  manifest.push({ name: dstName, size, sha256: digest, abi });
  console.log(`✓ ${dstName}  ${(size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  sha256: ${digest}`);
}

// 汇总 manifest
fs.writeFileSync(
  path.join(OUT_DIR, 'manifest.json'),
  JSON.stringify({ name: 'Sober TV', version: VERSION, apks: manifest }, null, 2),
  'utf8',
);

console.log(`\n产物目录：${OUT_DIR}`);
console.log(`共 ${manifest.length} 个 APK，均附 .sha256 校验文件`);
