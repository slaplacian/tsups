// Megatec / Voltronic "Q1" serial protocol, as used by TS Shara UPS units.

export const BAUD_RATE = 2400;

// Exact byte sequences sent to the UPS.
export const CMD = {
  identify: 'I\r\n',
  status: 'Q1\r\n',
  rating: 'F\r',
  quickTest: 'T\r', // 10-second battery test
  lowTest: 'TL\r', // test until battery low
  toggleBeep: 'Q\r',
  // Other standard Megatec commands.
  cancelShutdown: 'C\r',
  cancelTest: 'CT\r',
};

// Bit order of the 8-char status field in a Q1 reply (b7..b0, left to right).
export const STATUS_BITS = [
  'utilityFail',
  'batteryLow',
  'bypass',
  'upsFailed',
  'standby',
  'testInProgress',
  'shutdownActive',
  'beeperOn',
];

const toNum = (s) => {
  const n = parseFloat(s);
  return Number.isNaN(n) ? 0 : n;
};

const stripPrefix = (line) => line.trim().replace(/^[#(]/, '').trim();

// Lead-acid resting voltage -> state-of-charge lookup for 12 V and 24 V banks.
const SOC_POINTS = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 0];
const SOC_VOLTS = {
  12: [12.2, 12.09, 11.98, 11.87, 11.76, 11.64, 11.53, 11.42, 11.31, 10.91, 10.5],
  24: [24.4, 24.18, 23.96, 23.74, 23.52, 23.28, 23.06, 22.84, 22.62, 21.82, 21.0],
};

export function calcSOC(volts, nominal) {
  const table = SOC_VOLTS[nominal === 24 ? 24 : 12];
  if (volts > table[0]) return 100;
  if (volts <= table[table.length - 1]) return 0;
  for (let i = 0; i < table.length - 1; i++) {
    if (volts <= table[i] && volts > table[i + 1]) {
      const slope = (SOC_POINTS[i] - SOC_POINTS[i + 1]) / (table[i] - table[i + 1]);
      return Math.round(Math.max(0, Math.min(100, SOC_POINTS[i] - slope * (table[i] - volts))));
    }
  }
  return 0;
}

// Without a rating reply, guess the bank voltage from the live reading (> 18 V => 24 V).
export function nominalBatteryVoltage(batteryVolts, rating) {
  if (rating?.batteryVoltage) {
    const n = Math.round(rating.batteryVoltage / 12) * 12;
    if (n === 12 || n === 24) return n;
  }
  return batteryVolts > 18 ? 24 : 12;
}

export function decodeStatus(bits) {
  const out = {};
  STATUS_BITS.forEach((name, i) => {
    out[name] = bits[i] === '1';
  });
  return out;
}

// "(127.0 127.0 127.0 000 60.0 13.5 30.0 00000001" -> reading object, or null.
export function parseQ1(line, rating) {
  const parts = stripPrefix(line).split(/\s+/);
  if (parts.length < 8) return null;
  const [input, inputFault, output, load, freq, battery, temp, status] = parts;
  if (!/^[01]{8}$/.test(status)) return null;
  const batteryVoltage = toNum(battery);
  const nominal = nominalBatteryVoltage(batteryVoltage, rating);
  return {
    inputVoltage: toNum(input),
    inputFaultVoltage: toNum(inputFault),
    outputVoltage: toNum(output),
    loadPercent: toNum(load),
    frequency: toNum(freq),
    batteryVoltage,
    batteryNominal: nominal,
    batterySOC: calcSOC(batteryVoltage, nominal),
    temperature: toNum(temp),
    status,
    flags: decodeStatus(status),
  };
}

export const isQ1Reply = (line) => line.trim().startsWith('(') && parseQ1(line) !== null;

// "#Univ. 100 24.00 60.0": four fields, the last two numeric.
export const isRatingReply = (line) => {
  if (!line.trim().startsWith('#')) return false;
  const parts = stripPrefix(line).split(/\s+/);
  return parts.length === 4 && parts.slice(2).every((p) => /^\d+(\.\d+)?$/.test(p));
};

export const isInfoReply = (line) => line.trim().startsWith('#') && !isRatingReply(line);

// "#220.0 000 024.0 50.0" -> rated voltage, current, battery voltage, frequency.
// TS Shara bivolt units report the voltage as "Univ." (universal input).
export function parseRating(line) {
  if (!isRatingReply(line)) return null;
  const [voltage, current, batteryVoltage, frequency] = stripPrefix(line).split(/\s+/);
  return {
    voltage: Number.isNaN(parseFloat(voltage)) ? voltage : toNum(voltage),
    current: toNum(current),
    batteryVoltage: toNum(batteryVoltage),
    frequency: toNum(frequency),
    raw: line.trim(),
  };
}

// "#TS -222  250514 Senoid  15 V010207057": Megatec fixed columns of
// 15/10/10 chars separated by single spaces.
export function parseInfo(line) {
  const body = line.trim().replace(/^#/, '');
  return {
    company: body.slice(0, 15).trim(),
    model: body.slice(16, 26).trim(),
    version: body.slice(27, 37).trim(),
    raw: line.trim(),
  };
}

// Events emitted when a status bit flips.
const EVENT_DEFS = {
  utilityFail: [
    { code: 'UTILITY_RESTORED', message: 'Utility power restored', severity: 'success' },
    { code: 'UTILITY_FAIL', message: 'Utility power failure, running on battery', severity: 'warning' },
  ],
  batteryLow: [
    { code: 'OK_BATTERY', message: 'Battery OK', severity: 'info' },
    { code: 'LOW_BATTERY', message: 'Battery low', severity: 'critical' },
  ],
  bypass: [
    { code: 'BYPASS_DISABLED', message: 'Bypass inactive', severity: 'info' },
    { code: 'BYPASS_ENABLED', message: 'Bypass active', severity: 'info' },
  ],
  upsFailed: [
    { code: 'UPS_FAULT_CLEARED', message: 'UPS fault cleared', severity: 'success' },
    { code: 'UPS_FAULT', message: 'UPS reports internal fault', severity: 'critical' },
  ],
  testInProgress: [
    { code: 'BATTERY_TEST_FINISHED', message: 'Battery test finished', severity: 'success' },
    { code: 'BATTERY_TEST_STARTED', message: 'Battery test started', severity: 'success' },
  ],
  // Per the Megatec spec, bit 6 = 1 means a shutdown countdown is active.
  shutdownActive: [
    { code: 'SHUTDOWN_CANCELLED', message: 'UPS shutdown inactive', severity: 'info' },
    { code: 'SHUTDOWN_PENDING', message: 'UPS shutdown countdown active', severity: 'warning' },
  ],
  beeperOn: [
    { code: 'BEEP_DISABLED', message: 'Beeper disabled', severity: 'info' },
    { code: 'BEEP_ENABLED', message: 'Beeper enabled', severity: 'info' },
  ],
};

export function diffStatus(current, previous) {
  if (!previous) return [];
  const events = [];
  STATUS_BITS.forEach((name, i) => {
    const defs = EVENT_DEFS[name];
    if (!defs || current[i] === previous[i]) return;
    events.push({ ...defs[current[i] === '1' ? 1 : 0], bit: name });
  });
  return events;
}

// T<nn>: battery test for nn minutes (01..99).
export function testCommand(minutes) {
  const n = Number(minutes);
  if (!Number.isInteger(n) || n < 1 || n > 99) {
    throw new Error('test minutes must be an integer from 1 to 99');
  }
  return `T${String(n).padStart(2, '0')}\r`;
}

// S<n>: shut UPS output down after n minutes; .2-.9 or 01-10 per Megatec spec.
export function shutdownCommand(minutes) {
  const n = Number(minutes);
  if (n >= 0.2 && n < 1 && Math.round(n * 10) === n * 10) {
    return `S.${Math.round(n * 10)}\r`;
  }
  if (Number.isInteger(n) && n >= 1 && n <= 10) {
    return `S${String(n).padStart(2, '0')}\r`;
  }
  throw new Error('shutdown delay must be 0.2-0.9 or an integer 1-10 (minutes)');
}
