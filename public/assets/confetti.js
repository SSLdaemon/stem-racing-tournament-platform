/**
 * Lightweight canvas confetti. No external dependencies.
 *
 * Usage:
 *   F1Confetti.burst();                  // single burst from center
 *   F1Confetti.burst({ x: 0.5, y: 0.3 }); // normalized coords
 *   F1Confetti.rain(4000);               // continuous for N ms
 *   F1Confetti.stop();
 */

window.F1Confetti = (function () {
  let canvas, ctx;
  const particles = [];
  let rafId = null;
  let rainingUntil = 0;

  const colors = ['#00e6d2', '#ff2e92', '#c8ff4e', '#ffcc33', '#ffffff', '#ff3355'];

  function ensureCanvas() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:9999;';
    document.body.appendChild(canvas);
    resize();
    window.addEventListener('resize', resize);
    ctx = canvas.getContext('2d');
  }

  function resize() {
    if (!canvas) return;
    canvas.width = window.innerWidth * devicePixelRatio;
    canvas.height = window.innerHeight * devicePixelRatio;
    canvas.getContext('2d').scale(devicePixelRatio, devicePixelRatio);
  }

  function spawn(n, origin) {
    ensureCanvas();
    for (let i = 0; i < n; i++) {
      const angle = (Math.random() * Math.PI * 2);
      const speed = 8 + Math.random() * 14;
      particles.push({
        x: origin.x * innerWidth,
        y: origin.y * innerHeight,
        vx: Math.cos(angle) * speed * (0.5 + Math.random()),
        vy: Math.sin(angle) * speed - 6 - Math.random() * 4,
        g: 0.35 + Math.random() * 0.2,
        w: 6 + Math.random() * 6,
        h: 3 + Math.random() * 4,
        rot: Math.random() * Math.PI * 2,
        rotv: (Math.random() - 0.5) * 0.3,
        color: colors[(Math.random() * colors.length) | 0],
        life: 120 + Math.random() * 80,
      });
    }
    if (!rafId) loop();
  }

  function burst(opts = {}) {
    const origin = { x: opts.x ?? 0.5, y: opts.y ?? 0.5 };
    spawn(opts.count ?? 80, origin);
  }

  function rain(durationMs = 4000) {
    rainingUntil = performance.now() + durationMs;
    ensureCanvas();
    if (!rafId) loop();
  }

  function stop() {
    rainingUntil = 0;
    particles.length = 0;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
    canvas = ctx = null;
  }

  function loop() {
    if (!canvas || !ctx) { rafId = null; return; }
    ctx.clearRect(0, 0, innerWidth, innerHeight);

    // continuous rain spawning
    if (performance.now() < rainingUntil) {
      for (let i = 0; i < 4; i++) {
        particles.push({
          x: Math.random() * innerWidth,
          y: -10,
          vx: (Math.random() - 0.5) * 2,
          vy: 2 + Math.random() * 3,
          g: 0.08,
          w: 6 + Math.random() * 6,
          h: 3 + Math.random() * 4,
          rot: Math.random() * Math.PI * 2,
          rotv: (Math.random() - 0.5) * 0.2,
          color: colors[(Math.random() * colors.length) | 0],
          life: 400,
        });
      }
    }

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx; p.y += p.vy; p.vy += p.g; p.rot += p.rotv; p.life--;
      if (p.y > innerHeight + 40 || p.life <= 0) {
        particles.splice(i, 1); continue;
      }
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = Math.min(1, p.life / 80);
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }

    if (particles.length === 0 && performance.now() >= rainingUntil) {
      rafId = null;
      return;
    }
    rafId = requestAnimationFrame(loop);
  }

  return { burst, rain, stop };
})();
