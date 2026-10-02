// Which button restarts each board, in words a first-time owner can act on.
//
// A USB flash leaves the new firmware written but not running: esptool's
// automatic reset does not take on every board and cable, and nothing on the
// board says it is waiting. Field feedback (2026-10-02): a tester updated over
// USB and did not realise the board needed RESET to start the new firmware.
// Every flash path ends by naming the button, so it is never left to a log line.

/** The instruction that restarts `boardId`, naming the button to press and the
 *  one not to confuse it with. */
export function resetButtonHint(boardId: string | null | undefined): string {
  switch (boardId) {
    case 'heltec-v4':
    case 'heltec-v3':
      return 'Press the small RST button beside the USB socket (not PRG)'
    case 'tdisplay':
      return 'Press the small reset button on the side of the board (not the two front buttons)'
    case 'c6':
      return 'Press the RESET button (not BOOT)'
    default:
      return 'Press the RST or RESET button on the board'
  }
}
