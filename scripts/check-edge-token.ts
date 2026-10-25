/**
 * Edge 朗读接口的 `Sec-MS-GEC` 令牌自测：只算哈希，不联网。
 *
 *   node E:/software/coopanion/resources/app/node_modules/tsx/dist/cli.mjs scripts/check-edge-token.ts
 *
 * 参考值取自上游 edge-tts 7.3.1 的 `DRM.generate_sec_ms_gec_v2()`（窗口固定的三个时间戳）。
 * 微软 2026-10 把令牌从「单个 SHA-256」换成 `<CS64>-<SHA256>` 两段之后，旧算法不会报错，
 * 只会让服务端回 HTTP 200 空响应、永远握不上手——所以这里把结果钉死：
 * 一旦有人把 `drm.ts` 改成标准 SHA-256 或者改了取整窗口，这条立刻红。
 */
import { generateSecMsGecV2 } from '../src/edge-tts/drm.ts';

const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';

let failed = 0;
const ok = (name: string, pass: boolean, detail = ''): void => {
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failed++;
};

// 上游 7.3.1 在同样三个时间戳算出来的令牌
const SAMPLES: Array<[number, string]> = [
  [1792953600, '98C1024389B0513A-B749506D2E02B7811B8F70ADF2C17D3AC42B1ACF2885B2E1344A533D29F3DB14'],
  [1700000000, '2CD23A2CA0B2595A-F3C846C370E05F9CC83ACC5F995C5F5D87A4D0F14CE8936A0F902E64099E38A2'],
  [1792953900, '24B9EC5E932C2A36-C5F277C4F70C2802438FBD067B09EDFB55B3854793D9E1CFB688F662E5C24F26'],
];

for (const [ts, want] of SAMPLES) {
  ok(`时间戳 ${ts} 的令牌`, generateSecMsGecV2(TOKEN, ts) === want, generateSecMsGecV2(TOKEN, ts) === want ? '' : generateSecMsGecV2(TOKEN, ts));
}

const shape = /^[0-9A-F]{16}-[0-9A-F]{64}$/;
ok('格式是「16 位-64 位」', shape.test(generateSecMsGecV2(TOKEN)), generateSecMsGecV2(TOKEN));
ok('同一个 5 分钟窗口内稳定', generateSecMsGecV2(TOKEN, 1792953601) === generateSecMsGecV2(TOKEN, 1792953899));
ok('跨窗口会变', generateSecMsGecV2(TOKEN, 1792953600) !== generateSecMsGecV2(TOKEN, 1792953900));
ok('时钟偏移生效', generateSecMsGecV2(TOKEN, 1792953600, 300) === generateSecMsGecV2(TOKEN, 1792953900));

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
