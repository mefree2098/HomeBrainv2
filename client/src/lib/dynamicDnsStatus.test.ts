import { describe, expect, it } from 'vitest';
import { applyDynamicDnsStatus } from './dynamicDnsStatus';

describe('maintenance status refresh', () => {
  it('updates DNS telemetry while preserving unsaved settings and credentials', () => {
    const form: Record<string, string> = { dynamicDnsPrimaryHostname: 'unsaved.example.test', dynamicDnsAzureClientSecret: 'unsaved-secret' };
    applyDynamicDnsStatus({ dynamicDnsPrimaryHostname: 'saved.example.test', dynamicDnsAzureClientSecret: '', dynamicDnsLastStatus: 'success', dynamicDnsLastError: '', dynamicDnsLastPublicIp: null }, (key, value) => { form[key] = value; });
    expect(form).toEqual({ dynamicDnsPrimaryHostname: 'unsaved.example.test', dynamicDnsAzureClientSecret: 'unsaved-secret', dynamicDnsLastStatus: 'success', dynamicDnsLastError: '' });
  });
});
