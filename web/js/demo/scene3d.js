// 3D 合成練投畫面的繪圖（synth3d.js 的劇本 + camera3d.js 的針孔相機）。
//
// 只用標準的 Canvas 2D API：瀏覽器（示範模式、示範錄影）和 Node（產生瀏覽器測試用的假相機影片，
// 透過 @napi-rs/canvas）用同一份程式。畫面上的人是幾何圖形拼成的剪影，不是任何真人；角落固定印著 SYNTHETIC DEMO。
//
// 左下角有一條「幀號條碼」：模擬偵測器（core/simdetect.js）讀它來知道這是第幾幀、去查這一幀的真實答案。
// 這樣即使畫面經過相機串流、縮放，模擬偵測器也對得上答案。

import { project, BOARD, RIM_Y, RIM_R, SHOOT_X } from '../core/camera3d.js';
import { ballsAt, BALL_R } from '../core/synth3d.js';

export const BARCODE_BITS = 20;

/** 條碼的格子：每格邊長（像素）、位置。讀和畫用同一個函式，才不會對不上。 */
export function barcodeLayout(width, height) {
  const cell = Math.max(6, Math.round(height / 42));
  const x0 = Math.round(cell * 1.2);
  const y0 = height - Math.round(cell * 2.4);
  // 開頭兩格固定是 白、黑（同步用），接著 20 格是幀號（低位在前）
  return { cell, x0, y0, count: BARCODE_BITS + 2 };
}

export function drawBarcode(ctx, frame, width, height) {
  const L = barcodeLayout(width, height);
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(L.x0 - L.cell * 0.5, L.y0 - L.cell * 0.5, L.cell * (L.count + 1), L.cell * 2);
  for (let i = 0; i < L.count; i++) {
    const bit = i === 0 ? 1 : i === 1 ? 0 : (frame >> (i - 2)) & 1;
    ctx.fillStyle = bit ? '#fff' : '#000';
    ctx.fillRect(L.x0 + i * L.cell, L.y0, L.cell, L.cell);
  }
  ctx.restore();
}

/**
 * 從畫面像素讀回幀號。
 * @param {Uint8ClampedArray} rgba 寬 w、高 h 的 RGBA
 * @param {{scale:number, padX:number, padY:number}} [lb] 這張圖是原始畫面縮放補邊後的結果時給（模型輸入）
 * @param {number} srcW @param {number} srcH 原始畫面大小
 * @returns {number|null} 讀不到（同步格不對）時回傳 null
 */
export function readBarcode(rgba, w, h, srcW, srcH, lb) {
  const L = barcodeLayout(srcW, srcH);
  const k = lb ? lb.scale : w / srcW;
  const ox = lb ? lb.padX : 0;
  const oy = lb ? lb.padY : 0;
  const lum = (i) => {
    const x = Math.round((L.x0 + (i + 0.5) * L.cell) * k + ox);
    const y = Math.round((L.y0 + 0.5 * L.cell) * k + oy);
    if (x < 0 || y < 0 || x >= w || y >= h) return -1;
    const p = (y * w + x) * 4;
    return 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  };
  if (!(lum(0) > 170 && lum(1) >= 0 && lum(1) < 85)) return null;
  let v = 0;
  for (let i = 0; i < BARCODE_BITS; i++) {
    const l = lum(i + 2);
    if (l < 0) return null;
    if (l > 128) v |= 1 << i;
  }
  return v;
}

const LOOK = {
  wall: '#d9dfe4',
  wallLow: '#b9c4cc',
  floor: '#c79d67',
  floorFar: '#b48a56',
  line: 'rgba(250,246,238,0.9)',
  board: '#f7f9fa',
  boardEdge: '#3f474e',
  target: '#e4571b',
  pole: '#4f5961',
  rim: '#e4571b',
  net: 'rgba(255,255,255,0.85)',
  figure: '#384451',
  figure2: '#6b5a7a',
  ball: ['#f6b673', '#dd7430', '#8e4319'],
  seam: '#24160f',
};

/**
 * @param {object} plan makeScene3d 的結果
 * @returns {{draw(ctx, t:number, frame?:number):void, width:number, height:number}}
 */
