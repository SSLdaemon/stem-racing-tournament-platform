/**
 * Web Audio synthesized F1 broadcast sound engine.
 * All sounds are generated in-browser — no audio files shipped.
 *
 * Usage:
 *   F1Audio.enable();              // must be called from a user gesture
 *   F1Audio.lightsBeep();          // single red-light beep
 *   F1Audio.lightsOut();           // deep whoosh when lights go out
 *   F1Audio.idleStart()/idleStop();// continuous engine idle
 *   F1Audio.rev(duration);         // engine rev (500ms default)
 *   F1Audio.crowdCheer(duration);  // filtered noise burst
 *   F1Audio.buzzer();              // short buzzer
 *   F1Audio.sweep();               // rising tone for podium reveals
 *   F1Audio.setMuted(true/false);
 */

window.F1Audio = (function () {
  let ctx = null;
  let masterGain = null;
  let muted = false;
  let idleNodes = null;

  function ensureCtx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      masterGain = ctx.createGain();
      masterGain.gain.value = 0.6;
      masterGain.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  function enable() {
    ensureCtx();
  }

  function setMuted(v) {
    muted = !!v;
    if (masterGain) masterGain.gain.value = muted ? 0 : 0.6;
    try { localStorage.setItem('f1_muted', muted ? '1' : '0'); } catch {}
  }

  function getMuted() {
    try { return localStorage.getItem('f1_muted') === '1'; } catch { return false; }
  }
  // restore persisted preference
  if (getMuted()) muted = true;

  // ---- primitives ----
  function envelope(gain, now, attack, hold, release, peak = 1) {
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peak, now + attack);
    gain.gain.setValueAtTime(peak, now + attack + hold);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + attack + hold + release);
  }

  function noiseBuffer(duration = 1) {
    const ac = ensureCtx(); if (!ac) return null;
    const buf = ac.createBuffer(1, Math.floor(ac.sampleRate * duration), ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  function uiTone({
    start = 0,
    frequency = 520,
    endFrequency = null,
    type = 'sine',
    peak = 0.08,
    attack = 0.004,
    hold = 0.025,
    release = 0.06,
  } = {}) {
    if (muted) return;
    const ac = ensureCtx(); if (!ac) return;
    const t = ac.currentTime + start;
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, t);
    if (endFrequency) osc.frequency.exponentialRampToValueAtTime(endFrequency, t + attack + hold + release);
    osc.connect(g); g.connect(masterGain);
    envelope(g, t, attack, hold, release, peak);
    osc.start(t); osc.stop(t + attack + hold + release + 0.03);
  }

  function uiNoise({
    start = 0,
    duration = 0.08,
    peak = 0.08,
    frequency = 900,
    type = 'highpass',
  } = {}) {
    if (muted) return;
    const ac = ensureCtx(); if (!ac) return;
    const nb = noiseBuffer(duration + 0.05); if (!nb) return;
    const t = ac.currentTime + start;
    const src = ac.createBufferSource(); src.buffer = nb;
    const filter = ac.createBiquadFilter(); filter.type = type; filter.frequency.value = frequency; filter.Q.value = 0.8;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    src.connect(filter); filter.connect(g); g.connect(masterGain);
    src.start(t); src.stop(t + duration + 0.04);
  }

  // ---- public sounds ----

  function lightsBeep() {
    if (muted) return;
    const ac = ensureCtx(); if (!ac) return;
    const t = ac.currentTime;
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(880, t);
    osc.connect(g); g.connect(masterGain);
    envelope(g, t, 0.005, 0.06, 0.08, 0.5);
    osc.start(t); osc.stop(t + 0.2);
  }

  function lightsOut() {
    if (muted) return;
    const ac = ensureCtx(); if (!ac) return;
    const t = ac.currentTime;
    // low-pitched sweep down + noise burst = satisfying whoosh
    const osc = ac.createOscillator();
    const og = ac.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(400, t);
    osc.frequency.exponentialRampToValueAtTime(60, t + 0.6);
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.7, t + 0.02);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.65);
    osc.connect(og); og.connect(masterGain);
    osc.start(t); osc.stop(t + 0.7);

    // noise layer
    const nb = noiseBuffer(0.8);
    if (nb) {
      const src = ac.createBufferSource(); src.buffer = nb;
      const nf = ac.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = 500; nf.Q.value = 0.8;
      const ng = ac.createGain();
      ng.gain.setValueAtTime(0.0001, t);
      ng.gain.exponentialRampToValueAtTime(0.5, t + 0.02);
      ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      src.connect(nf); nf.connect(ng); ng.connect(masterGain);
      src.start(t); src.stop(t + 0.8);
    }
  }

  function idleStart() {
    if (muted) return;
    const ac = ensureCtx(); if (!ac) return;
    if (idleNodes) return;
    const t = ac.currentTime;
    // Two detuned sawtooths + lowpass = F1 idle-ish hum
    const osc1 = ac.createOscillator(); osc1.type = 'sawtooth'; osc1.frequency.value = 80;
    const osc2 = ac.createOscillator(); osc2.type = 'sawtooth'; osc2.frequency.value = 83;
    const lfo = ac.createOscillator(); lfo.frequency.value = 7;
    const lfoGain = ac.createGain(); lfoGain.gain.value = 3;
    const filter = ac.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 350;
    const g = ac.createGain(); g.gain.value = 0.0001;
    lfo.connect(lfoGain); lfoGain.connect(osc1.frequency); lfoGain.connect(osc2.frequency);
    osc1.connect(filter); osc2.connect(filter); filter.connect(g); g.connect(masterGain);
    osc1.start(t); osc2.start(t); lfo.start(t);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.4);
    idleNodes = { osc1, osc2, lfo, g };
  }

  function idleStop() {
    if (!idleNodes) return;
    const ac = ensureCtx(); if (!ac) return;
    const t = ac.currentTime;
    const { osc1, osc2, lfo, g } = idleNodes;
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    setTimeout(() => {
      try { osc1.stop(); osc2.stop(); lfo.stop(); } catch {}
    }, 400);
    idleNodes = null;
  }

  function rev(duration = 0.6) {
    if (muted) return;
    const ac = ensureCtx(); if (!ac) return;
    const t = ac.currentTime;
    const osc = ac.createOscillator(); osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(120, t);
    osc.frequency.exponentialRampToValueAtTime(900, t + duration * 0.5);
    osc.frequency.exponentialRampToValueAtTime(250, t + duration);
    const filter = ac.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 2500;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.45, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(filter); filter.connect(g); g.connect(masterGain);
    osc.start(t); osc.stop(t + duration + 0.05);
  }

  function crowdCheer(duration = 2.0) {
    if (muted) return;
    const ac = ensureCtx(); if (!ac) return;
    const t = ac.currentTime;
    const nb = noiseBuffer(duration + 0.1); if (!nb) return;
    const src = ac.createBufferSource(); src.buffer = nb;
    const f1 = ac.createBiquadFilter(); f1.type = 'bandpass'; f1.frequency.value = 900; f1.Q.value = 0.7;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.3);
    g.gain.setValueAtTime(0.35, t + duration - 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    src.connect(f1); f1.connect(g); g.connect(masterGain);
    src.start(t); src.stop(t + duration + 0.05);

    // subtle "woo" oscillator layered in
    const osc = ac.createOscillator(); osc.type = 'sine';
    osc.frequency.setValueAtTime(220, t);
    osc.frequency.linearRampToValueAtTime(440, t + duration * 0.6);
    osc.frequency.linearRampToValueAtTime(330, t + duration);
    const og = ac.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.08, t + 0.4);
    og.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(og); og.connect(masterGain);
    osc.start(t); osc.stop(t + duration + 0.05);
  }

  function buzzer() {
    if (muted) return;
    const ac = ensureCtx(); if (!ac) return;
    const t = ac.currentTime;
    const osc = ac.createOscillator(); osc.type = 'square';
    osc.frequency.setValueAtTime(220, t);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
    g.gain.setValueAtTime(0.35, t + 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    osc.connect(g); g.connect(masterGain);
    osc.start(t); osc.stop(t + 0.35);
  }

  function sweep() {
    if (muted) return;
    const ac = ensureCtx(); if (!ac) return;
    const t = ac.currentTime;
    const osc = ac.createOscillator(); osc.type = 'triangle';
    osc.frequency.setValueAtTime(220, t);
    osc.frequency.exponentialRampToValueAtTime(1760, t + 0.6);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.28, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.65);
    osc.connect(g); g.connect(masterGain);
    osc.start(t); osc.stop(t + 0.7);
  }

  function pop() {
    if (muted) return;
    const ac = ensureCtx(); if (!ac) return;
    const t = ac.currentTime;
    const osc = ac.createOscillator(); osc.type = 'sine';
    osc.frequency.setValueAtTime(1200, t);
    osc.frequency.exponentialRampToValueAtTime(220, t + 0.15);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    osc.connect(g); g.connect(masterGain);
    osc.start(t); osc.stop(t + 0.25);
  }

  function uiClick() {
    uiTone({ frequency: 620, endFrequency: 980, type: 'triangle', peak: 0.045, hold: 0.012, release: 0.045 });
  }

  function uiConfirm() {
    uiTone({ frequency: 560, type: 'sine', peak: 0.055, hold: 0.02, release: 0.06 });
    uiTone({ start: 0.055, frequency: 840, type: 'sine', peak: 0.07, hold: 0.035, release: 0.09 });
  }

  function uiError() {
    uiTone({ frequency: 170, endFrequency: 120, type: 'square', peak: 0.075, hold: 0.08, release: 0.06 });
    uiTone({ start: 0.13, frequency: 125, endFrequency: 95, type: 'square', peak: 0.055, hold: 0.055, release: 0.055 });
  }

  function uiDanger() {
    uiNoise({ duration: 0.12, peak: 0.05, frequency: 650, type: 'bandpass' });
    uiTone({ frequency: 280, endFrequency: 90, type: 'sawtooth', peak: 0.08, hold: 0.05, release: 0.14 });
  }

  function uiStart() {
    uiTone({ frequency: 110, endFrequency: 460, type: 'sawtooth', peak: 0.07, hold: 0.035, release: 0.12 });
    uiNoise({ start: 0.03, duration: 0.16, peak: 0.035, frequency: 1200, type: 'bandpass' });
    uiTone({ start: 0.11, frequency: 880, type: 'square', peak: 0.045, hold: 0.018, release: 0.055 });
  }

  function uiBackup() {
    uiTone({ frequency: 620, type: 'sine', peak: 0.045, hold: 0.018, release: 0.06 });
    uiTone({ start: 0.05, frequency: 930, type: 'sine', peak: 0.055, hold: 0.02, release: 0.07 });
    uiTone({ start: 0.105, frequency: 1240, type: 'triangle', peak: 0.045, hold: 0.018, release: 0.08 });
  }

  function uiSound(kind = 'click') {
    if (kind === 'confirm' || kind === 'success') return uiConfirm();
    if (kind === 'error') return uiError();
    if (kind === 'danger') return uiDanger();
    if (kind === 'start') return uiStart();
    if (kind === 'backup') return uiBackup();
    return uiClick();
  }

  return { enable, setMuted, isMuted: () => muted,
    lightsBeep, lightsOut, idleStart, idleStop, rev, crowdCheer, buzzer, sweep, pop,
    uiSound, uiClick, uiConfirm, uiError, uiDanger, uiStart, uiBackup };
})();
