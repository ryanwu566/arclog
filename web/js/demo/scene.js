// 合成示範畫面的繪圖：體育館側面、籃架、投籃者的剪影、一顆會飛的球。
//
// 只用標準的 Canvas 2D API，所以瀏覽器（示範模式）和 Node（training/make_synth，
// 透過 @napi-rs/canvas）用的是同一份繪圖程式，訓練用的合成影片和網站上看到的示範畫面一致。
//
// 畫面上的人是幾何圖形拼成的剪影，不是任何真人；畫面角落固定印著 SYNTHETIC DEMO。

import { RIM_DIAMETER_M, BALL_DIAMETER_M } from '../core/constants.js';
import { ballAt, flightState, RIM_HEIGHT_M } from '../core/synth.js';

const BALL_R = BALL_DIAMETER_M / 2;
const FLOOR_Y = -RIM_HEIGHT_M;
const BOARD_X = RIM_DIAMETER_M + 0.15;

/** 外觀設定。training/make_synth 會隨機改這些值，讓合成訓練資料有變化。 */
export const DEFAULT_LOOK = {
  wallTop: '#dfe4e8',
  wallBottom: '#c9d1d8',
  wainscot: '#9fb1bf',
  floor: '#c9a06a',
  floorDark: '#a67f4d',
  line: '#f3efe6',
  board: '#f7f9fa',
  boardEdge: '#4f5961',
  pole: '#5b656d',
  rim: '#e4571b',
  net: 'rgba(255,255,255,0.9)',
  figure: '#394653',
  ballLight: '#f6b673',
  ballMid: '#dd7430',
  ballDark: '#8e4319',
  seam: '#24160f',
  shutter: 1 / 120, // 曝光時間（秒），決定動態模糊的長度
  blurSamples: 5,
  shadow: true,
  watermark: true,
  distractors: [], // [{x, y, r, color}] 世界座標的固定圓形干擾物（訓練資料用）
};

/**
 * 建立某個劇本的繪圖器。
 * @param {object} plan makeDemoPlan 的結果
 * @param {(w:number, h:number) => any} createCanvas 建立畫布的函式
 * @param {object} [look] 覆寫 DEFAULT_LOOK
 * @returns {{draw(ctx:any, t:number):void, width:number, height:number}}
 */
