# tsups

Cross-platform (macOS / Linux / Windows) command-line monitor for TS Shara UPS
units that speak the Megatec **Q1** serial protocol over USB.

The UPS speaks the Megatec **Q1** protocol over a USB-serial port at 2400 baud:

| Command | Meaning                                  |
|---------|------------------------------------------|
| `I`     | Identify (reply must contain `TS`)       |
| `F`     | Rating info                              |
| `Q1`    | Status (polled every 2 s)                |
| `T` / `TL` / `Tnn` | 10 s test / test until low / nn-minute test |
| `Q`     | Toggle beeper                            |
| `Sn`    | Turn output off after n minutes          |
| `C`, `CT` | Cancel shutdown / cancel test        |

### Hardware quirks (TS Shara USB interface, STM32 `0483:5740`)

Measured on a real unit; handled in `src/serial.js`:

- A reply is held until the host writes again. `tsups` sends a bare `\r`
  every 300 ms after a command to release it.
- A command sent right after a reply is silently dropped. `tsups` waits
  500 ms after the last reply before sending the next command.
- `F` reports the input voltage as `Univ.` (universal / bivolt).

## Install

```sh
npm install -g tsups
```

On Linux, add yourself to the `dialout` group (or `uucp` on Arch) to access
`/dev/ttyUSB*`.

## Usage

```sh
tsups detect                 # find the UPS
tsups status                 # one reading
tsups status --json
tsups monitor                # continuous; Ctrl+C to stop
tsups monitor --events-only --log ups.jsonl \
  --on-event 'osascript -e "display notification \"$UPS_MESSAGE\" with title \"UPS\""'
tsups test quick | low | 5
tsups beep
tsups shutdown 3 --yes       # UPS output OFF in 3 minutes
tsups cancel-shutdown
tsups raw Q1                 # send anything, print reply
```

Events: `UTILITY_FAIL`, `UTILITY_RESTORED`, `LOW_BATTERY`, `OK_BATTERY`,
`BYPASS_ENABLED/DISABLED`, `UPS_FAULT`, `BATTERY_TEST_STARTED/FINISHED`,
`SHUTDOWN_PENDING/CANCELLED`, `BEEP_ENABLED/DISABLED`, `COMM_OK`, `COMM_FAIL`.

To shut down the computer on power loss, use `--on-event` with a script that
checks `$UPS_EVENT` (e.g. `LOW_BATTERY`) and runs `shutdown -h +1`.

## Notes

- Status bit 6 is reported per the Megatec spec (1 = shutdown pending).
- Q1 replies with a malformed status field are rejected instead of parsed.
- `tsups monitor --json` output can be sent to InfluxDB with
  [`upsflux`](https://github.com/slaplacian/upsflux).

## Development

```sh
npm install
npm test        # parsing, battery %, event detection, command formatting
npm link        # puts your working copy of `tsups` on your PATH
```

## Disclaimer

Independent project, not affiliated with or endorsed by TS Shara. Product
names are trademarks of their respective owners. Sending `S`/`T` commands
switches the UPS output or runs battery tests; use at your own risk.

## License

MIT
