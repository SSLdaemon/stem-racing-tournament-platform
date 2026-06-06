const CONTROL_PAGE_PATHS = new Set([
  '/admin',
  '/admin.html',
  '/backups',
  '/backups.html',
  '/race',
  '/race.html',
  '/bracket',
  '/bracket.html',
  '/overlay',
  '/overlay.html',
]);

function spectatorRedirectPath(req) {
  if (req.path === '/' || req.path === '/index.html') return '/spectator';
  if ((req.path === '/leaderboard' || req.path === '/leaderboard.html') && !hasQuery(req, 'spectator')) {
    return '/leaderboard?spectator=1';
  }
  if ((req.path === '/schedule' || req.path === '/schedule.html') && !hasQuery(req, 'spectator')) {
    return '/schedule?spectator=1';
  }
  return null;
}

function isRestrictedNetworkRequest(req) {
  if (CONTROL_PAGE_PATHS.has(req.path)) return true;
  if (req.path.startsWith('/api/backups')) return true;
  if (req.path.startsWith('/api/export')) return true;
  if (req.path === '/api/archive') return true;
  if (req.path.startsWith('/api/') && req.method !== 'GET') return true;
  return false;
}

function isLocalRequest(req) {
  const address = normalizeRemoteAddress(req.socket?.remoteAddress || req.ip || '');
  return address === '::1' || address === '127.0.0.1' || address.startsWith('127.');
}

function normalizeRemoteAddress(address) {
  return String(address || '').replace(/^::ffff:/, '');
}

function hasQuery(req, name) {
  return Object.prototype.hasOwnProperty.call(req.query || {}, name);
}

module.exports = {
  isLocalRequest,
  isRestrictedNetworkRequest,
  normalizeRemoteAddress,
  spectatorRedirectPath,
};
