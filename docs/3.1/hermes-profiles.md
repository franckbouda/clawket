# Hermes profiles in one connection

Owner decision, 2026-10-15: expose every installed Hermes profile as an Agent in the existing Hermes connection. This supersedes the single-Agent/group descriptions in the frozen 3.0 specification. It does not add profile creation/deletion, change quotas, introduce a transport or deploy a service.

## Protocol and isolation

New Bridges advertise `hermes.profiles.v1` only when the installed native implementation supports profile prefixes, multiplexing is enabled and an authenticated native `/p/default/v1/models` probe succeeds. New Apps request `hermes.profiles.list`; only successful discovery subscribes that socket to named-profile events. Old Apps retain `agents.list`, unqualified session keys, default-profile behavior and existing health fields. Old Bridges remain single-Agent in new Apps. OpenClaw is unchanged.

The default Agent keeps `agentId=hermes` and `mainSessionKey=main`. Installed named homes under the configured Hermes home's `profiles/` directory become `hermes-profile.<name>` Agents; session keys use `agent:hermes-profile.<name>:<opaque-native-or-Bridge-key>`. Native session/run IDs, cursors, messages, artifacts and file handles stay intact. Bridge approval IDs are qualified separately so identical native run/request IDs in two profiles cannot collide; resolution removes only the matching profile prefix. Discovery validates native profile names, requires a real local directory and `config.yaml`, and fails above 128 directory entries. Unknown profiles and conflicting key/profile selectors fail before dispatch. No path supplied by a phone is used as a profile home.

`hermes.profile.request` carries an allowlisted method and its parameters for operations without a session key. Qualified keys also route ordinary session/chat/file methods. Requests cannot nest profile envelopes, invoke lifecycle/update control, fall back to another profile or select a second transport. Profile contexts share the authenticated owner socket and listener; they never start native gateways or listeners. Live events are routed back with qualified session keys only to subscribed clients.

Each context has its own native home, read-only `state.db` reader, Python environment, active runs, cancellation, approvals, model caches, file/artifact grants and Clawket stores. Bridge-owned metadata lives beside the configured session store in `hermes-profiles/<name>/`; native histories remain untouched. Shutdown fences pending context creation and cancels all owned profile work. Update admission includes active named-profile work. Model changes are global within the selected native profile, never per conversation.

Mobile uses stable per-Agent management views. Model, skills, memory files, cron, usage and chat controls retain the selected profile across asynchronous reads and navigation; no mutable global "selected profile" is introduced. Connection renames affect the default product Agent only, preserving profile names in live and cached rosters. Existing access checks and unsupported-feature gates remain.

## Native Hermes prerequisites

Hermes must provide its multiplexed API routes `/p/<profile>/v1/...`. The host's authenticated API listener stays on loopback. Each named profile must have its own usable literal `API_SERVER_KEY` in that profile's `.env`, configured through Hermes' own settings flow (`hermes -p <name> config set API_SERVER_KEY <unique-secret>`). Existing credentials must not be rotated just to enable Clawket. Keys stay on the computer: never send them in descriptors, pairing payloads, logs or source files. The Bridge reads each profile's dotenv file without interpolation and never falls back to the default API key. Missing keys preserve discovery/history metadata but reject chat before dispatch with a setup remedy. API-disabled or unserved profiles fail at their native endpoint rather than using the default Agent.

Clawket does not change Hermes source or profile configuration during discovery. Its managed gateway sets `HERMES_GATEWAY_EXTERNAL_SUPERVISOR=1`, pinning the configured home instead of following the interactive `active_profile` file. A separately managed native gateway retains its existing lifecycle; restarting it requires explicit owner authorization.

## Verification and delivery

Focused self-contained tests cover identity validation, equal native keys in different homes, isolated stores and management requests, cancellation during creation, method allowlisting, missing keys, legacy behavior and subscribed events. Existing recorded Hermes/OpenClaw adapter tests and v1 replay remain compatibility checks. Actual profile API readiness, a phone connection and successful inference are separate evidence.

Both the Bridge and App need this implementation for the new roster. A merge alone does not update an installed Bridge or phone. Local acceptance builds remain separate from npm publication, Worker deployment and Store distribution; no Relay/Registry change is required.
