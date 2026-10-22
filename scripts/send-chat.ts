/**
 * 台账外的测试小工具：从控制台的 chat 流给宠物发一句话，让 Coo 真的回一段，
 * 用来验证流式朗读的时序。需要 Coopanion 正在运行（没设控制台密码时不用登录）。
 *
 * 跑：node <tsx> scripts/send-chat.ts "用两三句话说说明天要做什么"
 */
import WebSocket from 'ws';

const text = process.argv[2] ?? '用两三句话说说今天你在忙什么。';
const port = Number(process.env.COOPANION_PORT ?? 17788);
const url = `ws://127.0.0.1:${port}/ws/providers/${encodeURIComponent('world:desktop-pet')}/panels/chat`;

const socket = new WebSocket(url);
const id = `probe-${Date.now()}`;

socket.on('open', () => {
  console.log(`已连接 ${url}`);
  socket.send(JSON.stringify({ t: 'send', id, text }));
});

socket.on('message', (raw) => {
  const frame = JSON.parse(String(raw)) as { t?: string; id?: string; cursor?: number; reason?: string };
  console.log('收到', JSON.stringify(frame).slice(0, 200));
  if (frame.t === 'sent' && frame.id === id) {
    console.log('已送达，游标', frame.cursor);
    setTimeout(() => { socket.close(); process.exit(0); }, 500);
  }
  if (frame.t === 'rejected') {
    console.error('被拒：', frame.reason);
    process.exit(1);
  }
});

socket.on('error', (err) => {
  console.error('连接失败', err.message);
  process.exit(1);
});

setTimeout(() => { console.error('超时'); process.exit(1); }, 15_000);
