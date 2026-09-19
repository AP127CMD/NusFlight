# Nu's Flight

3D replays of Nu's DA40 training flights (callsign NGT, VTPH Hua Hin) over satellite terrain: G1000-style
instruments, flight phase / legs / heart rate, chase · orbit · cockpit cameras, MP4 export.

Live: https://nus-flight.pages.dev

This repo is a **build output** — do not edit it by hand. Source and data pipeline live in the flightvid
project (`~/CLAUDE/Flight Footage`, `flightvid/replay.py` + `flightvid/replay_web/`); publish with
`./fv replay --deploy` (after `./fv sync`), which rebuilds this folder, commits, pushes and runs
`wrangler pages deploy`.
