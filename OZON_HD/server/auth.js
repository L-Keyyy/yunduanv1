/*
 * 此代码为刻度航宇编写，复制与逆向属于违法行为。不允许解析我的代码
 */
/**
 * Authentication helpers.
 * Supports both JWT bearer tokens and API keys.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { stores } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'oumaitong-jwt-secret-change-me';
const JWT_EXPIRES = '7d';
const AUTH_COOKIE_NAME = process.env.AUTH_COOKIE_NAME || 'omtozon_token';
const AUTH_COOKIE_ALIASES = [...new Set([AUTH_COOKIE_NAME, 'ozon_token'])];

function signToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function hashDeviceToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function getApiKeyCandidates(apiKey) {
  const value = String(apiKey || '').trim();
  if (!value) {
    return [];
  }

  const candidates = [value];
  if (value.startsWith('ozon_')) {
    candidates.push(`omt_${value.slice(5)}`);
  } else if (value.startsWith('omt_')) {
    candidates.push(`ozon_${value.slice(4)}`);
  }

  return [...new Set(candidates)];
}

function resolveUserFromAuthorizationHeader(header) {
  if (!header) {
    return null;
  }

  if (header.startsWith('ApiKey ')) {
    const apiKey = header.slice(7).trim();
    const candidates = getApiKeyCandidates(apiKey);
    return stores.users.findOne((user) => candidates.includes(user.api_key)) || null;
  }

  if (header.startsWith('Bearer ')) {
    const token = header.slice(7);
    const payload = verifyToken(token);
    return stores.users.get(payload.userId) || null;
  }

  if (header.startsWith('DeviceKey ')) {
    const token = header.slice(10).trim();
    const tokenHash = hashDeviceToken(token);
    const device = stores.devices.findOne(
      (item) => !item.revoked_at && item.token_hash === tokenHash
    );
    if (!device) {
      return null;
    }
    stores.devices.update(device.id, { last_used_at: new Date().toISOString() });
    return stores.users.get(device.user_id) || null;
  }

  return null;
}

function parseCookieHeader(cookieHeader) {
  return String(cookieHeader || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separator = part.indexOf('=');
      if (separator === -1) {
        return cookies;
      }

      const name = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      if (!name) {
        return cookies;
      }

      try {
        cookies[name] = decodeURIComponent(value);
      } catch (_error) {
        cookies[name] = value;
      }
      return cookies;
    }, {});
}

function resolveUserFromCookieHeader(cookieHeader) {
  const cookies = parseCookieHeader(cookieHeader);
  for (const cookieName of AUTH_COOKIE_ALIASES) {
    const token = cookies[cookieName];
    if (!token) {
      continue;
    }

    const payload = verifyToken(token);
    const user = stores.users.get(payload.userId);
    if (user) {
      return user;
    }
  }

  return null;
}

function resolveUserFromRequest(req) {
  return (
    resolveUserFromAuthorizationHeader(req.headers.authorization || '') ||
    resolveUserFromCookieHeader(req.headers.cookie || '')
  );
}

function authMiddleware(req, res, next) {
  try {
    const user = resolveUserFromRequest(req);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    req.user = user;
    return next();
  } catch (error) {
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Invalid or expired token.' });
    }

    if (header.startsWith('ApiKey ')) {
      return res.status(401).json({ error: 'Invalid API key.' });
    }

    return res.status(401).json({ error: 'Unsupported authorization format.' });
  }
}

module.exports = {
  signToken,
  verifyToken,
  resolveUserFromAuthorizationHeader,
  resolveUserFromCookieHeader,
  resolveUserFromRequest,
  hashDeviceToken,
  authMiddleware,
  AUTH_COOKIE_NAME,
  JWT_SECRET,
};
