const express = require('express');
const rateLimit = require('express-rate-limit');

const { requireAdmin } = require('./middlewares/auth');
const generalDownloadStorage = require('../services/generalDownloadStorage');

const router = express.Router();
const generalDownloadRateLimit = rateLimit({
  windowMs: Math.max(60_000, Number(process.env.HOMEBRAIN_GENERAL_DOWNLOAD_RATE_LIMIT_WINDOW_MS || 60_000)),
  limit: Math.max(5, Number(process.env.HOMEBRAIN_GENERAL_DOWNLOAD_RATE_LIMIT_MAX || 60)),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many general download requests. Please retry shortly.'
  }
});

router.use(generalDownloadRateLimit, requireAdmin());

router.get('/status', async (_req, res) => {
  try {
    const root = generalDownloadStorage.ensureGeneralDownloadsRoot();
    return res.status(200).json({
      success: true,
      root
    });
  } catch (error) {
    console.error('GET /api/admin/general-downloads/status - Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to inspect general downloads storage'
    });
  }
});

router.get('/file', async (req, res) => {
  try {
    const info = await generalDownloadStorage.getDownloadFileInfo(req.query.path);
    return res.status(200).json({
      success: true,
      file: info
    });
  } catch (error) {
    console.error('GET /api/admin/general-downloads/file - Error:', error.message);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to inspect download file'
    });
  }
});

router.put('/upload', async (req, res) => {
  try {
    const uploaded = await generalDownloadStorage.writeDownloadStream(req.query.path, req, {
      expectedBytes: req.get('content-length')
    });

    return res.status(201).json({
      success: true,
      file: uploaded
    });
  } catch (error) {
    console.error('PUT /api/admin/general-downloads/upload - Error:', error.message);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to upload download file'
    });
  }
});

module.exports = router;
