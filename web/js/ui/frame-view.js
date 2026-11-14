// 影片畫面的畫布：顯示目前這一幀、疊圖、放大縮小、放大鏡，並把「點了哪裡」換成影片的像素座標。
//
// 操作方式
//   一指（或滑鼠左鍵）：按住會出現放大鏡，可以滑動微調，放開才算點下去
//   兩指：縮放與平移
//   滑鼠滾輪：以游標為中心縮放；按住中鍵或右鍵拖曳：平移
//   按在已經點好的點上拖曳：移動那個點

const MAX_ZOOM = 10;
const HIT_RADIUS = 22; // 判定「按在某個點上」的距離（CSS 像素）

/**
 * @param {object} o
 * @param {HTMLElement} o.stage 外層容器（用來設定長寬比）
 * @param {HTMLCanvasElement} o.canvas
 * @param {HTMLCanvasElement} o.loupe
 * @param {(pos:{x:number,y:number}) => void} [o.onTap] 點了一下（影片像素座標）
 * @param {(id:any, pos:{x:number,y:number}, done:boolean) => void} [o.onDrag] 拖曳某個點
 * @param {(zoom:number) => void} [o.onZoom]
 */
export function createFrameView(o) {
  const { stage, canvas, loupe } = o;
  const ctx = canvas.getContext('2d');
  const lctx = loupe.getContext('2d');
  const frame = document.createElement('canvas'); // 目前這一幀的複本
  const fctx = frame.getContext('2d');
  let imgW = 16;
  let imgH = 9;
  let hasFrame = false;
  let dpr = 1;
  let zoom = 1;
  let tx = 0;
  let ty = 0;
  let overlay = null;
  let handles = () => [];
  let guidePx = 0; // 放大鏡裡球大小的圓圈（影片像素）；0 = 不畫
  let enabled = true;

  const fit = () => Math.min(canvas.width / imgW, canvas.height / imgH);
  const scale = () => fit() * zoom;

  function clampView() {
    const s = scale();
    const w = imgW * s;
    const h = imgH * s;
    tx = w <= canvas.width ? (canvas.width - w) / 2 : Math.min(0, Math.max(canvas.width - w, tx));
    ty = h <= canvas.height ? (canvas.height - h) / 2 : Math.min(0, Math.max(canvas.height - h, ty));
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(3, window.devicePixelRatio || 1);
    const w = Math.max(2, Math.round(rect.width * dpr));
    const h = Math.max(2, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      // 保持畫面中心不變
      const cx = canvas.width ? (canvas.width / 2 - tx) / scale() : imgW / 2;
      const cy = canvas.height ? (canvas.height / 2 - ty) / scale() : imgH / 2;
      canvas.width = w;
      canvas.height = h;
      tx = w / 2 - cx * scale();
      ty = h / 2 - cy * scale();
    }
    clampView();
    render();
  }

  /** 畫面座標（clientX/Y）→ 影片像素座標 */
  function toImage(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const s = scale();
    return {
      x: ((clientX - rect.left) * (canvas.width / rect.width) - tx) / s,
      y: ((clientY - rect.top) * (canvas.height / rect.height) - ty) / s,
    };
  }
  const inside = (p) => p.x >= 0 && p.y >= 0 && p.x <= imgW && p.y <= imgH;

  function render() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#141615';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!hasFrame) return;
    const s = scale();
    ctx.setTransform(s, 0, 0, s, tx, ty);
    ctx.imageSmoothingEnabled = s < 3;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(frame, 0, 0);
    if (overlay) {
      ctx.save();
      // u：一個 CSS 像素在影片座標裡是多長（線寬、點的大小都用它，放大時才不會變粗）
      overlay(ctx, { u: dpr / s, width: imgW, height: imgH, zoom });
      ctx.restore();
    }
  }

  function setZoom(next, pivotX, pivotY) {
    const z = Math.min(MAX_ZOOM, Math.max(1, next));
    const px = pivotX != null ? pivotX : canvas.width / 2;
    const py = pivotY != null ? pivotY : canvas.height / 2;
    const ix = (px - tx) / scale();
    const iy = (py - ty) / scale();
    zoom = z;
    tx = px - ix * scale();
    ty = py - iy * scale();
    clampView();
    render();
    if (o.onZoom) o.onZoom(zoom);
  }

  // ── 放大鏡 ──
  function drawLoupe(clientX, clientY) {
    const p = toImage(clientX, clientY);
    const rect = canvas.getBoundingClientRect();
    const mainCss = scale() / dpr; // 主畫面上一個影片像素是幾個 CSS 像素
    let lcss = Math.max(mainCss * 3, 1.2);
    if (guidePx > 0) lcss = Math.max(lcss, (0.5 * 132) / guidePx);
    lcss = Math.min(lcss, 10);
    const ls = (lcss * loupe.width) / 132; // 放大鏡畫布上一個影片像素是幾個畫布像素
    const half = loupe.width / 2;
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.fillStyle = '#000';
    lctx.fillRect(0, 0, loupe.width, loupe.height);
    lctx.setTransform(ls, 0, 0, ls, half - p.x * ls, half - p.y * ls);
    lctx.imageSmoothingEnabled = ls < 4;
    lctx.drawImage(frame, 0, 0);
    if (overlay) {
      lctx.save();
      overlay(lctx, { u: loupe.width / 132 / ls, width: imgW, height: imgH, zoom, loupe: true });
      lctx.restore();
    }
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    // 準星：中間留空，才看得到要對的東西
    const gap = 9;
    for (const [color, width] of [['rgba(0,0,0,0.65)', 5], ['#ffffff', 2]]) {
      lctx.strokeStyle = color;
      lctx.lineWidth = width;
      lctx.beginPath();
      lctx.moveTo(half, 26);
      lctx.lineTo(half, half - gap);
      lctx.moveTo(half, half + gap);
      lctx.lineTo(half, loupe.height - 26);
      lctx.moveTo(26, half);
      lctx.lineTo(half - gap, half);
      lctx.moveTo(half + gap, half);
      lctx.lineTo(loupe.width - 26, half);
      lctx.stroke();
      if (guidePx > 0) {
        // 和球一樣大的圓：把圓對準球的邊緣，中心就是球心
        lctx.beginPath();
        lctx.arc(half, half, (guidePx / 2) * ls, 0, Math.PI * 2);
        lctx.stroke();
      }
    }
    // 手指在左上角時，放大鏡換到右邊，才不會被手擋住
    const rx = (clientX - rect.left) / rect.width;
    const ry = (clientY - rect.top) / rect.height;
    loupe.classList.toggle('right', rx < 0.5 && ry < 0.62);
    loupe.hidden = false;
  }
  const hideLoupe = () => {
    loupe.hidden = true;
  };

  // ── 指標事件 ──
  const pointers = new Map();
  let mode = null; // 'aim' | 'drag' | 'pinch' | 'pan'
  let dragId = null;
  let pinch = null;
  let pan = null;
  let suppress = false;
  let spaceDown = false;

  function hitHandle(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const s = scale() / dpr;
    let best = null;
    let bestD = HIT_RADIUS;
    for (const h of handles()) {
      const hx = rect.left + (tx / dpr + h.x * s);
      const hy = rect.top + (ty / dpr + h.y * s);
      const d = Math.hypot(hx - clientX, hy - clientY);
      if (d < bestD) {
        bestD = d;
        best = h;
      }
    }
    return best;
  }

  function onDown(e) {
    if (!enabled || !hasFrame) return;
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1 && !suppress) {
      if (e.pointerType === 'mouse' && (e.button === 1 || e.button === 2 || spaceDown)) {
        mode = 'pan';
        pan = { x: e.clientX, y: e.clientY, tx, ty };
      } else if (e.pointerType !== 'mouse' || e.button === 0) {
        const h = hitHandle(e.clientX, e.clientY);
        mode = h ? 'drag' : 'aim';
        dragId = h ? h.id : null;
        drawLoupe(e.clientX, e.clientY);
      }
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      mode = 'pinch';
      dragId = null;
      hideLoupe();
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    }
    e.preventDefault();
  }

  function onMove(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (mode === 'aim' || mode === 'drag') {
      drawLoupe(e.clientX, e.clientY);
      if (mode === 'drag' && o.onDrag) {
        const p = toImage(e.clientX, e.clientY);
        o.onDrag(dragId, { x: Math.min(imgW, Math.max(0, p.x)), y: Math.min(imgH, Math.max(0, p.y)) }, false);
      }
    } else if (mode === 'pinch' && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const rect = canvas.getBoundingClientRect();
      const k = canvas.width / rect.width;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      // 先跟著兩指的中點平移，再以中點為中心縮放
      tx += (mx - pinch.mx) * k;
      ty += (my - pinch.my) * k;
      pinch.mx = mx;
      pinch.my = my;
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      setZoom((pinch.zoom * dist) / pinch.dist, (mx - rect.left) * k, (my - rect.top) * k);
    } else if (mode === 'pan') {
      const rect = canvas.getBoundingClientRect();
      const k = canvas.width / rect.width;
      tx = pan.tx + (e.clientX - pan.x) * k;
      ty = pan.ty + (e.clientY - pan.y) * k;
      clampView();
      render();
    }
  }

  function onUp(e) {
    if (!pointers.has(e.pointerId)) return;
    const cancelled = e.type === 'pointercancel';
    pointers.delete(e.pointerId);
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* 已經放掉了 */
    }
    if (mode === 'aim' && !cancelled) {
      const p = toImage(e.clientX, e.clientY);
      if (inside(p) && o.onTap) o.onTap(p);
    } else if (mode === 'drag' && o.onDrag) {
      const p = toImage(e.clientX, e.clientY);
      o.onDrag(dragId, { x: Math.min(imgW, Math.max(0, p.x)), y: Math.min(imgH, Math.max(0, p.y)) }, true);
    } else if (mode === 'pinch') {
      suppress = pointers.size > 0; // 還有一指留在畫面上：放開時不要當成點擊
    }
    if (mode !== 'pinch' || pointers.size < 2) mode = null;
    if (pointers.size === 0) suppress = false;
    hideLoupe();
  }

  function onWheel(e) {
    if (!enabled || !hasFrame) return;
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const k = canvas.width / rect.width;
    setZoom(zoom * Math.exp(-e.deltaY * 0.0016), (e.clientX - rect.left) * k, (e.clientY - rect.top) * k);
  }
  const onKey = (e) => {
    if (e.code === 'Space') spaceDown = e.type === 'keydown';
  };
  const noMenu = (e) => e.preventDefault();

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', noMenu);
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(canvas);
  window.addEventListener('resize', resize);

  return {
    /** 設定影片的大小（顯示方向）。 */
    setSize(w, h) {
      imgW = w;
      imgH = h;
      frame.width = w;
      frame.height = h;
      hasFrame = false;
      zoom = 1;
      // 長寬比交給 CSS：寬度會依可用的高度縮小，畫面永遠維持影片的比例
      stage.style.setProperty('--ar', String(w / h));
      resize();
    },
    /** 換一幀：把畫面複製一份留著，之後縮放、放大鏡都用這份。 */
    setFrame(image) {
      fctx.drawImage(image, 0, 0, imgW, imgH);
      hasFrame = true;
      render();
    },
    /** 疊圖函式 fn(ctx, {u, width, height, zoom, loupe})，在影片像素座標裡畫。 */
    setOverlay(fn) {
      overlay = fn;
      render();
    },
    /** 可以拖曳的點：fn() 回傳 [{id, x, y}]。 */
    setHandles(fn) {
      handles = fn || (() => []);
    },
    setGuide(px) {
      guidePx = px || 0;
    },
    setEnabled(on) {
      enabled = !!on;
    },
    render,
    resize,
    zoomBy(f) {
      setZoom(zoom * f);
    },
    resetZoom() {
      setZoom(1);
    },
    /** 把某個影片座標移到畫面中央（放大時用）。 */
    centerOn(x, y) {
      tx = canvas.width / 2 - x * scale();
      ty = canvas.height / 2 - y * scale();
      clampView();
      render();
    },
    get zoom() {
      return zoom;
    },
    /** 影片座標 → 畫面座標（測試用）。 */
    toClient(x, y) {
      const rect = canvas.getBoundingClientRect();
      const s = scale();
      return { x: rect.left + (tx + x * s) / (canvas.width / rect.width), y: rect.top + (ty + y * s) / (canvas.height / rect.height) };
    },
    toImage,
    /** 目前這一幀的複本（畫縮圖用）。 */
    get frameCanvas() {
      return frame;
    },
    destroy() {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', noMenu);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('resize', resize);
      if (ro) ro.disconnect();
    },
  };
}
