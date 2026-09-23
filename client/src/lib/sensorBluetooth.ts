export const SENSOR_BLE_UUIDS = {
  service: '9c2f0001-7d1b-4a2f-9d3b-0f91e6a3b805', info: '9c2f0002-7d1b-4a2f-9d3b-0f91e6a3b805',
  command: '9c2f0003-7d1b-4a2f-9d3b-0f91e6a3b805', response: '9c2f0004-7d1b-4a2f-9d3b-0f91e6a3b805'
}
export type SensorIdentity = { protocol: number; hardwareId: string; firmwareVersion: string; profile: 'air-station' | 'presence' | 'climate' | 'auto'; configured: boolean; nodeId?: string }
export type SensorNetwork = { ssid: string; rssi: number; secure: boolean }
interface Characteristic { readValue(): Promise<DataView>; writeValueWithResponse(value: Uint8Array): Promise<void> }
interface Service { getCharacteristic(uuid: string): Promise<Characteristic> }
interface Gatt { connected: boolean; connect(): Promise<Gatt>; disconnect(): void; getPrimaryService(uuid: string): Promise<Service> }
interface BluetoothDevice { gatt?: Gatt }
interface Bluetooth { requestDevice(options: { filters: Array<{ services: string[] }> }): Promise<BluetoothDevice> }
type Reply = { id: number; state: string; error?: string; networks?: SensorNetwork[]; next?: number }
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
export function sensorBluetoothAvailable() { return typeof navigator !== 'undefined' && window.isSecureContext && 'bluetooth' in navigator }
export function encodeSensorCommand(value: Record<string, unknown>): Uint8Array[] {
  const bytes = new TextEncoder().encode(JSON.stringify(value) + '\n')
  if (bytes.length > 1537) throw new Error('Setup request is too long.')
  return Array.from({ length: Math.ceil(bytes.length / 20) }, (_, i) => bytes.slice(i * 20, i * 20 + 20))
}
function decode<T>(value: DataView): T {
  return JSON.parse(new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))) as T
}
export class SensorBluetooth {
  private id = 0
  private constructor(private gatt: Gatt, private tx: Characteristic, private rx: Characteristic, readonly identity: SensorIdentity) {}
  static async discover(): Promise<SensorBluetooth> {
    if (!sensorBluetoothAvailable()) throw new Error('Use desktop Chrome or Edge over HTTPS, or the HomeBrain iOS app. This browser does not expose Bluetooth.')
    const bluetooth = (navigator as Navigator & { bluetooth: Bluetooth }).bluetooth
    // Must remain directly inside the Add Sensor user gesture, before API work.
    const device = await bluetooth.requestDevice({ filters: [{ services: [SENSOR_BLE_UUIDS.service] }] })
    if (!device.gatt) throw new Error('This sensor does not expose Bluetooth setup.')
    const gatt = await device.gatt.connect()
    try {
      const service = await gatt.getPrimaryService(SENSOR_BLE_UUIDS.service)
      const info = await service.getCharacteristic(SENSOR_BLE_UUIDS.info)
      const identity = decode<SensorIdentity>(await info.readValue())
      if (identity.protocol !== 1 || !/^XIAO-C6-[A-Fa-f0-9]{12}$/.test(identity.hardwareId)) throw new Error('Unsupported HomeBrain sensor firmware.')
      const tx = await service.getCharacteristic(SENSOR_BLE_UUIDS.command)
      const rx = await service.getCharacteristic(SENSOR_BLE_UUIDS.response)
      await rx.readValue() // Encrypted read triggers OS pairing before credentials are sent.
      return new SensorBluetooth(gatt, tx, rx, identity)
    } catch (error) { gatt.disconnect(); throw error }
  }
  disconnect() { this.gatt.disconnect() }
  async command(op: string, fields: Record<string, unknown> = {}, onState?: (state: string) => void): Promise<Reply> {
    const id = ++this.id
    for (const chunk of encodeSensorCommand({ ...fields, id, op })) await this.tx.writeValueWithResponse(chunk)
    const deadline = Date.now() + 90000
    while (Date.now() < deadline) {
      const response = decode<Reply>(await this.rx.readValue())
      if (response.id === id) {
        if (response.state === 'error') throw new Error(response.error || 'Sensor setup failed.')
        onState?.(response.state)
        if (['complete', 'scanned', 'networks', 'cancelled'].includes(response.state)) return response
      }
      await pause(250)
    }
    throw new Error('Sensor setup timed out. Reconnect and try again; existing registration is preserved.')
  }
  async scan(): Promise<SensorNetwork[]> {
    await this.command('scan')
    const found = new Map<string, SensorNetwork>()
    let offset = 0
    for (let page = 0; page < 100; page++) {
      const response = await this.command('networks', { offset })
      for (const network of response.networks || []) {
        if (network.ssid && (!found.has(network.ssid) || found.get(network.ssid)!.rssi < network.rssi)) found.set(network.ssid, network)
      }
      if (response.next === undefined || response.next < 0) break
      if (response.next <= offset) throw new Error('Invalid Wi-Fi scan response.')
      offset = response.next
    }
    return [...found.values()].sort((a, b) => b.rssi - a.rssi)
  }
}
