// Web Serial port hygiene.
//
// A previous flash or connect — or an ESP32-S3 native-USB re-enumeration when
// esptool resets the chip — can leave a granted port OPEN and locked in this
// tab. The next open() then fails with "Failed to open serial port" ("port in
// use") until the device is physically unplugged. Proactively closing any open
// granted ports before opening a new one breaks that lock without a replug.

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
