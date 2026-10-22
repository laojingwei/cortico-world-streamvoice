/**
 * 重新生成 describe.json（包里的自描述，扩展市场与 World 页读它）。
 *
 *   node E:/software/coopanion/resources/app/node_modules/tsx/dist/cli.mjs scripts/gen-describe.ts
 *
 * 改了 src/tools.ts 里的工具声明就跑一次，别手抄：手抄迟早和 tools() 对不上，
 * 框架会把「声明里没有的工具」记进日志并在 World 页标出来。
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SPEECH_TOOL_DECLS, SPEECH_TOOL_SUMMARIES } from '../src/tools.ts';

const describe = {
  tools: SPEECH_TOOL_DECLS.map((d) => ({
    name: d.name,
    description: d.description,
    parameters: d.parameters,
    tags: d.tags,
    summary: SPEECH_TOOL_SUMMARIES[d.name] ?? d.description,
  })),
  events: [],
};

const out = fileURLToPath(new URL('../describe.json', import.meta.url));
writeFileSync(out, `${JSON.stringify(describe, null, 2)}\n`, 'utf8');
console.log(`已写入 ${out}：${describe.tools.length} 个工具、${describe.events.length} 个事件`);
