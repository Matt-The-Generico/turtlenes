/**
 * controller.js
 * Standard NES controller: 8 buttons latched into a shift register,
 * read back one bit per $4016/$4017 read (A, B, Select, Start, Up,
 * Down, Left, Right -- in that order, matching real hardware).
 */

export const BUTTONS = ['A', 'B', 'Select', 'Start', 'Up', 'Down', 'Left', 'Right'];

export class Controller {
  constructor() {
    this.buttonState = 0; // live, updated by keyboard events
    this.shiftReg = 0;
    this.strobe = false;
  }

  setButton(name, pressed) {
    const bit = BUTTONS.indexOf(name);
    if (bit === -1) return;
    if (pressed) this.buttonState |= (1 << bit);
    else this.buttonState &= ~(1 << bit);
  }

  // Writing to $4016 with bit0=1 continuously reloads the shift register
  // from live button state ("strobe" mode); the falling edge (1 -> 0)
  // latches the current state for serial reading.
  write(val) {
    this.strobe = (val & 0x01) !== 0;
    if (this.strobe) this.shiftReg = this.buttonState;
  }

  read() {
    if (this.strobe) {
      // While strobing, every read returns the A button's live state.
      return (this.buttonState & 0x01) | 0x40;
    }
    const bit = this.shiftReg & 0x01;
    this.shiftReg = (this.shiftReg >> 1) | 0x80; // shift in 1s past bit 8 (real hardware behavior)
    return bit | 0x40; // open-bus bits typically read back as 0x40 on real hardware
  }
}
