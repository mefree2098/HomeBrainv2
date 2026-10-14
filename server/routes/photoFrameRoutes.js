const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { requireAdmin } = require('./middlewares/auth');
const service = require('../services/photoFrameService');
const updates = require('../services/photoFrameUpdateService');
const router = express.Router();
const admin = requireAdmin();
const readOnlyPreview = requireAdmin({ allowReadOnlyMutation: true });
const limited = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false });

const wrap = (handler) => async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  try { await handler(req, res); } catch (error) {
    const conflict = error.name === 'VersionError';
    res.status(conflict ? 409 : (error.status || 500)).json({ success: false, message: conflict ? 'The frame changed while saving. Reload and retry.' : error.message });
  }
};

router.use('/player', express.static(path.join(__dirname, '../assets/photo-frame-player'), {
  maxAge: 0, setHeaders(res) { res.setHeader('Referrer-Policy', 'no-referrer'); }
}));
router.get('/catalog', admin, wrap(async (_req, res) => res.json({ success: true, ...service.catalog })));
router.get('/', admin, wrap(async (_req, res) => res.json({ success: true, frames: await service.list() })));
router.post('/', admin, wrap(async (req, res) => res.status(201).json({ success: true, frame: await service.create(req.body || {}) })));
router.post('/preview', readOnlyPreview, wrap(async (req, res) => res.json({ success: true, ...await service.preview(req.body?.config) })));
router.get('/releases', admin, wrap(async (_req, res) => res.json({ success: true, releases: await updates.listReleases() })));
router.post('/releases', admin, limited, express.raw({ type: 'application/vnd.android.package-archive', limit: updates.MAX_BYTES }), wrap(async (req, res) => {
  const release = await updates.publish(req.body, { versionName: req.get('X-Frame-Version-Name'), versionCode: req.get('X-Frame-Version-Code') });
  res.status(201).json({ success: true, release });
}));
router.post('/:frameId/updates', admin, wrap(async (req, res) => res.json({ success: true, job: await updates.queue(await service.getFrame(req.params.frameId), req.body?.releaseId) })));
router.delete('/:frameId/updates', admin, wrap(async (req, res) => { await updates.cancel(await service.getFrame(req.params.frameId)); res.json({ success: true }); }));
router.put('/:frameId', admin, wrap(async (req, res) => res.json({ success: true, frame: await service.update(req.params.frameId, req.body || {}) })));
router.post('/:frameId/pair', admin, limited, wrap(async (req, res) => res.json({ success: true, ...await service.pair(req.params.frameId) })));
router.post('/:frameId/photos', admin, limited, wrap(async (req, res) => res.status(201).json({ success: true, frame: await service.upload(req.params.frameId, req.body || {}) })));
router.put('/:frameId/photo-order', admin, wrap(async (req, res) => res.json({ success: true, frame: await service.reorder(req.params.frameId, req.body?.ids) })));
router.delete('/:frameId/photos/:photoId', admin, wrap(async (req, res) => res.json({ success: true, frame: await service.removePhoto(req.params.frameId, req.params.photoId) })));
router.get('/:frameId/manifest', admin, wrap(async (req, res) => res.json({ success: true, manifest: await service.manifest(await service.getFrame(req.params.frameId)) })));
router.get('/:frameId/photos/:photoId', admin, wrap(async (req, res) => {
  const { file, photo } = await service.readPhoto(await service.getFrame(req.params.frameId), req.params.photoId);
  res.type(photo.contentType).sendFile(file);
}));

// Frame credentials authorize only this frame's display and assigned updates.
// They are independent of user sessions and cannot control any home device.
router.get('/:frameId/device/manifest', limited, wrap(async (req, res) => {
  const frame = await service.authenticate(req.params.frameId, req.get('X-HomeBrain-Frame-Token'));
  res.json({ success: true, manifest: await service.manifest(frame, true) });
}));
router.get('/:frameId/device/photos/:photoId', limited, wrap(async (req, res) => {
  const frame = await service.authenticate(req.params.frameId, req.get('X-HomeBrain-Frame-Token'));
  const { file, photo } = await service.readPhoto(frame, req.params.photoId);
  res.type(photo.contentType).sendFile(file);
}));
router.get('/:frameId/device/updates', limited, wrap(async (req, res) => {
  const frame = await service.authenticate(req.params.frameId, req.get('X-HomeBrain-Frame-Token'));
  res.json({ success: true, ...await updates.poll(frame) });
}));
router.post('/:frameId/device/updates/report', limited, wrap(async (req, res) => {
  const frame = await service.authenticate(req.params.frameId, req.get('X-HomeBrain-Frame-Token'));
  await updates.report(frame, req.body || {}); res.json({ success: true });
}));
router.get('/:frameId/device/updates/:jobId/apk', limited, wrap(async (req, res) => {
  const frame = await service.authenticate(req.params.frameId, req.get('X-HomeBrain-Frame-Token'));
  res.type('application/vnd.android.package-archive').sendFile(await updates.download(frame, req.params.jobId));
}));

module.exports = router;
