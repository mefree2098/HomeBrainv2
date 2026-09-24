const mongoose = require('mongoose');

// Images are under 2 MB, so keeping the immutable artifact with its manifest in
// Mongo makes releases survive deployments and participate in normal backups.
const schema = new mongoose.Schema({
  version: { type: String, required: true, unique: true },
  hardwareProfile: { type: String, required: true },
  protocol: { type: Number, required: true },
  size: { type: Number, required: true },
  sha256: { type: String, required: true },
  imageSha256: { type: String, required: true },
  notes: { type: String, default: '' },
  image: { type: Buffer, required: true, select: false },
  createdAt: { type: Date, default: Date.now, immutable: true }
}, { collection: 'sensor_firmware_releases', versionKey: false });

module.exports = mongoose.model('SensorFirmwareRelease', schema);
