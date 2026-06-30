# GOHLEM.AI — CHANGE LOG
# One entry per tagged version. Newest at bottom.
# Tag naming: phonetic alphabet in order (foxtrot → golf → hotel → india → …)
# To restore a version: git checkout <tag>
# To see what changed: git diff <tag> HEAD

| Tag | Date | What changed | Status |
|---|---|---|---|
| v0.1-alpha-first-live-test | 2026-06 | First live Retell test. Baseline before any bug fixes. | WORKING |
| v0.2-india-100pct-benchmark | 2026-06 | Conversation benchmark reached 14/14 static (100%). Simulator added. | WORKING |
| v0.3-bravo-pre-bugfix | 2026-06-25 | Product version Bravo. Known-good before session bug fixes. Benchmark 42/44 (95%). | WORKING |
| v0.4-foxtrot | 2026-06-30 | Baseline before modifier ID retry-storm fix. Includes: Retell integration, token/cost tracking, transcript portal, processing lock (BN5), alias normalization (BN6), price_confirmed bypass (BN7), B04 phantom-item fix, persistent state injection, OrderCart merge logic. Benchmark ~43/46 (rate-limit noise on last run). | WORKING |
| v0.5-golf | 2026-06-30 | Targeted modifier alias fix: MISSING_REQUIRED and INVALID_MODIFIER_ID error responses now return short aliases (M1, M2, M3…) instead of raw 36-char UUIDs. Search results unchanged — real IDs still returned. Prevents UUID transcription errors in AWAITING_MODIFIER cross-turn flows (retry storm). Also adds --only filter to benchmark for chunk-by-chunk runs. Benchmark 43/46 (93%) — same as foxtrot baseline, zero regressions. | WORKING |
