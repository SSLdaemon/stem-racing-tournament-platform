const LOGO_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
]);

function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
}

function noStoreSensitiveResponses(req, res, next) {
  if (
    req.path === '/admin'
    || req.path === '/admin.html'
    || req.path === '/backups'
    || req.path === '/backups.html'
    || req.path.startsWith('/api/')
  ) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
}

function detectImageKind(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (
    buffer.length >= 8
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
    && buffer[4] === 0x0d
    && buffer[5] === 0x0a
    && buffer[6] === 0x1a
    && buffer[7] === 0x0a
  ) return 'png';

  if (
    buffer.length >= 3
    && buffer[0] === 0xff
    && buffer[1] === 0xd8
    && buffer[2] === 0xff
  ) return 'jpeg';

  return null;
}

function logoMetadataAllowed(file) {
  const original = String(file?.originalname || '').toLowerCase();
  const ext = original.slice(original.lastIndexOf('.'));
  const expectedType = LOGO_TYPES.get(ext);
  return Boolean(expectedType && expectedType === file?.mimetype);
}

function logoFileFilter(_req, file, cb) {
  if (!logoMetadataAllowed(file)) {
    return cb(new Error('Logo must be a PNG or JPG image.'));
  }
  return cb(null, true);
}

module.exports = {
  securityHeaders,
  noStoreSensitiveResponses,
  detectImageKind,
  logoMetadataAllowed,
  logoFileFilter,
};
