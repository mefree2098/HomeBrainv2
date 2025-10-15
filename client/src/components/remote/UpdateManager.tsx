import React, { useState } from 'react';
import { Button } from '../ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '../ui/card';
import { generatePackage, getPackageInfo, initiateUpdate, checkForUpdates } from '../../api/remoteUpdates';

interface Props {
  deviceId: string;
  deviceName?: string;
}

export default function UpdateManager({ deviceId, deviceName }: Props) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pkg, setPkg] = useState<any | null>(null);
  const [status, setStatus] = useState<any | null>(null);

  async function refreshPackage() {
    setBusy(true);
    try {
      const info = await getPackageInfo();
      setPkg(info?.success ? info : null);
      setMessage(info?.success ? `Package v${info.version} is ready` : 'No package');
    } catch (e: any) {
      setMessage(e?.message || 'Failed to fetch package info');
    } finally {
      setBusy(false);
    }
  }

  async function handleGenerate() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await generatePackage();
      if (res?.success) {
        setPkg(res);
        setMessage(`Generated package v${res.version}`);
      } else {
        setMessage(res?.message || 'Failed to generate package');
      }
    } catch (e: any) {
      setMessage(e?.message || 'Failed to generate package');
    } finally {
      setBusy(false);
    }
  }

  async function handleCheck() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await checkForUpdates(deviceId);
      setStatus(res);
      setMessage(res?.updateAvailable ? `Update available: ${res.latestVersion}` : `Up to date (${res.currentVersion})`);
    } catch (e: any) {
      setMessage(e?.message || 'Failed to check for updates');
    } finally {
      setBusy(false);
    }
  }

  async function handlePush() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await initiateUpdate(deviceId);
      setMessage(res?.success ? `Update initiated to v${res.version}` : (res?.message || 'Failed to initiate update'));
    } catch (e: any) {
      setMessage(e?.message || 'Failed to initiate update');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>Remote Update Manager {deviceName ? `- ${deviceName}` : ''}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <Button onClick={refreshPackage} disabled={busy}>Refresh Package Info</Button>
          <Button onClick={handleGenerate} disabled={busy}>Generate Package</Button>
          <Button onClick={handleCheck} disabled={busy}>Check Device</Button>
          <Button onClick={handlePush} disabled={busy || !deviceId}>Push Update</Button>
        </div>
        {message && <div className="text-sm text-muted-foreground">{message}</div>}
        {pkg && (
          <div className="text-sm">
            Package: v{pkg.version}, size: {pkg.size} bytes
          </div>
        )}
        {status && (
          <div className="text-sm">
            Device: {deviceName || deviceId} — Current: {status.currentVersion}, Latest: {status.latestVersion}
          </div>
        )}
      </CardContent>
      <CardFooter>
        <div className="text-xs text-muted-foreground">Use this panel to build and push OTA updates to the remote device.</div>
      </CardFooter>
    </Card>
  );
}
