import api from './api';

export async function getPackageInfo() {
  const res = await api.get('/api/remote-updates/package-info');
  return res.data;
}

export async function generatePackage() {
  const res = await api.post('/api/remote-updates/generate-package');
  return res.data;
}

export async function initiateUpdate(deviceId: string) {
  const res = await api.post(`/api/remote-updates/initiate/${deviceId}`);
  return res.data;
}

export async function checkForUpdates(deviceId: string) {
  const res = await api.get(`/api/remote-updates/check/${deviceId}`);
  return res.data;
}

export async function getUpdateStats() {
  const res = await api.get('/api/remote-updates/statistics');
  return res.data;
}
