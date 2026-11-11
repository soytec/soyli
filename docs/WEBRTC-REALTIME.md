# WebRTC realtime delivery

Local reference implementation; not a deployment or independent-shell interoperability claim.
The selected NIP-5D authority remains `c041f84667c1781c3c1d5bfbd970943131b38cc9`.

## Proposal and implementation boundary

Implemented [NAP-WEBRTC #145](https://github.com/napplet/naps/pull/145) at
`69b8f0b367e3e204ce522b5369d446974b11459a`, checked with its discussion on
2026-11-11. It changed during implementation: the previously reviewed
`849943dec238939107e8af589992176648235438` gained explicit whole-session
delivery and temporary-key requirements. Those are implemented, including no
app events for incompatible peers. The resulting parent
[#59](https://github.com/napplet/naps/pull/59) was reviewed at
`fb4dd6f0e6294e1837733d2af61931e3e114bd97`. #145 is merged into #59, which remains open;
this is still a proposed upstream specification. Delivery options, separate byte operations/events,
`maxPayloadBytes`, optional statistics and authenticated sender keys follow #145.
The broadcast/queue semantics below are our explicit choices, consistent with
#59's discussion; they are not claims that those choices were standardized.

## App contract

- `open({scope, channel, protocol?, ordered?, maxRetransmits?})` defaults to
  reliable, ordered JSON-compatible delivery. The returned session reports the
  actual `ordered`, optional `maxRetransmits`, and `maxPayloadBytes: 16384`.
  Omitted `maxRetransmits` means reliable; `0` requests no retransmissions.
  A browser that rejects the options is probed with reliable ordered delivery
  instead, and that fallback is reported. Settings do not change with membership.
- `send(sessionId, payload)` carries JSON, measured as UTF-8 JSON bytes.
  `sendBytes(sessionId, bytes)` takes canonical padded RFC 4648 base64 and sends
  decoded binary. Empty bytes are valid. Nonzero pad bits, URL alphabet, whitespace,
  missing padding and payloads over 16 KiB are rejected. A JSON string that looks
  like base64 remains a JSON `message`; binary becomes a `bytes` event.
- All currently joined/open peers receive a broadcast. No peers is an error.
  Before reserving any payload, every recipient must have capacity and, for bytes,
  authenticated byte support. `unsupported` means no binary payload was sent to
  any peer. `QUEUE_FULL` likewise queues nothing to any peer.
- Success means locally queued, **not delivered or acknowledged by the remote app**.
  Each peer has a 256 KiB combined native/host byte budget and a 256-message host
  queue. A subsequent peer failure drops that peer's queued work, reports departure,
  and preserves healthy peers. An empty room remains connecting until explicitly
  closed. Applications should coalesce obsolete state, not accumulate retries.
- Sends share a 120-operation/second, 512 KiB/second session budget; the host bridge
  additionally bounds aggregate realtime envelopes (base64 adds overhead there).
  Receives are limited per peer to 240 messages/second, 512 KiB/second and 16 KiB
  per payload. Four sessions and eight remote peers/session remain host policies.
- Unknown delivery after a timeout must not cause an automatic JSON resend of that
  same payload. Only an explicit `unsupported` rejection is safe for that fallback.
  The injected binding never retries. Old bindings without `sendBytes` keep JSON.
- `from` and peer keys come from authenticated signaling, never application fields.
  Guest transport keys are valid senders; this does not identify a durable profile.
  Apps must still validate membership, authority, payloads and sequence numbers.
- Optional `stats` expose only measured `rttMs`, at most once/second/peer, and room
  peer keys. No loss ratio is fabricated: browser aggregate counters cannot supply
  a dependable application loss measurement. No SDP, candidates, addresses or
  credentials appear in these events. The separate host diagnostics UI stays host-only.
- Permission revocation closes both reliable and transient sessions. Pending
  negotiations, callbacks, queues and stats cannot continue delivering after teardown.

## Host-owned signaling addition

The original namespace/signature/NIP-44 rules of `soy-rtc/1` remain. The host adds
this signed hello field and repeats it inside encrypted offers/answers:

```json
{"realtime":{"profile":"soy-rtc/realtime-1","bytes":true,"ordered":false,"maxRetransmits":0,"maxPayloadBytes":16384}}
```

`maxRetransmits: null` denotes reliable delivery. An absent extension denotes an
old reliable, ordered, JSON-only host. Sessions admit only peers with matching
actual delivery settings, including late joins; native negotiated channels are
checked too. Binary requires the extension on the authenticated remote incarnation
before sending. Nonces bind offers/answers and retired incarnations are rejected.
An old reliable host can join a new reliable session; its presence disables byte
broadcasts through explicit `unsupported`, while ordinary JSON keeps working.
An incompatible transient peer is not admitted and does not downgrade the room.

This **additional signaling profile is local to Soy**, not a field added to the
NAP app protocol or an accepted cross-shell negotiation standard. Third-party
shells need a compatible host signaling implementation to connect. Applications
never inspect or generate hello/SDP/candidate/capability traffic.

## Machines v8 consumer

The existing publication identity is preserved. Application protocol
`pocket-circuit-v7` separates reliable race/lobby/reset control from unordered,
zero-retransmit state, retaining reliable JSON when the host or peer cannot use
that path. It uses a host-star topology, validates CVM membership and authenticated
sender authority, and never reconnects the whole host session merely because one
member changes. Membership refresh requests a reliable race resync when needed.
Old `pocket-circuit-v6` races are deliberately not matched with the changed game
protocol; this is independent of backwards-compatible runtime JSON support.

World ticks and input sequences reject stale/duplicate/reordered state. One pending
send plus the latest replacement bounds application backpressure. MC7/1 frames
carry 32-bit world fields and compact quantized input; the reliable start supplies
roster IDs/names/cars. Inputs are sampled once per authoritative physics tick,
with a 250 ms intent hold then neutral input, rather than replaying a persistent
backlog or letting fast senders accelerate physics. Local prediction and ACK-based
replay remain, with bounded visual reconciliation and 50–150 ms jitter-adjusted
remote interpolation. There is no new authoritative server, host migration,
rollback simulation or anti-cheat guarantee.

## Verification and measurement

Tests exercise the actual shared host and installed patched shim in independent
Chromium contexts, with disposable local signaling/CVM and loopback coturn. Unit
fixtures additionally test real signed hello authentication, legacy capability
negotiation and rejected broadcasts. These are not third-party-shell acceptance.

A two-player frozen-build comparison drove for 15 seconds with 50 → 200 → 50 ms
one-way simulated delay and ±15 ms jitter. Final measurements:

| Measure | Before | After |
| --- | ---: | ---: |
| Host application payload bytes | 1,088,422 | 192,130 |
| Guest application payload bytes | 1,198,912 | 16,296 |
| Host p95 message bytes | 3,623 | 592 |
| Guest p95 message bytes | 4,686 | 48 |
| Host peak simulated queue bytes | 18,381 | 4,221 |
| Guest peak simulated queue bytes | 23,952 | 240 |
| Guest send-to-authoritative-ACK median / p95 | 702 / 886 ms | 468 / 761 ms |
| Guest pending-input median after latency recovers | 43 | 27 |

With ±95 ms jitter, 25% simulated transient drops and a 250 ms reliable
retransmission penalty, guest median/p95 ACK observation time changed from
958/1,207 ms to 459/805 ms. Peak guest queues changed from 69,642 to 288 bytes.
The old frozen app uses the new host for this loss comparison, so both sides use
the same loss model. Normal-delay before uses the old host and old artifact.
See [machine-readable evidence](WEBRTC-REALTIME-MEASUREMENTS.json) for hashes,
conditions, counts and phase measurements. Fewer bytes are a clear improvement;
ACK timing still includes app scheduling and is not a promise of low Internet RTT.

Verification on 2026-11-11:

- Shell repository check: 1,040 tests passed, including retired-incarnation and
  one-second stats-cadence regressions. Production web and embedded CLI builds passed.
- Extracted soyLI: 196 tests passed including the final regression/acceptance
  cases, as did type checking, compiled distribution,
  relocation/scaffold/backend-worker/embedded-preview smoke checks.
- Actual shared host and installed shim pass three independent Chromium contexts in
  both shell and extracted soyLI. Authentication, JSON/bytes identity, bounds,
  queue preflight, late joins, loss/reordering, reliable controls, individual failure,
  reconnect, stats and permission revocation are covered. Legacy host negotiation
  is a signed unit fixture; no independent third-party shell is claimed.
- Machines' six-player race and two-player legacy-binding fallback passed, including
  start, driving, guest departure and reconnect. Both normal/loss before/after
  benchmarks passed. Gameplay/guidance/type/build and conformance results are
  recorded in the consumer's network documentation.
- Nix: `scripts/nix-update-hashes.sh` measured the changed shim dependency output,
  then completed forced dependency/CLI rebuilds and `nix flake check`, including
  x86_64 Linux KVM module regressions on an isolated existing builder. AArch64
  checks were not run. Only the exact nodeModules output hash changed. This run
  preceded the final payload error-message wording; those final wording tests pass
  locally; the exact final tree has not yet repeated the Nix check.
- A same-process sequence of multiplayer test services stalled during cleanup;
  acceptance commands were rerun in fresh processes. No production changes.

Bytes are application payloads, excluding SCTP/DTLS/TURN overhead and base64 bridge
representation. Pending-input count is a backlog proxy, **not measured RTT**.
Native local RTT excludes simulated delay. Wall-clock scheduling and physics can
vary between runs; these are engineering measurements, not Internet benchmarks.
The network lab models message delay, jitter/reordering, transient drops and a
reliable retransmission delay. It does not emulate packet-level SCTP congestion.
Physical controllers, separate-network NAT/TURN, prolonged Internet loss, and
cross-shell signaling interoperability remain unverified.
