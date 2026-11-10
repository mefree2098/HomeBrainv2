// Long-lived transports must not outlive the credentials used to open them.
function watchAuthorization(req, close, options = {}) {
  const auth = require('../routes/middlewares/auth');
  const token = auth.extractToken(req);
  let stopped = false;
  let checking = false;
  let expiry;
  const stop = () => { stopped = true; clearInterval(interval); clearTimeout(expiry); };
  const deny = () => { if (stopped) return; stop(); close(); };
  const check = async () => {
    if (stopped || checking) return;
    checking = true;
    try { await auth.verifyAccessToken(token); }
    catch { deny(); }
    finally { checking = false; }
  };
  const interval = setInterval(check, options.intervalMs || 15_000);
  interval.unref?.();
  const expiresAt = Number(req.authTokenClaims?.exp) * 1000;
  if (Number.isFinite(expiresAt)) {
    expiry = setTimeout(deny, Math.min(2_147_483_647, Math.max(0, expiresAt - Date.now())));
    expiry.unref?.();
  }
  return stop;
}

module.exports = { watchAuthorization };
