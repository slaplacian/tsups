#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import {
  CMD,
  parseQ1,
  parseRating,
  parseInfo,
  isQ1Reply,
  isRatingReply,
  isInfoReply,
  diffStatus,
  testCommand,
  shutdownCommand,
} from './protocol.js';
import { UpsConnection, detectPort, listPorts } from './serial.js';
import { parseCli, exitOnClosedPipe } from './args.js';

const HELP = `tsups - TS Shara UPS monitor (Megatec Q1 protocol, 2400 baud)

Usage: tsups <command> [options]

Commands:
  ports                   List serial ports
  detect                  Probe ports for a TS UPS (sends "I", expects "TS")
  info                    Show identification (I) and rating (F) replies
  status                  Read one Q1 status sample
  monitor                 Poll continuously and report events
  test [quick|low|<min>]  Battery test: 10 s (default), until low, or N minutes
  cancel-test             Cancel a running battery test
  beep                    Toggle the UPS beeper
  shutdown <min> --yes    Turn UPS output OFF after <min> (0.2-0.9 or 1-10)
  cancel-shutdown         Cancel a pending shutdown
  raw <cmd>               Send a raw command (CR appended) and print the reply

Options:
  -p, --port <path>       Serial port (default: auto-detect)
  -j, --json              Machine-readable JSON output
  -i, --interval <sec>    Monitor poll interval (default 2)
      --events-only       Monitor: print events only, not every sample
      --log <file>        Monitor: append samples and events as JSON lines
      --on-event <cmd>    Monitor: run a shell command on each event; gets
                          UPS_EVENT, UPS_MESSAGE, UPS_SEVERITY, UPS_JSON env vars
      --shutdown-on-fail <min>  Monitor: send S<min> to the UPS on utility failure
      --shutdown-on-low <min>   Monitor: send S<min> to the UPS on low battery
      --match <text>      Detect: identification substring (default "TS")
  -y, --yes               Confirm commands that cut power
  -v, --verbose           Print probe details
  -h, --help              Show this help
`;

const { values: opt, positionals } = parseCli({
  allowPositionals: true,
  options: {
    port: { type: 'string', short: 'p' },
    json: { type: 'boolean', short: 'j' },
    interval: { type: 'string', short: 'i', default: '2' },
    'events-only': { type: 'boolean' },
    log: { type: 'string' },
    'on-event': { type: 'string' },
    'shutdown-on-fail': { type: 'string' },
    'shutdown-on-low': { type: 'string' },
    match: { type: 'string', default: 'TS' },
    yes: { type: 'boolean', short: 'y' },
    verbose: { type: 'boolean', short: 'v' },
    help: { type: 'boolean', short: 'h' },
  },
}, 'tsups');

exitOnClosedPipe();

const [command, ...args] = positionals;
const verbose = (msg) => opt.verbose && console.error(`[probe] ${msg}`);
const trace = (msg) => opt.verbose && console.error(`[serial] ${msg}`);
const out = (human, data) => console.log(opt.json ? JSON.stringify(data) : human);

async function resolvePort() {
  if (opt.port) return opt.port;
  const found = await detectPort({ match: opt.match, log: verbose });
  if (!found) throw new Error('no UPS found; check the USB cable or pass --port');
  verbose(`using ${found.path}`);
  return found.path;
}

async function withConnection(fn) {
  const conn = new UpsConnection(await resolvePort(), { trace });
  await conn.open();
  try {
    return await fn(conn);
  } finally {
    await conn.close();
  }
}

async function readRating(conn) {
  try {
    return parseRating(await conn.query(CMD.rating, { accept: isRatingReply }));
  } catch {
    return null;
  }
}

function formatSample(s) {
  const f = s.flags;
  const mode = f.utilityFail ? 'ON BATTERY' : 'ONLINE';
  const extras = [
    f.batteryLow && 'BATTERY LOW',
    f.bypass && 'BYPASS',
    f.upsFailed && 'FAULT',
    f.testInProgress && 'TESTING',
    f.shutdownActive && 'SHUTDOWN PENDING',
  ].filter(Boolean);
  return (
    `${mode}${extras.length ? ' [' + extras.join(', ') + ']' : ''}  ` +
    `in ${s.inputVoltage}V  out ${s.outputVoltage}V  load ${s.loadPercent}%  ` +
    `${s.frequency}Hz  batt ${s.batteryVoltage}V (${s.batterySOC}%)  ` +
    `${s.temperature}°C  beep ${f.beeperOn ? 'on' : 'off'}`
  );
}

