/**
 * Simple API key middleware.
 * If API_KEY is set in env, all requests must include it
 * as a Bearer token or x-api-key header.
 */
function authMiddleware(req, res, next) {
  const apiKey = process.env.API_KEY;

  // If no API key configured, skip auth
  if (!apiKey) return next();

  const headerKey =
    req.headers["x-api-key"] ||
    (req.headers.authorization || "").replace("Bearer ", "");

  if (headerKey === apiKey) {
    return next();
  }

  return res.status(401).json({ success: false, error: "Unauthorized" });
}

module.exports = { authMiddleware };