export function createScene3dRenderer(plan, opts = {}) {
  const cam = plan.cam;
  const W = plan.width;
  const H = plan.height;
  const P = (X, Y, Z) => project(cam, X, Y, Z);
  const ok = (...ps) => ps.every((p) => p.depth > 0.2);
  const watermark = opts.watermark !== false;

  const poly = (ctx, pts3, fill, stroke, lw) => {
    const ps = pts3.map(([X, Y, Z]) => P(X, Y, Z));
    if (!ok(...ps)) return;
    ctx.beginPath();
    ps.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lw || 1;
      ctx.stroke();
    }
  };
  const seg = (ctx, a, b, color, widthM) => {
    const p = P(...a);
    const q = P(...b);
    if (!ok(p, q)) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, (cam.f * widthM) / ((p.depth + q.depth) / 2));
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(q.x, q.y);
    ctx.stroke();
  };

  // ── 籃架（任何一個籃框） ──
  // dir：投籃方向（籃板在籃框的哪一邊），我們的籃框是 +x
  const hoopParts = (hx, hz, dir, withBoard) => {
    const ux = dir[0];
    const uz = dir[1];
    const lx = -uz;
    const lz = ux;
    const at = (a, y, l) => [hx + ux * a + lx * l, y, hz + uz * a + lz * l];
    const parts = [];
    const center = P(hx, RIM_Y, hz);
    if (withBoard) {
      const bf = BOARD.x0;
      const bb = BOARD.x1;
      // 立柱和橫臂
      parts.push({
        depth: P(...at(bb + 1.3, 1.5, 0)).depth,
        draw: (ctx) => {
          seg(ctx, at(bb + 1.3, 0, 0), at(bb + 1.3, 3.5, 0), LOOK.pole, 0.16);
          seg(ctx, at(bb + 1.3, 3.4, 0), at(bb + 0.05, 3.25, 0), LOOK.pole, 0.1);
        },
      });
      parts.push({
        depth: P(...at(bf, 3.4, 0)).depth + 0.01,
        draw: (ctx) => {
          // 籃板：正面、側面（厚度）
          const face = [at(bf, BOARD.y0, BOARD.z0), at(bf, BOARD.y0, BOARD.z1), at(bf, BOARD.y1, BOARD.z1), at(bf, BOARD.y1, BOARD.z0)];
          const back = [at(bb, BOARD.y0, BOARD.z0), at(bb, BOARD.y0, BOARD.z1), at(bb, BOARD.y1, BOARD.z1), at(bb, BOARD.y1, BOARD.z0)];
          for (const side of [[face[1], back[1], back[2], face[2]], [face[0], back[0], back[3], face[3]], [face[3], back[3], back[2], face[2]]]) poly(ctx, side, LOOK.boardEdge);
          poly(ctx, face, LOOK.board, LOOK.boardEdge, 2);
          // 籃框上方的小方框
          poly(ctx, [at(bf - 0.002, 3.0, -0.295), at(bf - 0.002, 3.0, 0.295), at(bf - 0.002, 3.45, 0.295), at(bf - 0.002, 3.45, -0.295)], null, LOOK.target, Math.max(1.5, cam.f * 0.05 / center.depth));
          // 籃框和籃板之間的支架
          seg(ctx, at(RIM_R, RIM_Y, 0), at(bf, RIM_Y, 0), LOOK.rim, 0.04);
        },
      });
    }
    const ring = [];
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * 2 * Math.PI;
      ring.push([hx + (RIM_R + 0.009) * Math.cos(a), RIM_Y, hz + (RIM_R + 0.009) * Math.sin(a)]);
    }
    const net = [];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * 2 * Math.PI;
      net.push([[hx + RIM_R * Math.cos(a), RIM_Y, hz + RIM_R * Math.sin(a)], [hx + 0.14 * Math.cos(a + 0.35), RIM_Y - 0.42, hz + 0.14 * Math.sin(a + 0.35)]]);
    }
    const rimHalf = (near) => (ctx) => {
      const ps = ring.map((r) => P(...r));
      if (!ok(...ps)) return;
      ctx.strokeStyle = LOOK.rim;
      ctx.lineWidth = Math.max(1.5, (cam.f * 0.02) / center.depth);
      ctx.lineCap = 'round';
      for (let i = 0; i < ps.length; i++) {
        const a = ps[i];
        const b = ps[(i + 1) % ps.length];
        if ((a.depth < center.depth) !== near) continue;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    };
    parts.push({ depth: center.depth + 0.2, draw: rimHalf(false) });
    parts.push({
      depth: center.depth - 0.05,
      draw: (ctx) => {
        for (const [a, b] of net) seg(ctx, a, b, LOOK.net, 0.012);
        const bottom = [];
        for (let i = 0; i <= 12; i++) {
          const a = (i / 12) * 2 * Math.PI;
          bottom.push(P(hx + 0.14 * Math.cos(a), RIM_Y - 0.42, hz + 0.14 * Math.sin(a)));
        }
        if (ok(...bottom)) {
          ctx.strokeStyle = LOOK.net;
          ctx.lineWidth = Math.max(1, (cam.f * 0.01) / center.depth);
          ctx.beginPath();
          bottom.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
          ctx.stroke();
        }
      },
    });
    parts.push({ depth: center.depth - 0.25, draw: rimHalf(true) });
    return parts;
  };

  const figure = (x, z, color, armTo) => {
    const hip = [x, 0.98, z];
    const sh = [x + 0.03, 1.5, z];
    return {
      depth: P(x, 1, z).depth,
      draw: (ctx) => {
        seg(ctx, [x - 0.05, 0.98, z - 0.1], [x - 0.1, 0.05, z - 0.12], color, 0.15);
        seg(ctx, [x + 0.05, 0.98, z + 0.1], [x + 0.1, 0.05, z + 0.12], color, 0.15);
        seg(ctx, hip, [sh[0], sh[1] - 0.1, z], color, 0.32);
        const head = P(x + 0.04, 1.74, z);
        if (head.depth > 0.2) {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(head.x, head.y, Math.max(2, (cam.f * 0.115) / head.depth), 0, Math.PI * 2);
          ctx.fill();
        }
        const hand = armTo || [x + 0.25, 1.15, z + 0.12];
        seg(ctx, [sh[0], sh[1], z + 0.15], hand, color, 0.09);
        seg(ctx, [sh[0], sh[1], z - 0.15], [hand[0], hand[1], hand[2] - 0.2], color, 0.09);
      },
    };
  };

  const ballPart = (b) => {
    const c = P(b.X, b.Y, b.Z);
    return {
      depth: c.depth,
      draw: (ctx) => {
        if (!(c.depth > 0.2)) return;
        const r = (cam.f * BALL_R) / c.depth;
        ctx.save();
        if (b.fade) ctx.globalAlpha = 0.6;
        const g = ctx.createRadialGradient(c.x - r * 0.35, c.y - r * 0.4, r * 0.1, c.x, c.y, r);
        g.addColorStop(0, LOOK.ball[0]);
        g.addColorStop(0.55, LOOK.ball[1]);
        g.addColorStop(1, LOOK.ball[2]);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
        ctx.fill();
        if (r > 4) {
          ctx.strokeStyle = LOOK.seam;
          ctx.lineWidth = Math.max(0.8, r * 0.07);
          ctx.beginPath();
          ctx.moveTo(c.x - r, c.y);
          ctx.lineTo(c.x + r, c.y);
          ctx.moveTo(c.x, c.y - r);
          ctx.lineTo(c.x, c.y + r);
          ctx.stroke();
        }
        ctx.restore();
      },
    };
  };

  // 地板和牆的分界：假設 14 公尺外有一面牆
  const wallBase = () => {
    const far = 14;
    const p = (cam.pitchDeg * Math.PI) / 180;
    return H / 2 - cam.f * Math.tan(p) + (cam.f * cam.camHeight) / far;
  };

  const courtLines = [
    // 罰球線、禁區兩側、底線（我們的籃框那一端）
    [[SHOOT_X, 0.001, -2.45], [SHOOT_X, 0.001, 2.45]],
    [[SHOOT_X, 0.001, -2.45], [1.575, 0.001, -2.45]],
    [[SHOOT_X, 0.001, 2.45], [1.575, 0.001, 2.45]],
    [[1.575, 0.001, -7.5], [1.575, 0.001, 7.5]],
  ];

  function draw(ctx, t, frame) {
    ctx.save();
    ctx.fillStyle = LOOK.wall;
    ctx.fillRect(0, 0, W, H);
    const yb = Math.max(0, Math.min(H, wallBase()));
    const g = ctx.createLinearGradient(0, 0, 0, yb);
    g.addColorStop(0, LOOK.wall);
    g.addColorStop(1, LOOK.wallLow);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, yb);
    const gf = ctx.createLinearGradient(0, yb, 0, H);
    gf.addColorStop(0, LOOK.floorFar);
    gf.addColorStop(1, LOOK.floor);
    ctx.fillStyle = gf;
    ctx.fillRect(0, yb, W, H - yb);
    for (const [a, b] of courtLines) seg(ctx, a, b, LOOK.line, 0.05);

    const parts = [];
    parts.push(...hoopParts(0, 0, [1, 0], true));
    if (plan.otherHoop) parts.push(...hoopParts(plan.otherHoop.x, plan.otherHoop.z, plan.otherHoop.dir, false));
    const balls = ballsAt(plan, t);
    const held = balls.find((b) => b.owner === 'me' && b.phase === 'held');
    parts.push(figure(SHOOT_X - 0.35, 0, LOOK.figure, held ? [held.X - 0.05, held.Y - 0.05, held.Z] : null));
    if (plan.otherHoop) {
      parts.push(figure(plan.otherHoop.x - 0.3, plan.otherHoop.z + 4.9, LOOK.figure2));
      parts.push(figure(-6.6, -2.5, LOOK.figure2));
      parts.push(figure(-8.8, -4, LOOK.figure2));
      parts.push(figure(-4.2, -6.2, LOOK.figure2));
    }
    for (const b of balls) parts.push(ballPart(b));
    parts.sort((a, b) => b.depth - a.depth);
    for (const p of parts) p.draw(ctx);

    if (watermark) {
      ctx.font = `600 ${Math.round(H * 0.024)}px sans-serif`;
      ctx.textBaseline = 'top';
      ctx.fillStyle = 'rgba(20,28,36,0.55)';
      ctx.fillText('SYNTHETIC DEMO', Math.round(W * 0.012), Math.round(H * 0.014));
    }
    if (frame != null) drawBarcode(ctx, frame, W, H);
    ctx.restore();
  }

  return { draw, width: W, height: H };
}
