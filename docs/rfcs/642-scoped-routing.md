---
issue: Soul-Brews-Studio/maw-js#642
title: Scoped routing + trust — gate cross-scope agent messages on human approval
status: draft (design packet)
author: rfc-routing (team rfc-and-proto)
related: #627 (oracle-team), #629 (peer identity), #644 (consent gate phase 1), #565 (federation pairing)
---

# Scoped routing + trust — design packet for #642

## 1. Problem statement

`maw hey <target>` routes unconditionally. Any agent — local, fleet-mate, or
remote peer — can be named and messaged. As fleets grow past 10 oracles and
oracle-teams (#627) become the default collaboration unit, three failure modes
emerge: accidental cross-project chatter, no blast-radius limit if one oracle
is compromised, and no way for Nat to observe first contact between unrelated
agents. #644 already gates cross-node sends on a per-pair basis; #642 adds a
**scope** primitive on top so we can gate by *workstream*, not just by node,
and so "these three agents are collaborating on X" is a first-class fact the
router can see.

## 2. Current routing model (as of alpha.23)

### 2.1 Resolver — `src/core/routing.ts:30-106`

`resolveTarget(query, config, sessions)` returns one of:

- `local` — tmux window on this host (via `findWindow` or fleet session map)
- `self-node` — `node:agent` where `node === config.node`
- `peer` — remote node, resolved via `namedPeers` / `peers` in `maw.config.json`
- `error` — not found / ambiguous / unknown node

Addressing grammar today:

| Form | Example | Resolution |
|---|---|---|
| bare name | `mawjs` | local session → fleet map → agents map (remote) |
| `node:agent` | `white:mawjs` | named peer lookup → peer URL, or self-node |
| `wire://` | `wire://debug` | debug-only transport |

Canonical reference: memory "maw hey convention" + `src/core/matcher/resolve-target.ts`.

### 2.2 Consent gate — `src/core/consent/` (#644)

Already shipped in alpha.23:

- `trust.json` keyed by `${fromNode}→${toNode}:${action}` where action ∈ `{hey, team-invite, plugin-install}`
- `consent-pending/<id>.json` queue with PIN-based out-of-band approval
- Gate runs **only** on cross-node peer sends (`gate.ts:44-47` — local + self-node bypass)
- Opt-in via `MAW_CONSENT=1`

#642 is therefore **not a greenfield** — it generalizes trust from per-node-pair
to per-scope, and raises the gate above the node boundary to work on any
inter-scope edge, including purely local ones.

## 3. Scope primitives

Four scope types, each a file in `~/.maw/scopes/<name>.json`:

| Scope | Membership | Intent |
|---|---|---|
| `personal` | one oracle only | private workspace; nothing routes in without approval |
| `team` | enumerated agents (local + federated addresses) | collaboration bubble tied to an oracle-team (#627) |
| `public` | `members: "*"` on this node | everyone-on-this-box; default for legacy `maw hey` backwards-compat |
| `federated` | enumerated `node:agent` across ≥2 nodes | cross-node teams; requires peer pairing (#565) |

Why these four and not more:

- `personal` gives an oracle a write-protected boundary it owns.
- `team` is the unit #627 already ships; the scope record is just an ACL view of the team roster.
- `public` preserves the pre-#642 "route freely" behavior behind an explicit flag, so rollback is a config change, not a code revert.
- `federated` exists because a node boundary is not the same as a scope boundary — a `marketplace-work` team of {mawjs@white, security@clinic-nat} needs one scope record, not two.

Scope record shape:

```jsonc
{
  "name": "marketplace-work",
  "type": "team",                              // personal | team | public | federated
  "members": ["mawjs", "security", "white:marketplace"],
  "lead": "mawjs",                             // authorizes add/remove (see §4)
  "created": "2026-04-19T10:00:00Z",
  "ttl": null,                                 // or ISO date
  "owner": "a1b2c3d4e5f6a7b8",                 // fingerprint of scope-owner key (rfc-identity #629)
  "epoch": 1                                    // bump on member change / revocation
}
```

Members are **fingerprints**, not nicknames, on the wire. Display uses a
local nickname→fingerprint map (DNS→IP analogy). A fingerprint is
`sha256(spki-pubkey).slice(0, 16)` — 16 hex chars, 2^64 collision work,
offline-verifiable. Locally the scope record may carry both
(`{"fingerprint": "a1b2…", "nickname": "mawjs"}`) but only the fingerprint
is authoritative.

## 4. Trust anchoring per scope

Scope membership is a **claim**. Trust decides who can make that claim believable.

| Scope type | Anchor | Who can add members | Proof on the wire |
|---|---|---|---|
| `personal` | local file owner (unix uid) | oracle itself | none — local-only routing |
| `team` | the `owner` fingerprint | owner, or any member with `delegate: true` | HMAC with shared team key (already in federation-auth.ts) |
| `public` | node operator (human) | human only via `maw scope public --add` | none — intra-node only |
| `federated` | `owner`'s ed25519 signing key | owner issues per-member credentials | signed scope-member credential per request (ed25519, rfc-identity #629) |

### 4.1 Signed scope-member credential (federated only)

rfc-identity (#629) provides the signing primitive. The scope owner issues a
credential to each member:

```
canonical = "scope-member/v1\n"
          + "scope="      + SCOPE_NAME + "\n"
          + "member="     + MEMBER_FINGERPRINT + "\n"
          + "epoch="      + SCOPE_EPOCH + "\n"
          + "issued-at="  + ISO8601 + "\n"
          + "expires-at=" + ISO8601_OR_never
signature = ed25519.sign(SCOPE_OWNER_PRIVKEY, canonical)
```

Members stash credentials locally in `~/.maw/scopes/<name>/creds/<fingerprint>.b64`.
When sending `@<scope>:<target>` to a federated scope, the sender attaches
two HTTP headers (composes cleanly with existing federation transport):

- `X-Maw-Identity: <sender-fingerprint>` (from rfc-identity Phase 3)
- `X-Maw-Scope-Credential: <b64-credential>`

Receiver verifies in order: (1) credential signature against the known
scope-owner pubkey (pinned from `peers.json` / `/info`), (2) credential
`member` field equals `X-Maw-Identity`, (3) credential's epoch matches the
receiver's current epoch for that scope, (4) credential not expired. Any
failure → drop + log, no queue (forged claim ≠ approval request).

Revocation = bump `SCOPE_EPOCH` and re-issue creds to remaining members.
Ex-members' old-epoch creds fail verification step (3) from then on. No CRL
machinery needed.

**Per-request, not per-hop.** One signature on the outer envelope; transport
is direct peer-to-peer HTTP with no relays.

### 4.2 Scope ownership in federation

**Single owner = creator (v1).** The oracle that runs
`maw scope create --federated <name>` becomes the permanent owner; its
fingerprint is baked into the scope record. Ownership transfer is a v2
feature (`maw scope transfer <name> <new-fingerprint>`, requires current
owner's signature on the transfer record).

Rationale: consensus ownership needs BFT machinery we don't have, and for
v1 the human operator is the real authority — if they want the scope under
a different owner, that's a new scope.

### 4.3 Safety signals

**STUCK / ABORT / safety signals bypass all gates.** `maw hey --system` flag
marks a delivery as a safety signal; the gate always routes, but the fact is
logged in the audit record. This matches the existing no-queue behavior of
lifecycle events.

## 5. Addressing syntax

Proposed grammar (EBNF-ish):

```
target    = scoped | node-addr | bare
scoped    = "@" scope ":" agent                      # @marketplace-work:security
node-addr = node ":" agent                            # white:mawjs   (existing)
bare      = agent                                     # mawjs         (existing)
agent     = IDENT
scope     = IDENT
node      = IDENT
```

Why `@scope:agent` over `scope://addr`:

- Keeps the one-colon shape already used by `node:agent`; tab-completion stays consistent.
- `@` prefix is unambiguous — today `@` has no routing meaning, so there's no grammar collision.
- URL-style `scope://` implies a URI hierarchy that doesn't match the flat (scope, agent) pair we actually have. We'd be inviting confusion (paths? query strings?) for no benefit.
- Pairs cleanly with `@scope:*` for "broadcast to scope" in a future iteration; that rules out `scope://`-style because `scope://*` looks like a globbed host.

Resolution rules for `@scope:agent`:

1. Load `~/.maw/scopes/<scope>.json`. If missing → error `unknown_scope`.
2. Resolve `agent` via local nickname→fingerprint map; assert the resulting fingerprint ∈ `members`. If sender's fingerprint ∉ `members` → error `not_in_scope` (caller may escalate to `maw scope join`).
3. If scope type is `federated`, attach `X-Maw-Scope-Credential` + `X-Maw-Identity` headers (§4.1). Receiver re-verifies; wire claim is a hint, re-verification is authority.
4. For any scope type, route to the resolved target (local tmux / self-node / peer per existing `resolveTarget`). **Skip the #644 per-pair consent check** — scope membership is the authorization, trust.json isn't consulted twice.
5. If `agent` not a scope member → error `target_out_of_scope` (caller may request approval via `maw hey --approve` per §6).

### 5.1 Container-oracle addressing

> **Awaiting container-proto reply.** Working assumption until they respond:
> a container-oracle is addressed as `<container-host-node>:<agent>` and
> belongs by default to a freshly-minted `personal` scope at boot. The
> container host can optionally `maw scope join` it into a team scope after
> attestation. This keeps `@scope:agent` grammar stable — containers do not
> need a new scheme like `container://`.

## 6. First-PR cut (≤300 LOC)

Scope this tight — everything else is Phase 2+.

**In:**

1. New file `src/core/scopes/store.ts` — `loadScope(name)`, `writeScope(rec)`, `listScopes()`, `inScope(sender, target, scope)`. **Team scopes read from `ψ/memory/mailbox/teams/<team>/manifest.json` (rfc-team alignment — single source of truth); personal/public scopes live in `~/.maw/scopes/<name>.json`.** Atomic write via temp+rename. ~120 LOC.
2. New file `src/core/scopes/gate.ts` — `maybeGateScope(ctx)`. Runs BEFORE the existing `maybeGateConsent`. Returns allow if (sender, target, scope) all valid; otherwise enqueues a pending approval and denies. ~80 LOC.
3. Wire into `comm-send.ts` — parse `@scope:agent` form, populate `GateContext.scope`, call `maybeGateScope` first, `maybeGateConsent` second. ~40 LOC.
4. Minimal CLI: `maw scope list`, `maw scope show <name>` only. ~40 LOC.

**Out (Phase 2+):** scope create/edit CLI, federated scope signing + credential issuance (depends on rfc-identity #629 landing signing primitive), `--approve` UX, audit log, wildcard trust, cross-node scope sync, batched approval, ownership transfer, key rotation credential chain.

Default behavior: unscoped `maw hey` continues to work unchanged. `@scope:agent`
is the only new code path. Rollback = don't type `@`.

Env flag: `MAW_SCOPED_ROUTING=1` — when off, `@scope:agent` errors with
"scoped routing not enabled". Ship-default off until Phase 2.

## 7. Open questions

1. **Scope on receive side** — RESOLVED via rfc-identity. Receiver re-verifies: credential signature + epoch + fingerprint match. Wire claim is a hint, receiver's copy of scope-owner pubkey is authority. See §4.1.
2. **Scope record distribution.** How does the record land on each member's filesystem? (Leaning `maw scope fetch <owner-fingerprint>` — explicit over magic. Record is public-keyed by owner fingerprint so transport need not be trusted; fetched record is self-verifying.)
3. **Agent renaming** — RESOLVED via rfc-identity. Members are fingerprints, not names. Renaming is a local display-map update; fingerprint is stable until key rotation. Key rotation is a v2 concern (will need a rotation credential chain).
4. **Overlap + precedence.** An agent can be in multiple scopes. If target is reachable via scope A (allowed) and scope B (denied), which wins? (Proposal: ACL-union — any allowed scope permits the send. Personal-scope exclusion lists don't weaken team-scope permissions for unrelated targets.)
5. **Audit log location.** `ψ/` (shared, auditable across federation) vs `~/.maw/audit/` (local, private). Memory "Vault sync scope" warns ψ/ is not fully cross-node synced, so leaning local with opt-in ψ/ mirror for team scopes.
6. **Phase 3 deprecation.** "Require every `maw hey` to cite scope" is a breaking change; needs its own issue. Out of scope here — this RFC only earns us the *ability* to require it later.
7. **Interaction with #644 trust.json.** Proposal: keep. #644 is the fallback for public-scope and legacy unscoped callers. Scoped sends skip #644 (§5 rule 4) so we never double-gate.
8. **Relationship to #627 team-invite action** — RESOLVED via rfc-team consult. The `team-invite` consent action stays (governs *joining*); scope record governs *messaging*. One ceremony to join, no per-pair trust accumulation after. See §3 table / §5 rule 4.
9. **Container scope default** — tentative pending container-proto. Working model: container-oracle boots into a fresh `personal` scope, scope-owner = container host's fingerprint; host runs `maw scope join <team> <container-fingerprint>` after attestation. No `container://` scheme needed; addressing is `<host-node>:<agent>`.

---

## 8. Changelog

- **2026-04-19 r1**: initial packet (commit ee4c7b1).
- **2026-04-19 r2**: folded rfc-identity reply — fingerprint primitive in §3, signed credential + header integration in §4.1, v1 single-owner decision in §4.2, fingerprint-based renaming in §7.3 resolved. Folded rfc-team consult — §7.8 documents team-invite (join) vs scope (message) separation.
- **2026-04-19 r3**: rfc-team round 2 — team scope reads from existing `ψ/memory/mailbox/teams/<team>/manifest.json` (single source of truth, no new file). Manifest grows optional `scopeOwner` + `epoch` fields for federated teams; both additive.

*Container-proto reply still pending; §7.9 remains tentative until they land.*
