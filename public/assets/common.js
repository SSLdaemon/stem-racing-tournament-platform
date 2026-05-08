/* Shared client-side helpers used by all pages. */

window.F1 = (function () {
  const listeners = new Set();
  let state = null;
  const socket = io();
  const AUDIO_SCRIPT = '/assets/audio.js';

  function ensureAudioScript() {
    if (window.F1Audio || document.querySelector(`script[src="${AUDIO_SCRIPT}"]`)) return;
    const script = document.createElement('script');
    script.src = AUDIO_SCRIPT;
    script.defer = true;
    document.head.appendChild(script);
  }

  function soundMuted() {
    try { return localStorage.getItem('f1_muted') === '1'; } catch { return false; }
  }

  function setSoundMuted(muted) {
    if (window.F1Audio) {
      window.F1Audio.enable();
      window.F1Audio.setMuted(muted);
    } else {
      try { localStorage.setItem('f1_muted', muted ? '1' : '0'); } catch {}
    }
    updateSoundToggle();
  }

  function playSound(kind = 'click') {
    if (soundMuted()) return;
    const audio = window.F1Audio;
    if (!audio?.uiSound) return;
    audio.enable();
    audio.uiSound(kind);
  }

  function soundKindForElement(el) {
    if (!el?.closest || el.disabled || el.closest('[data-sound-toggle]')) return null;
    const interactive = el.closest('button, a.btn, input[type="submit"], input[type="button"], input[type="checkbox"], select, .check-row');
    if (!interactive || interactive.disabled) return null;
    const text = `${interactive.textContent || ''} ${interactive.value || ''}`.toLowerCase();
    if (interactive.classList.contains('danger') || /reset|delete|remove|restore/.test(text)) return 'danger';
    if (/start tournament|run start lights|racing now|confirm result|show versus intro/.test(text)) return 'start';
    if (/backup|archive|download|export/.test(text)) return 'backup';
    if (interactive.classList.contains('primary') || /add team|generate|create|confirm|save|refresh/.test(text)) return 'confirm';
    return 'click';
  }

  function updateSoundToggle() {
    const muted = soundMuted();
    document.querySelectorAll('[data-sound-toggle]').forEach((button) => {
      button.classList.toggle('muted', muted);
      button.textContent = muted ? 'Sound off' : 'Sound on';
      button.title = muted ? 'Sound effects muted' : 'Sound effects on';
      button.setAttribute('aria-pressed', muted ? 'false' : 'true');
    });
  }

  ensureAudioScript();

  socket.on('state', (s) => {
    state = s;
    for (const fn of listeners) {
      try { fn(s); } catch (err) { console.error(err); }
    }
  });

  function onState(fn) {
    listeners.add(fn);
    if (state) fn(state);
    return () => listeners.delete(fn);
  }

  async function api(method, url, body, isForm = false) {
    const opts = { method };
    if (body) {
      if (isForm) {
        opts.body = body;
      } else {
        opts.headers = { 'Content-Type': 'application/json' };
        opts.body = JSON.stringify(body);
      }
    }
    const res = await fetch(url, opts);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Request failed');
    }
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
  }

  function toast(msg, { type = 'info', duration = 2800 } = {}) {
    playSound(type === 'error' ? 'error' : 'success');
    let el = document.getElementById('__toast');
    if (!el) {
      el = document.createElement('div');
      el.id = '__toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.toggle('error', type === 'error');
    el.classList.add('show');
    clearTimeout(el.__t);
    el.__t = setTimeout(() => el.classList.remove('show'), duration);
  }

  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null) continue;
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else e.setAttribute(k, v);
    }
    for (const k of kids.flat()) {
      if (k == null || k === false) continue;
      e.appendChild(k.nodeType ? k : document.createTextNode(k));
    }
    return e;
  }

  function logoStyle(team) {
    if (team && team.logoPath) return `background-image: url(${team.logoPath}); background-color: ${team.color || '#0a0c11'};`;
    return `background: ${team?.color || '#243041'};`;
  }

  function fmtTime(t) {
    if (t == null) return '\u2014';
    const n = Number(t);
    if (Number.isNaN(n)) return '\u2014';
    return n.toFixed(3) + 's';
  }

  function teamBadge(team, { size = '' } = {}) {
    const sizeCls = size ? ' ' + size : '';
    return `<span class="logo${sizeCls}" style="${logoStyle(team)}"></span>`;
  }

  function topbar(pageId) {
    const links = [
      ['/', 'Home', 'home'],
      ['/admin', 'Admin', 'admin'],
      ['/backups', 'Backups', 'backups'],
      ['/race', 'Race', 'race'],
      ['/leaderboard', 'Leaderboard', 'leaderboard'],
      ['/schedule', 'Schedule', 'schedule'],
      ['/bracket', 'Bracket', 'bracket'],
      ['/overlay', 'Overlay', 'overlay'],
    ];
    const nav = links.map(([href, label, id]) =>
      `<a href="${href}" class="${id === pageId ? 'active' : ''}" target="${id === pageId ? '_self' : '_blank'}">${label}</a>`
    ).join('');
    return `
      <header class="topbar">
        <div class="brand">
          <img class="brand-logo" src="/assets/media/stem-racing-logo-dark.png" alt="STEM Racing" />
          <span class="brand-copy">
            <span class="brand-kicker">Race Control</span>
            <span id="brandName">Tournament Platform</span>
          </span>
          <span class="live-dot" title="Live"></span>
        </div>
        <div class="topbar-actions">
          <nav>${nav}</nav>
          <button class="sound-toggle" type="button" data-sound-toggle aria-label="Toggle sound effects" aria-pressed="true">Sound on</button>
        </div>
      </header>`;
  }

  document.addEventListener('pointerdown', (event) => {
    const kind = soundKindForElement(event.target);
    if (kind) playSound(kind);
  }, true);

  document.addEventListener('click', (event) => {
    const button = event.target?.closest?.('[data-sound-toggle]');
    if (!button) return;
    event.preventDefault();
    const nextMuted = !soundMuted();
    setSoundMuted(nextMuted);
    if (!nextMuted) playSound('confirm');
  }, true);

  document.addEventListener('DOMContentLoaded', () => {
    const slot = document.getElementById('topbar');
    if (slot && slot.dataset.page) slot.outerHTML = topbar(slot.dataset.page);
    updateSoundToggle();
    onState((s) => {
      const b = document.getElementById('brandName');
      if (b && s.tournamentName) b.textContent = s.tournamentName;
    });
  });

  return { onState, api, toast, el, logoStyle, fmtTime, teamBadge, topbar, playSound };
})();
