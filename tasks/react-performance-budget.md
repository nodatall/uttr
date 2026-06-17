# React Top-Level Flow Performance Budget

## Flow Matrix

- Product route startup and top-level sidebar flows with Tauri browser mocks.
- Viewport: 1280 x 720.
- Benchmark shape: 9 repeated runs against the same local Vite server URL.
- Final evidence file: `agent-scratch/react-performance/all-flows-final-2026-06-17.json`.
- Controlled before evidence:
  - `agent-scratch/react-performance/controlled-before-direct-imports-2026-06-17-run1.json`
  - `agent-scratch/react-performance/controlled-before-direct-imports-2026-06-17-run2.json`
- Controlled after evidence:
  - `agent-scratch/react-performance/controlled-after-defer-device-refresh-2026-06-17-run2.json`
  - `agent-scratch/react-performance/controlled-after-defer-device-refresh-2026-06-17-run3.json`
  - `agent-scratch/react-performance/all-flows-final-2026-06-17.json`

The before and after runs were captured on the same fresh `127.0.0.1:1420`
Vite server after clearing older aborted dev-server processes.

## Final Budget

| Flow | Ready signal | Median | Mean | Max | Budget |
| --- | --- | ---: | ---: | ---: | --- |
| `startup-home-ready` | `Ready to start` | 72 ms | 109 ms | 262 ms | median <= 80 ms, mean <= 130 ms |
| `open-settings` | `Application Language` | 40 ms | 60 ms | 148 ms | median <= 60 ms, mean <= 80 ms |
| `open-files` | `Choose Audio File` | 49 ms | 51 ms | 99 ms | median <= 60 ms, mean <= 80 ms |
| `open-transcriptions` | `Showing latest 20 entries` | 53 ms | 53 ms | 71 ms | median <= 60 ms, mean <= 80 ms |
| `open-models` | `Parakeet` | 33 ms | 40 ms | 73 ms | median <= 60 ms, mean <= 80 ms |
| `open-api-keys` | `OpenAI` | 34 ms | 39 ms | 65 ms | median <= 60 ms, mean <= 80 ms |

Console health budget: no repeated startup or flow-specific warnings/errors.
The final benchmark run recorded zero warnings/errors.

## Before/After Summary

The highest-confidence bottleneck was non-critical startup work continuing after
the initial Meetings screen was ready. Returning users refreshed microphone and
output device lists immediately after onboarding completed, even though that data
is only needed by settings controls. Device refresh is now deferred until the
microphone selector mounts.

The same pass also removed two initial-path imports from the local
`components/settings` barrel so the app does not eagerly traverse unrelated
settings exports from `HomeWorkspace` and `SettingsWorkspace`.

| Flow | Controlled before medians | Controlled after medians | Result |
| --- | ---: | ---: | --- |
| `startup-home-ready` | 76-80 ms | 68-75 ms | Improved beyond the observed 4 ms before-run spread. |
| `open-api-keys` | 49-53 ms | 31-34 ms | Clearest page-flow improvement; no budget regression. |
| `open-transcriptions` | 49-51 ms | 33-42 ms | Improved in settled after-runs; final run stayed within budget. |
| `open-settings` | 37-41 ms | 40 ms | Within measurement noise; no regression. |
| `open-files` | 32-40 ms | 35-49 ms | Within observed local scheduling noise and still under budget. |
| `open-models` | 33-35 ms | 33-34 ms | No meaningful change. |

## Peer-Outlier Rule

Even when a flow is under budget, inspect it when its median is more than about
25% slower than comparable top-level page switches and the difference is larger
than observed run-to-run noise.

Current settled page-switch medians are mostly `31-42 ms`, with the final named
run showing `33-53 ms` because of local scheduling noise. `open-files` and
`open-transcriptions` were the highest medians in the final run, but their
settled after-runs were lower and the final absolute gap remains within the
observed sample spread. Treat further page-switch gains as below measurement
noise unless the gap repeats across fresh controlled runs.

## Regression Budget

- Startup/home ready should stay at or below median 80 ms and mean 130 ms.
- Top-level page/flow switches should stay at or below median 60 ms and mean 80 ms.
- API Keys should be watched for regression because it is the clearest improved
  flow: a repeated median above 50 ms on a fresh server should trigger inspection.
- A single cold or scheduling outlier is not a failure by itself; compare medians
  and means across repeated runs.
- Any repeated console warning/error during startup or a measured flow is a
  regression worth investigating.

## Reproduction Notes

This budget is documented instead of enforced in CI because local browser
startup, Vite cache state, and machine load add noise. Reproduce with:

```bash
UTTR_PERF_OUTPUT=agent-scratch/react-performance/all-flows-final-2026-06-17.json node agent-scratch/react-performance/measure-uttr.mjs
```

The probe loads `/`, installs Tauri mocks with `onboarding_completed: true`,
waits for each ready signal above, and records repeated elapsed times for the
full matrix. Rendered state can be checked with:

```bash
node agent-scratch/react-performance/visual-verify-uttr.mjs
```

Additional Browser evidence for the Settings and API Keys flows was captured
against `http://127.0.0.1:1420/ux-review.html?state=history` with screenshots at:

- `/tmp/uttr-react-performance-settings-2026-06-17.png`
- `/tmp/uttr-react-performance-api-keys-2026-06-17.png`
