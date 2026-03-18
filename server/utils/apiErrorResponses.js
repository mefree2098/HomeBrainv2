function isApiRequest(req) {
  const path = String(req?.originalUrl || req?.path || '');
  return path.startsWith('/api/');
}

function sendNotFound(req, res) {
  if (isApiRequest(req)) {
    return res.status(404).json({
      success: false,
      message: `API route not found: ${req.method} ${req.path}`
    });
  }

  return res.status(404).send('Page not found.');
}

function sendUnhandledError(err, req, res) {
  const statusCode = Number(err?.status || err?.statusCode) || 500;
  const message = err?.message || 'There was an error serving your request.';

  if (isApiRequest(req)) {
    return res.status(statusCode).json({
      success: false,
      message
    });
  }

  return res.status(statusCode).send('There was an error serving your request.');
}

module.exports = {
  isApiRequest,
  sendNotFound,
  sendUnhandledError,
};
