# RFC: Peer Identity (#629)

Status: DRAFT (design packet)
Owner: rfc-identity (team rfc-and-proto)
Tracking: #623 Q2 — `neo@clinic-nat.local` vs bare names
Related: #632 (rollout flag), #642 (scoped routing), #627 (oracle-team)

## 1. Problem

Federated `maw` peers today authenticate each other with a shared `federationToken` (HMAC-SHA256) and address each other by a bare nickname in `peers.json`. Two problems collide:

- **Naming collisions.** Bare `neo` means different oracles depending on which node you're on. Confirmed in-fleet (`project_neo_federation_ambiguity`) and on 4th-node onboarding (`project_colab_federation_peer`). `neo@clinic-nat.local` is proposed as the disambiguator, but a hostname is not an identity.
- **Shared-secret trust.** Any peer holding the token can sign as any peer. There is no per-peer authentication, no non-repudiation, and no safe revocation short of rotating the token across every node. Path B of #191 (local reverse-proxy forwarding to 127.0.0.1) already shows the seams.

#629 in its narrow form asks "A vs B naming scheme." This RFC reframes: **names are a UX surface; the underlying identity primitive needs to be a per-oracle keypair.** Then the A/B question becomes a cheap display concern.

## 2. Current state (cited)

- `src/lib/federation-auth.ts` — HMAC over `METHOD:PATH:TS[:BODY_SHA256]`, `±5 min` window, v1/v2 per `X-Maw-Auth-Version`. Token is global per-node.
- `src/commands/plugins/peers/store.ts` — `peers.json` schema v1: `{ version, peers: { <alias>: { url, node, addedAt, lastSeen, lastError?, nickname? } } }`. Alias is the addressing key. `node` and `nickname` are advisory metadata only; neither is authenticated.
- `src/api/federation.ts:/identity` — public `GET /identity` returns `{ node, version, agents, uptime, clockUtc }`. No signature, no pubkey.
- `src/commands/plugins/pair/handshake.ts` — `/api/pair/<code>` bootstrap: acceptor POSTs `{ node, url }`, receives `federationToken`. Short-lived code is the only factor; once the token is shared it is permanent until rotated.
- Shape A (#647/#657) added `nickname` propagation + consent PIN. Nickname lives in `/info` and peer store but is not bound to any key.

## 3. Threat model

Attacks a proper identity primitive should close — and which HMAC does not:

| # | Attack | HMAC outcome | Why |
|---|--------|--------------|-----|
| T1 | Peer A impersonates Peer B to node C | **passes** | Both hold the same token |
| T2 | Compromised peer signs arbitrary requests as any peer for the token's lifetime | **passes** | No per-peer binding |
| T3 | Revoke a single bad peer | **requires fleet-wide token rotation** | Shared secret |
| T4 | Token leak via log/env/backup | **total federation compromise** | Single secret |
| T5 | Man-in-the-middle between paired peers over plain HTTP | **defeats HMAC entirely** | Attacker sees body + signature, replays within 5 min |
| T6 | Two peers with same nickname (`neo`) — which is authoritative? | **undecidable** | Name is not identity |
| T7 | Stolen `peers.json` entry replayed on a different node | **works** | Entry is unbound to any secret |

Out of scope for this RFC: transport-layer security (that's TLS / #191 Option D), storage-at-rest encryption of the identity keyfile, identity revocation distribution (noted as open question).

## 4. Proposed primitive — ed25519 keypair per oracle

Chosen: **ed25519 keypair**, generated once per oracle, stored at `~/.maw/identity.json`. Public key is attested via `/identity`; every federation request is additionally signed by the sender's private key over the same canonical payload HMAC uses today.

Why ed25519 (not DID, not X.509):

- **Small, no PKI.** 32-byte pubkey, 64-byte sig. No CA, no chain. Fits the federation's decentralized ethos — no root of trust above the oracle itself.
- **Native to Node.** `crypto.generateKeyPairSync("ed25519")` + `crypto.sign("ed25519", ...)` — no dependency added. Browsers can verify via WebCrypto.
- **DIDs are aspirational here.** `did:key` degenerates to "pubkey as id" for our use case; we'd pay a parsing and doc tax for zero gain. If we later want DID interop we wrap the same ed25519 key in `did:key:z...` — no migration.
- **X.509 / mTLS** pushes identity into the transport layer and makes per-peer rotation hard. Application-layer signing keeps identity portable across hub, direct, and relay transports (#642 territory).

### Identity shape

```json
// ~/.maw/identity.json (0600, never committed)
{
  "version": 1,
  "createdAt": "2026-04-19T...",
  "nickname": "neo",
  "node": "clinic-nat.local",
  "privateKey": "<pkcs8-b64>",
  "publicKey": "<spki-b64>",
  "fingerprint": "<sha256(publicKey)[0..16]>"  // 8-byte hex, human-shown
}
```

### `/identity` extended

```json
{
  "node": "clinic-nat.local",
  "nickname": "neo",
  "version": "26.4.19",
  "publicKey": "<spki-b64>",
  "fingerprint": "ab12cd34ef567890",
  "attestation": {
    "issuedAt": "<ISO>",
    "signature": "<ed25519 over canonical(body-sans-attestation)>"
  },
  ...existing fields
}
```

`/identity` becomes self-attesting — a MITM that rewrites nickname or publicKey breaks the signature. This is the piece `pair` has been missing: the consent PIN proves the operator is present; the signed `/identity` proves the keypair is bound to that response.

### Addressing (answers #629 Q2)

- **Canonical identity** = `fingerprint` (pubkey hash, 16 hex chars). Never ambiguous.
- **Display** = `<nickname>[@<host>]`. The `@host` qualifier is shown **only when** two stored peers share a nickname (matches issue's "A with B as fallback" proposal).
- `peers.json` gains `publicKey` + `fingerprint` on each entry. Alias collisions are displayed with fingerprints in `maw peers list`; `maw plugin install foo@neo` prompts when ambiguous.

### Per-request signing

Reuse the v2 canonical payload (`METHOD:PATH:TS:BODY_SHA256`) plus `ISSUER_FINGERPRINT`, signed by the issuer's private key. Headers:

```
X-Maw-Identity: <fingerprint>
X-Maw-Identity-Sig: <ed25519-sig-b64>
X-Maw-Auth-Version: v3
```

HMAC (`X-Maw-Signature`, `v2`) continues to work; v3 is additive.

## 5. Migration path from HMAC

Four phases, each independently shippable:

1. **Keygen + attested /identity** (this RFC's first PR). Oracle generates its keypair on first run, exposes pubkey + self-attestation on `/identity`. Nothing else changes. Purely additive.
2. **Pair binds keys.** `/api/pair/<code>` handshake additionally exchanges pubkeys. `peers.json` stores `publicKey` + `fingerprint`. Post-pair, peers can verify `/identity` attestation on every probe — closes T5 for already-paired peers.
3. **Dual-signing.** Outgoing federation requests attach v3 identity signature alongside v2 HMAC. Server-side `federationAuth` gains a `v3` branch: when header present, verify sig against known peer pubkey. HMAC still required for backward compat. Closes T1, T2, T7 per-request.
4. **HMAC deprecation.** Config flag `requireIdentity: true` rejects v2-only requests. Token becomes a pair-bootstrap-only secret or is removed entirely. Closes T3, T4.

Rollback is trivial at each phase — identity headers are ignored by any node that hasn't enabled verification.

## 6. First-PR cut (≤300 LOC)

Scope strictly **Phase 1**:

- `src/lib/identity/keygen.ts` — ~40 LOC. `ensureIdentity()` generates keypair on first call, atomic-writes `~/.maw/identity.json` with mode `0600`. Returns cached handle.
- `src/lib/identity/attest.ts` — ~30 LOC. `attestIdentity(body, privKey)` returns `{ issuedAt, signature }` over `canonicalize(body)`. `verifyAttestation(body, pubKey)` inverse.
- `src/api/federation.ts` — ~15 LOC. `/identity` adds `publicKey`, `fingerprint`, `attestation`.
- `src/lib/identity/fingerprint.ts` — ~10 LOC. `fingerprint(pubKey) = sha256(spki).slice(0,16)`.
- Tests: keygen idempotence, file-mode, attestation round-trip, `/identity` shape, tamper detection. ~150 LOC test.

Explicitly **not** in first PR: `peers.json` schema bump, pair handshake changes, outgoing request signing, HMAC deprecation. Each of those is its own tracked issue + PR under the migration plan.

## 7. Open questions

- **OQ1 — Revocation.** When an operator rotates their identity (key compromise, oracle rebuild), how do peers learn? Options: (a) explicit `maw peers refresh <alias>` re-probes `/identity`; (b) short-lived attestation `issuedAt` with TTL; (c) gossip. Phase-1 lands (a) implicitly. Needs decision before Phase 3.
- **OQ2 — Nickname change.** Nickname is advisory metadata. If `neo` renames to `neoa`, peer `peers.json` entries are still keyed by the old alias. Do we rekey by fingerprint and treat `alias` as display-only? Leaning yes — matches #629's "names are UX" framing.
- **OQ3 — Pair-code threat model.** Phase-2 pair must bind pubkeys inside the code exchange, not after, to avoid a window where a MITM swaps keys. Matches the existing `handshake.ts` "code itself authenticates this single exchange" comment but needs explicit audit.
- **OQ4 — Multi-device same oracle.** If `neo` runs on laptop + phone, same identity or per-device subkeys? Punt to post-migration; Phase-1 doesn't preclude either.
- **OQ5 — Interaction with #642 scoped routing.** *Resolved direction (see §8.1):* identity signs scope membership credentials. Scope-owner's identity keypair is the trust root; credential payload is `scope-member/v1 { scope, member, epoch, issued-at, expires-at }` with ed25519 signature. `X-Maw-Scope-Credential` header carries the b64 credential; receiver verifies signature + matches `member` against sender's `X-Maw-Identity`. Revocation via `SCOPE_EPOCH` bump. Who owns a scope (single creator vs consensus) is rfc-routing's call.
- **OQ6 — Interaction with #627 teams.** *Resolved direction (see §8.2):* v1 teams ship name-only (current `namedPeers.name` as stable-enough id); v2 teams upgrade via signed-join — `team-invite`'s PIN round is extended to carry `publicKey + invitee-signature-over-PIN`, closing the trust loop at invite time. First-message per-request signing is strictly an additional belt in Phase-3.

## 8. Cross-consult resolutions

Recorded here because the answers shape Phase-1 scope.

### 8.1 rfc-routing (#642 scoped routing)

- `fingerprint` (sha256(spki-pubkey)[0..16], 16 hex chars) is adopted as the stable agent-id primitive for the `@scope:agent` grammar. Nickname→fingerprint is a local lookup (DNS-style); wire carries fingerprint, display carries nickname.
- Scope membership is a **signed credential**, not a local-only fact. Canonical payload:
  ```
  scope-member/v1
  scope=<SCOPE_NAME>
  member=<MEMBER_FINGERPRINT>
  epoch=<SCOPE_EPOCH>
  issued-at=<ISO8601>
  expires-at=<ISO8601_OR_never>
  ```
  Signed by the scope-owner's identity privkey; verifiable offline by anyone with the owner's fingerprint. Carried in `X-Maw-Scope-Credential` header; receiver additionally checks `member` matches the `X-Maw-Identity` fingerprint (Phase-3).
- Revocation = bump `SCOPE_EPOCH`, re-issue credentials. Stale-epoch credentials rejected.
- Phase-1 (this RFC's first PR) does NOT ship scope-credential code — routing RFC owns that — but Phase-1 MUST expose the `signWith(identity, canonical)` / `verify(fingerprint, canonical, sig)` primitives in a shape rfc-routing can consume.

### 8.2 rfc-team (#627 oracle-team)

- Confirmed: identity is NOT a v1 team prereq. v1 uses `namedPeers.name`; v2 adopts signed-join cleanly.
- Canonical keyfile location: `~/.maw/identity.json` (single place, JSON wrapper, mode 0600). No `ψ/identity/` parallel store — if Oracle layer needs a bare-key view, expose via a helper, not a second file.
- Keygen runs **both**: lazy (`ensureIdentity()` on first command that needs it) AND eager (invoked by `maw bud` post-hook so freshly-budded oracles boot with a key). Same idempotent function, two call-sites.
- Signed-join on **invite** (v2), not first-message. The PIN round already establishes human-intent at the right moment; extend its payload to carry `publicKey + invitee-signature-over-PIN`. First-message per-request signing comes with Phase-3 and is independent.

### 8.3 container-proto (docker oracle prototype)

- Container keypair persists in a **named volume at `/home/oracle/.maw/identity.json`** — same schema as host, so `rsync`-ing the volume to a host is a valid recovery path.
- Oracle name (`stem`) is **baked in at build time via env** (e.g. `ORACLE_STEM=neo`), written to `nickname` field on first boot. Name is NOT derived from pubkey — keeping `stem` (human display) and `fingerprint` (canonical id) orthogonal is the whole point of this RFC. Two containers with the same stem + different fingerprints is the #629 collision case, which this design already handles.
- Entrypoint flow: `if [ ! -f /home/oracle/.maw/identity.json ]; then maw identity init --nickname="${ORACLE_STEM:-container-oracle}"; fi; exec maw "$@"`.
- Volume-loss is re-pair territory, not silent re-trust: when host sees a fingerprint change for a known nickname, it MUST re-run the pair flow rather than auto-accept. Added as OQ7 below.

## 9. Additional open questions (from cross-consult)

- **OQ7 — Fingerprint rotation / re-pair semantics.** When a paired peer presents a new fingerprint under an existing `peers.json` alias (volume loss, key compromise, deliberate rotation), the default MUST be reject-and-require-re-pair. Auto-accepting on fingerprint change defeats the entire identity primitive. Surfaces first as a `maw peers add` refusal with a clear "re-run `maw pair`" hint. Triggered by container-proto's volume-loss case; applies equally to host-side key rotation.

## Appendix A — Relation to issue's narrow A/B question

The issue framed Q2 as "A bare names vs B oracle-qualified." This RFC argues neither is the real decision: **names are display, identity is keypair.** Given that:

- A (bare names) is retained as default display.
- B (`<nick>@<host>`) is retained as disambiguation fallback, shown only on collision.
- Both are additionally backed by `fingerprint` for unambiguous reference, which is what `peers.json`, routing, and team-membership records actually persist.

Recommend signing off this RFC framing; A/B surface language slots cleanly on top of the keypair primitive.
