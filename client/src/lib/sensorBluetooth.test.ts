import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeSensorCommand, SensorBluetooth, SENSOR_BLE_UUIDS, sensorBluetoothAvailable } from './sensorBluetooth'

afterEach(() => vi.unstubAllGlobals())
const view = (value: unknown) => new DataView(new TextEncoder().encode(JSON.stringify(value)).buffer)

function mockBluetooth(identity = { protocol: 1, hardwareId: 'XIAO-C6-001122AABBCC', configured: false, profile: 'presence' }) {
  const requests: Record<string, unknown>[] = []
  let buffer: number[] = [], response: unknown = { id: 0, state: 'ready' }
  const rx = { readValue: vi.fn(async () => view(response)) }
  const tx = { writeValueWithResponse: vi.fn(async (value: Uint8Array) => {
    buffer.push(...value)
    if (buffer[buffer.length - 1] !== 10) return
    const request = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer)))
    requests.push(request); buffer = []
    if (request.op === 'scan') response = { id: request.id, state: 'scanned' }
    else if (request.op === 'networks') response = { id: request.id, state: 'networks', next: request.offset === 0 ? 2 : -1,
      networks: request.offset === 0 ? [{ ssid: 'IoT', rssi: -70, secure: true }, { ssid: 'Guest', rssi: -50, secure: false }]
        : [{ ssid: 'IoT', rssi: -40, secure: true }] }
    else response = { id: request.id, state: 'error', error: 'Network unavailable. Retry.' }
  }) }
  const getCharacteristic = vi.fn(async (uuid: string) => uuid === SENSOR_BLE_UUIDS.info ? { readValue: async () => view(identity) } : uuid === SENSOR_BLE_UUIDS.command ? tx : rx)
  const gatt = { connected: true, disconnect: vi.fn(), connect: vi.fn(), getPrimaryService: vi.fn(async () => ({ getCharacteristic })) }
  gatt.connect.mockResolvedValue(gatt)
  const requestDevice = vi.fn(async () => ({ gatt }))
  vi.stubGlobal('window', { isSecureContext: true })
  vi.stubGlobal('navigator', { bluetooth: { requestDevice } })
  return { requests, rx, tx, gatt, requestDevice }
}

describe('Bluetooth onboarding transport', () => {
  it('frames Unicode credentials as bounded 20-byte chunks without corrupting UTF-8', () => {
    const input = { id: 7, op: 'configure', ssid: 'Café 家', password: 'test-only-🔑-password' }
    const chunks = encodeSensorCommand(input)
    expect(chunks.every(chunk => chunk.length <= 20)).toBe(true)
    const bytes = new Uint8Array(chunks.flatMap(chunk => Array.from(chunk)))
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(input)
    expect(bytes[bytes.length - 1]).toBe(10)
    expect(() => encodeSensorCommand({ password: 'x'.repeat(2000) })).toThrow('too long')
  })
  it('discovers only the setup service and reads the encrypted response before any configuration', async () => {
    const mock = mockBluetooth()
    const device = await SensorBluetooth.discover()
    expect(mock.requestDevice).toHaveBeenCalledWith({ filters: [{ services: [SENSOR_BLE_UUIDS.service] }] })
    expect(mock.rx.readValue).toHaveBeenCalledOnce()
    expect(mock.tx.writeValueWithResponse).not.toHaveBeenCalled()
    expect(device.identity.profile).toBe('presence')
    const networks = await device.scan()
    expect(networks.map(network => network.ssid)).toEqual(['IoT', 'Guest'])
    expect(networks[0].rssi).toBe(-40)
    expect(mock.requests.map(request => request.op)).toEqual(['scan', 'networks', 'networks'])
    await expect(device.command('configure', { password: 'test-only' })).rejects.toThrow('Network unavailable')
    device.disconnect()
    expect(mock.gatt.disconnect).toHaveBeenCalled()
  })
  it('disconnects incompatible firmware instead of sending credentials', async () => {
    const mock = mockBluetooth({ protocol: 2, hardwareId: 'XIAO-C6-001122AABBCC', configured: false, profile: 'climate' })
    await expect(SensorBluetooth.discover()).rejects.toThrow('Unsupported')
    expect(mock.gatt.disconnect).toHaveBeenCalled()
    expect(mock.requests).toHaveLength(0)
  })
  it('does not offer unsupported or insecure browser access', () => {
    vi.stubGlobal('window', { isSecureContext: false }); vi.stubGlobal('navigator', { bluetooth: {} })
    expect(sensorBluetoothAvailable()).toBe(false)
    vi.stubGlobal('window', { isSecureContext: true }); vi.stubGlobal('navigator', {})
    expect(sensorBluetoothAvailable()).toBe(false)
  })
})
