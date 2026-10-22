/** 一次性校验：拿 Coopanion 自带的清单解析器检查本包的 package.json 能不能过。 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const dir = 'D:/dsh/workbuddy/extensions/cortico-world-streamvoice';
const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
const { parseExtensionManifest } = (await import(
  'file:///E:/software/coopanion/resources/app/build/cortico/src/extensions/manifest.ts'
)) as typeof import('E:/software/coopanion/resources/app/build/cortico/src/extensions/manifest.ts');
const result = parseExtensionManifest(pkg, 'zh');

if (!result.ok) {
  console.error('✗ 不通过');
  for (const r of result.reasons) console.error('  reason:', r);
  for (const w of result.warnings) console.error('  warning:', w);
  process.exit(1);
}

console.log('✓ 清单通过');
console.log('  manifest =', JSON.stringify(result.manifest, null, 2));
for (const w of result.warnings) console.error('  warning:', w);

// 图标/截图/自描述文件必须真的在包里
const cortico = pkg.cortico as Record<string, unknown>;
const must = [
  ...(typeof cortico.icon === 'string' ? [cortico.icon] : []),
  ...(Array.isArray(cortico.screenshots) ? (cortico.screenshots as string[]) : []),
  ...(typeof cortico.describe === 'string' ? [cortico.describe] : []),
  ...(typeof cortico.webUiClient === 'string' ? [cortico.webUiClient] : []),
];
for (const rel of must) {
  const ok = existsSync(join(dir, rel));
  console.log(ok ? '✓ 存在' : '✗ 缺失', rel);
  if (!ok) process.exitCode = 1;
}

// keywords 必须含市场发现用的关键字
const kw = (pkg.keywords ?? []) as string[];
console.log(kw.includes('cortico-world') ? '✓ keywords 含 cortico-world' : '✗ 缺 cortico-world 关键字');
if (!kw.includes('cortico-world')) process.exitCode = 1;

// files 里必须带上这些目录，否则 npm 包里没有
const files = (pkg.files ?? []) as string[];
for (const need of ['src', 'dist', 'assets', 'describe.json']) {
  console.log(files.includes(need) ? '✓ files 含' : '✗ files 缺', need);
  if (!files.includes(need)) process.exitCode = 1;
}