export function createSceneRenderer(plan, createCanvas, look = {}) {
  const L = { ...DEFAULT_LOOK, ...look };
  const W = plan.width;
  const H = plan.height;
  const sx = (plan.mirror ? -1 : 1) * plan.pxPerM;
  const m = [sx * plan.cosR, sx * plan.sinR, plan.pxPerM * plan.sinR, -plan.pxPerM * plan.cosR, plan.originPx.x, plan.originPx.y];
  const px = 1 / plan.pxPerM; // 一個像素是幾公尺

  /** 進入世界座標（公尺，Y 朝上）。 */
  const world = (ctx) => {
    ctx.save();
    ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
  };

  // 投籃者站的位置：所有球的出手點平均，再往後一點
  let standX = -4.15;
  if (plan.shots.length) {
    let s = 0;
    for (const sh of plan.shots) s += flightState(sh.flight, 0)[0];
    standX = s / plan.shots.length - 0.3;
  }

  // ── 不會動的背景，畫一次存起來 ──
  const bg = createCanvas(W, H);
  {
    const c = bg.getContext('2d');
    c.fillStyle = L.wallBottom;
    c.fillRect(0, 0, W, H);
    world(c);
    // 牆
    const g = c.createLinearGradient(0, 2.2, 0, FLOOR_Y);
    g.addColorStop(0, L.wallTop);
    g.addColorStop(1, L.wallBottom);
    c.fillStyle = g;
    c.fillRect(-30, FLOOR_Y, 60, 12);
    // 牆的下半部防撞墊
    c.fillStyle = L.wainscot;
    c.fillRect(-30, FLOOR_Y, 60, 1.25);
    c.strokeStyle = 'rgba(0,0,0,0.10)';
    c.lineWidth = 1.2 * px;
    for (let x = -30; x < 30; x += 1.2) {
      c.beginPath();
      c.moveTo(x, FLOOR_Y);
      c.lineTo(x, FLOOR_Y + 1.25);
      c.stroke();
    }
    c.fillStyle = 'rgba(0,0,0,0.12)';
    c.fillRect(-30, FLOOR_Y + 1.25, 60, 0.035);
    // 地板
    c.fillStyle = L.floor;
    c.fillRect(-30, FLOOR_Y - 6, 60, 6);
    c.fillStyle = L.floorDark;
    c.fillRect(-30, FLOOR_Y - 0.03, 60, 0.03);
    c.fillStyle = L.line;
    c.fillRect(-30, FLOOR_Y - 0.14, 60, 0.035);
    // 籃架：立柱、橫臂、籃板（側面看是一條細長的板子）
    c.fillStyle = L.pole;
    c.fillRect(BOARD_X + 1.35, FLOOR_Y, 0.16, RIM_HEIGHT_M + 0.55);
    c.beginPath();
    c.moveTo(BOARD_X + 1.51, 0.55);
    c.lineTo(BOARD_X + 0.04, 0.42);
    c.lineTo(BOARD_X + 0.04, 0.26);
    c.lineTo(BOARD_X + 1.51, 0.3);
    c.closePath();
    c.fill();
    c.fillStyle = L.boardEdge;
    c.fillRect(BOARD_X - 0.012, -0.162, 0.064, 1.074);
    c.fillStyle = L.board;
    c.fillRect(BOARD_X, -0.15, 0.04, 1.05);
    // 籃框和籃板之間的支架
    c.fillStyle = L.rim;
    c.fillRect(RIM_DIAMETER_M, -0.06, 0.15, 0.05);
    c.restore();
  }

  const drawFigure = (c, t) => {
    // 目前或下一球，決定手的位置
    let hand = [standX + 0.22, FLOOR_Y + 1.15]; // 放下來的位置
    let ballPos = null;
    for (let i = 0; i < plan.shots.length; i++) {
      const sh = plan.shots[i];
      const rel = flightState(sh.flight, 0);
      const up = [rel[0] - 0.05, rel[1] - 0.1];
      const raise = 0.25;
      if (t >= sh.tAppear - raise && t < sh.tRelease + 0.75) {
        let k;
        if (t < sh.tAppear) k = (t - (sh.tAppear - raise)) / raise;
        else if (t < sh.tRelease + 0.45) k = 1;
        else k = 1 - (t - sh.tRelease - 0.45) / 0.3;
        k = k * k * (3 - 2 * k);
        hand = [hand[0] + (up[0] - hand[0]) * k, hand[1] + (up[1] - hand[1]) * k];
        if (t >= sh.tAppear && t < sh.tRelease) ballPos = rel;
        break;
      }
    }
    const hip = [standX, FLOOR_Y + 0.98];
    const shoulder = [standX + 0.03, FLOOR_Y + 1.5];
    c.strokeStyle = L.figure;
    c.fillStyle = L.figure;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    // 腿
    c.lineWidth = 0.17;
    c.beginPath();
    c.moveTo(hip[0] - 0.05, hip[1]);
    c.lineTo(standX - 0.12, FLOOR_Y + 0.5);
    c.lineTo(standX - 0.1, FLOOR_Y + 0.085);
    c.stroke();
    c.beginPath();
    c.moveTo(hip[0] + 0.05, hip[1]);
    c.lineTo(standX + 0.12, FLOOR_Y + 0.5);
    c.lineTo(standX + 0.1, FLOOR_Y + 0.085);
    c.stroke();
    // 身體
    c.lineWidth = 0.3;
    c.beginPath();
    c.moveTo(hip[0], hip[1] + 0.05);
    c.lineTo(shoulder[0], shoulder[1] - 0.12);
    c.stroke();
    // 頭
    c.beginPath();
    c.arc(standX + 0.04, FLOOR_Y + 1.74, 0.115, 0, Math.PI * 2);
    c.fill();
    // 手臂（肩 → 肘 → 手）
    const elbow = [(shoulder[0] + hand[0]) / 2 + 0.12, (shoulder[1] + hand[1]) / 2 - 0.02];
    c.lineWidth = 0.095;
    c.beginPath();
    c.moveTo(shoulder[0], shoulder[1]);
    c.quadraticCurveTo(elbow[0], elbow[1], hand[0], hand[1]);
    c.stroke();
    return ballPos;
  };

  const drawBall = (c, X, Y, spin, alpha) => {
    c.save();
    c.translate(X, Y);
    c.globalAlpha *= alpha;
    const g = c.createRadialGradient(-0.045, 0.05, 0.01, 0, 0, BALL_R);
    g.addColorStop(0, L.ballLight);
    g.addColorStop(0.55, L.ballMid);
    g.addColorStop(1, L.ballDark);
    c.fillStyle = g;
    c.beginPath();
    c.arc(0, 0, BALL_R, 0, Math.PI * 2);
    c.fill();
    // 球的溝紋：兩條大圓加兩條弧線，會跟著後旋轉
    c.rotate(spin);
    c.strokeStyle = L.seam;
    c.lineWidth = 0.0085;
    c.beginPath();
    c.moveTo(-BALL_R, 0);
    c.lineTo(BALL_R, 0);
    c.moveTo(0, -BALL_R);
    c.lineTo(0, BALL_R);
    c.stroke();
    c.beginPath();
    c.arc(-BALL_R * 1.55, 0, BALL_R * 1.25, -0.72, 0.72);
    c.stroke();
    c.beginPath();
    c.arc(BALL_R * 1.55, 0, BALL_R * 1.25, Math.PI - 0.72, Math.PI + 0.72);
    c.stroke();
    c.restore();
  };

  const drawNet = (c) => {
    c.strokeStyle = L.net;
    c.lineWidth = 0.011;
    const top = [0.012, RIM_DIAMETER_M - 0.012];
    const bot = [0.095, RIM_DIAMETER_M - 0.095];
    const depth = 0.4;
    const n = 6;
    c.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = i / n;
      // 兩個方向的斜線交織成網
      for (const shift of [-1, 1]) {
        const b = Math.min(1, Math.max(0, a + shift / n));
        c.moveTo(top[0] + (top[1] - top[0]) * a, -0.01);
        c.lineTo(bot[0] + (bot[1] - bot[0]) * b, -depth);
      }
    }
    c.stroke();
    c.strokeStyle = 'rgba(255,255,255,0.75)';
    c.beginPath();
    c.moveTo(bot[0], -depth);
    c.lineTo(bot[1], -depth);
    c.stroke();
  };

  const drawRim = (c) => {
    c.fillStyle = L.rim;
    c.beginPath();
    c.ellipse(RIM_DIAMETER_M / 2, 0, RIM_DIAMETER_M / 2 + 0.008, 0.019, 0, 0, Math.PI * 2);
    c.fill();
  };

  function draw(ctx, t) {
    ctx.drawImage(bg, 0, 0);
    world(ctx);
    for (const d of L.distractors) {
      ctx.fillStyle = d.color;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fill();
    }
    drawFigure(ctx, t);

    const b = ballAt(plan, t);
    if (b) {
      if (L.shadow) {
        // 地板上的影子：球越高越淡
        const h = b.Y - FLOOR_Y;
        const a = Math.max(0, 0.28 - h * 0.07) * b.alpha;
        if (a > 0.01) {
          ctx.fillStyle = `rgba(0,0,0,${a.toFixed(3)})`;
          ctx.beginPath();
          ctx.ellipse(b.X + 0.05, FLOOR_Y - 0.07, BALL_R * 1.1, 0.028, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // 動態模糊：在曝光時間內沿速度方向畫幾次半透明的球疊起來。
      // 每一層的透明度取成「全部疊起來剛好接近不透明」，頭尾兩端自然變淡。
      const n = b.phase === 'held' ? 1 : Math.max(1, L.blurSamples | 0);
      const layer = n === 1 ? 1 : 1 - Math.pow(0.04, 1 / n);
      for (let i = 0; i < n; i++) {
        const f = n === 1 ? 0 : i / (n - 1) - 0.5;
        const dt = f * L.shutter;
        drawBall(ctx, b.X + b.vx * dt, b.Y + b.vy * dt, b.spin, b.alpha * layer);
      }
    }
    drawRim(ctx);
    drawNet(ctx);
    ctx.restore();

    if (L.watermark) {
      ctx.save();
      ctx.font = `600 ${Math.round(H * 0.022)}px sans-serif`;
      ctx.textBaseline = 'top';
      ctx.fillStyle = 'rgba(20,28,36,0.55)';
      ctx.fillText('SYNTHETIC DEMO', Math.round(W * 0.012), Math.round(H * 0.014));
      ctx.restore();
    }
  }

  return { draw, width: W, height: H, standX };
}