const commands = {
  async ports() {
    const ports = await listPorts();
    out(
      ports.map((p) => `${p.path}\t${p.manufacturer ?? ''}\t${p.vendorId ?? ''}:${p.productId ?? ''}`).join('\n') ||
        'no serial ports found',
      ports,
    );
  },

  async detect() {
    const found = await detectPort({ match: opt.match, log: verbose });
    if (!found) {
      out('no UPS found', { found: false });
      process.exitCode = 1;
      return;
    }
    out(`${found.path}\t${found.info}`, { found: true, ...found });
  },

  async info() {
    await withConnection(async (conn) => {
      const info = parseInfo(await conn.query(CMD.identify, { accept: isInfoReply }));
      const rating = await readRating(conn);
      out(
        `Company: ${info.company}\nModel:   ${info.model}\nVersion: ${info.version}\nRaw:     ${info.raw}\n` +
          (rating
            ? `Rating:  ${typeof rating.voltage === 'number' ? rating.voltage + 'V' : rating.voltage} ${rating.current}A, battery ${rating.batteryVoltage}V, ${rating.frequency}Hz`
            : 'Rating:  (no reply to F)'),
        { port: conn.path, info, rating },
      );
    });
  },

  async status() {
    await withConnection(async (conn) => {
      const rating = await readRating(conn);
      const line = await conn.query(CMD.status, { accept: isQ1Reply });
      const sample = parseQ1(line, rating);
      if (!sample) throw new Error(`unrecognised Q1 reply: ${JSON.stringify(line)}`);
      out(formatSample(sample), { port: conn.path, ts: Date.now(), ...sample });
    });
  },

  async test() {
    const kind = args[0] ?? 'quick';
    const cmd = kind === 'quick' ? CMD.quickTest : kind === 'low' ? CMD.lowTest : testCommand(kind);
    await withConnection((conn) => conn.send(cmd));
    out(`sent ${JSON.stringify(cmd)}`, { sent: cmd });
  },

  async 'cancel-test'() {
    await withConnection((conn) => conn.send(CMD.cancelTest));
    out('battery test cancelled', { sent: CMD.cancelTest });
  },

  async beep() {
    await withConnection((conn) => conn.send(CMD.toggleBeep));
    out('beeper toggled', { sent: CMD.toggleBeep });
  },

  async shutdown() {
    if (args[0] === undefined) throw new Error('usage: tsups shutdown <minutes> --yes');
    const cmd = shutdownCommand(args[0]);
    if (!opt.yes) throw new Error(`this turns UPS output OFF after ${args[0]} min; re-run with --yes`);
    await withConnection((conn) => conn.send(cmd));
    out(`sent ${JSON.stringify(cmd)}; cancel with "tsups cancel-shutdown"`, { sent: cmd });
  },

  async 'cancel-shutdown'() {
    await withConnection((conn) => conn.send(CMD.cancelShutdown));
    out('shutdown cancelled', { sent: CMD.cancelShutdown });
  },

  async raw() {
    if (!args[0]) throw new Error('usage: tsups raw <command>');
    await withConnection(async (conn) => {
      const reply = await conn.query(`${args[0]}\r`).catch((e) => `(${e.message})`);
      out(reply, { sent: args[0], reply });
    });
  },

  async monitor() {
    const intervalMs = Math.max(1, Number(opt.interval)) * 1000;
    const failCmd = opt['shutdown-on-fail'] && shutdownCommand(opt['shutdown-on-fail']);
    const lowCmd = opt['shutdown-on-low'] && shutdownCommand(opt['shutdown-on-low']);
    let last = null;
    let conn = null;

    const record = (obj) => {
      if (opt.log) appendFileSync(opt.log, JSON.stringify(obj) + '\n');
    };

    const emit = async (ev, sample) => {
      const event = { type: 'event', ts: Date.now(), ...ev, sample };
      record(event);
      const stamp = new Date(event.ts).toISOString();
      out(`${stamp}  ${ev.severity.toUpperCase().padEnd(8)} ${ev.code}: ${ev.message}`, event);
      if (opt['on-event']) {
        spawn(opt['on-event'], {
          shell: true,
          stdio: 'inherit',
          env: {
            ...process.env,
            UPS_EVENT: ev.code,
            UPS_MESSAGE: ev.message,
            UPS_SEVERITY: ev.severity,
            UPS_JSON: JSON.stringify(event),
          },
        }).on('error', (e) => console.error(`[on-event] ${e.message}`));
      }
      const shutdown = ev.code === 'UTILITY_FAIL' ? failCmd : ev.code === 'LOW_BATTERY' ? lowCmd : null;
      if (shutdown && conn?.isOpen) {
        await conn.send(shutdown);
        console.error(`[monitor] sent UPS shutdown ${JSON.stringify(shutdown)}`);
      }
    };

    const connect = async () => {
      const c = new UpsConnection(await resolvePort(), { trace });
      await c.open();
      c.rating = await readRating(c);
      return c;
    };

    let stopping = false;
    const stop = async () => {
      stopping = true;
      await conn?.close();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);

    let misses = 0;
    while (!stopping) {
      if (!conn?.isOpen) {
        try {
          conn = await connect();
          misses = 0;
          await emit({ code: 'COMM_OK', message: `Connected on ${conn.path}`, severity: 'success' });
        } catch (err) {
          if (last !== 'offline') {
            await emit({ code: 'COMM_FAIL', message: err.message, severity: 'warning' });
            last = 'offline';
          }
          await new Promise((r) => setTimeout(r, 8000)); // rescan period
          continue;
        }
      }

      try {
        const sample = parseQ1(await conn.query(CMD.status, { accept: isQ1Reply }), conn.rating);
        if (sample) {
          misses = 0;
          const prev = typeof last === 'string' && last !== 'offline' ? last : null;
          for (const ev of diffStatus(sample.status, prev)) await emit(ev, sample);
          last = sample.status;
          record({ type: 'sample', ts: Date.now(), ...sample });
          if (!opt['events-only']) {
            out(`${new Date().toISOString()}  ${formatSample(sample)}`, { type: 'sample', ts: Date.now(), ...sample });
          }
        }
      } catch (err) {
        if (++misses >= 3) {
          await emit({ code: 'COMM_FAIL', message: `Lost contact with UPS: ${err.message}`, severity: 'warning' });
          last = 'offline';
          await conn.close();
        }
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  },
};

async function main() {
  if (opt.help || !command) {
    console.log(HELP);
    return;
  }
  const run = commands[command];
  if (!run) {
    console.error(`unknown command: ${command}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  await run();
}

main().catch((err) => {
  console.error(`tsups: ${err.message}`);
  process.exitCode = 1;
});
