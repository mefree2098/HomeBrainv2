export const DYNAMIC_DNS_STATUS_FIELDS = [
  'dynamicDnsLastPublicIp', 'dynamicDnsLastCheckedAt', 'dynamicDnsLastUpdatedAt',
  'dynamicDnsLastStatus', 'dynamicDnsLastError',
] as const;

export function applyDynamicDnsStatus(
  settings: Record<string, unknown>,
  apply: (key: typeof DYNAMIC_DNS_STATUS_FIELDS[number], value: string) => void,
) {
  for (const key of DYNAMIC_DNS_STATUS_FIELDS) {
    if (typeof settings[key] === 'string') apply(key, settings[key]);
  }
}
