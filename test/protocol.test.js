import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calcSOC,
  parseQ1,
  parseRating,
  parseInfo,
  isQ1Reply,
  isRatingReply,
  isInfoReply,
  diffStatus,
  testCommand,
  shutdownCommand,
} from '../src/protocol.js';

test('parseQ1 reads a typical Q1 reply', () => {
  const s = parseQ1('(127.0 127.0 127.0 000 60.0 13.5 30.0 00000001');
  assert.equal(s.inputVoltage, 127);
  assert.equal(s.outputVoltage, 127);
  assert.equal(s.frequency, 60);
  assert.equal(s.batteryVoltage, 13.5);
  assert.equal(s.batteryNominal, 12);
  assert.equal(s.batterySOC, 100);
  assert.equal(s.temperature, 30);
  assert.equal(s.flags.beeperOn, true);
  assert.equal(s.flags.utilityFail, false);
});

test('parseQ1 rejects short or garbled replies', () => {
  assert.equal(parseQ1('(127.0 127.0'), null);
  assert.equal(parseQ1('(127.0 127.0 127.0 000 60.0 13.5 30.0 NAK'), null);
});

test('parseQ1 picks 24 V nominal above 18 V', () => {
  assert.equal(parseQ1('(220 220 220 010 60 23.5 30 00000000').batteryNominal, 24);
});

test('calcSOC follows the lookup table', () => {
  assert.equal(calcSOC(12.3, 12), 100);
  assert.equal(calcSOC(10.4, 12), 0);
  assert.equal(calcSOC(11.64, 12), 50);
  assert.equal(calcSOC(23.52, 24), 60);
});

test('parseRating reads a numeric rating', () => {
  assert.deepEqual(
    { ...parseRating('#127.0 004 12.00 60.0'), raw: undefined },
    { voltage: 127, current: 4, batteryVoltage: 12, frequency: 60, raw: undefined },
  );
});

test('diffStatus emits events on bit transitions', () => {
  assert.deepEqual(diffStatus('00000001', null), []);
  const codes = diffStatus('11000001', '00000001').map((e) => e.code);
  assert.deepEqual(codes, ['UTILITY_FAIL', 'LOW_BATTERY']);
  assert.deepEqual(diffStatus('00000000', '10000001').map((e) => e.code), ['UTILITY_RESTORED', 'BEEP_DISABLED']);
});

test('command formatting', () => {
  assert.equal(testCommand(5), 'T05\r');
  assert.throws(() => testCommand(0));
  assert.equal(shutdownCommand(3), 'S03\r');
  assert.equal(shutdownCommand('0.5'), 'S.5\r');
  assert.throws(() => shutdownCommand(11));
  assert.throws(() => shutdownCommand(0.1));
});

// Replies captured from a real TS Shara unit (USB 0483:5740) on 2026-10-12.
const REAL_I = '#TS -222  250514 Senoid  15 V010207057';
const REAL_F = '#Univ. 100 24.00 60.0';
const REAL_Q1 = '(221.0 221.0 112.0 011 60.0 27.2 26.0 00001001';

test('real replies are classified correctly', () => {
  assert.equal(isInfoReply(REAL_I), true);
  assert.equal(isRatingReply(REAL_I), false);
  assert.equal(isRatingReply(REAL_F), true);
  assert.equal(isInfoReply(REAL_F), false);
  assert.equal(isQ1Reply(REAL_F), false);
  assert.equal(isQ1Reply(REAL_Q1), true);
});

test('real F reply sets a 24 V bank', () => {
  const rating = parseRating(REAL_F);
  assert.equal(rating.voltage, 'Univ.');
  assert.equal(rating.batteryVoltage, 24);
  const s = parseQ1(REAL_Q1, rating);
  assert.equal(s.batteryNominal, 24);
  assert.equal(s.outputVoltage, 112);
  assert.equal(s.loadPercent, 11);
  assert.equal(s.flags.standby, true);
  assert.equal(s.flags.beeperOn, true);
});

test('real I reply splits into Megatec columns', () => {
  const info = parseInfo(REAL_I);
  assert.equal(info.company, 'TS -222  250514');
  assert.equal(info.model, 'Senoid  15');
  assert.equal(info.version, 'V010207057');
});
