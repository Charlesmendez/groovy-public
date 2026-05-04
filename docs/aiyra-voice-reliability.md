# Aiyra Voice Reliability Targets

This document defines operational targets and the manual scenario matrix for native wake-word runtime (`Hey Groovy`).

## Telemetry Signals

Runtime counters are exposed via connector health (`health.aiyra_voice`):

- `wake_hits`
- `wake_suppressed`
- `missed_reports`
- `false_trigger_reports`
- `session_count`
- `session_error_count`
- `reconnect_attempt_count`
- `last_session_duration_ms`
- `last_metric_event`
- `last_metric_at`

Server logs emit structured JSON events:

- `aiyra.device_session.*`
- `aiyra.material_query.*`

Connector logs emit metric events:

- `aiyra.voice.metric`

## Acceptance Targets

Run each scenario for at least 30 wake attempts.

- **Wake miss rate (quiet):** <= 10%
- **Wake miss rate (typing):** <= 15%
- **Wake miss rate (music/TV):** <= 20%
- **False trigger rate (music/TV):** <= 1 per 10 minutes
- **Session error rate:** <= 5% of `session_count`
- **Material query round latency p95:** <= 12s
- **Device session bootstrap latency p95:** <= 3s

## Scenario Matrix

1. Quiet room (single speaker, normal mic distance)
2. Keyboard typing while speaking wake phrase
3. Background music/TV at moderate volume
4. Two simultaneous speakers
5. Long idle (>15 min), then wake

For each scenario:

1. Start connector and verify `health.aiyra_voice.status = healthy`.
2. Trigger 30 wake attempts.
3. Log false trigger count over 10 minutes.
4. For at least 10 successful wake hits, execute a material query and capture round latency.
5. Report missed wakes and false triggers from Dashboard -> Settings -> Aiyra Voice (report buttons).

## Pass/Fail

Release candidate passes if all targets above pass in all scenarios except music/TV, where at most one target can be within 20% tolerance.
