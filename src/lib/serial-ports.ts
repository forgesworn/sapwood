// Web Serial port hygiene.
//
// A previous flash or connect — or an ESP32-S3 native-USB re-enumeration when
// esptool resets the chip — can leave a granted port OPEN and locked in this
// tab. The next open() then fails with "Failed to open serial port" ("port in
// use") until the device is physically unplugged. Proactively closing any open
// granted ports before opening a new one breaks that lock without a replug.

/**
 * A previously-granted port whose device is physically attached right now, or
 * null. Uses `SerialPort.connected` (Chrome 117+); we only trust an explicit
 * `true` — older browsers without the property simply report nothing attached,
 * and the user still has the explicit "Connect by USB cable" button.
 */
export async function findAttachedGrantedPort(): Promise<SerialPort | null> {
  if (typeof navigator === 'undefined' || !('serial' in navigator)) return null
  try {
    const ports = await navigator.serial.getPorts()
    return ports.find((p) => (p as SerialPort & { connected?: boolean }).connected === true) ?? null
  } catch {
    return null
  }
}

/** Close every already-open Web Serial port this tab has been granted. */
export async function releaseGrantedPorts(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serial' in navigator)) return
  try {
    const ports = await navigator.serial.getPorts()
    await Promise.all(
      ports.map(async (p) => {
        // A closed port has null readable/writable; only close open ones.
        if (p.readable || p.writable) {
          try {
            await p.close()
          } catch {
            /* already closed, or a stale handle from a re-enumerated device */
          }
        }
      }),
    )
  } catch {
    /* getPorts unsupported, or no granted ports — nothing to release */
  }
}
