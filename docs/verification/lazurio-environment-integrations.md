# Environment integrations: Automate qualification and transition

## Scope and implementation decision

Automate uses the Integrations of its Lazurio Environment. Its own Composio
connector, account registry and per-bot MCP/app switches have already been
removed. Do not add another adapter, project key, credential store or bot ACL.
The adapter boundary is the existing engine driver, not an HTTP Composio proxy.
This qualification was prepared against OpenMausBot source
`b726e96af313b621b6e4200a5deb4d593af96df9` (package `0.1.115`). A deployed
package must be identified independently by its release manifest, source
revision and digest; its version label alone does not establish equivalence.

## Consumer contract

| Consumer | Input and adapter point | Observable guarantee |
| --- | --- | --- |
| Claude | `server/drivers/claude.ts`, `userMcpServers` in `claude-mcp-servers.ts` | For each isolated non-guest turn, forward user MCP registrations from `CLAUDE_CONFIG_DIR/.claude.json`, otherwise `HOME/.claude.json`, in the private turn MCP configuration. Forward project registrations separately; project/harness collisions retain existing driver precedence. |
| Codex | `server/drivers/codex.ts` and the existing Environment configuration contract | Keep the Environment home and native Codex configuration. Do not replace it with an Automate home, profile or injected Composio registration. |
| CLI | Engine subprocess Environment | Use installed tools and existing sign-ins. No copying API keys into Automate. Availability of a CLI is not evidence of an authenticated provider account. |

A missing/malformed Claude registration yields no servers from that file; it
must not silently fall back from an explicit configuration directory to a
different identity. Existing settings/hooks are not imported with MCP entries.
Executor transport and authentication remain owned by Lazurio Integrations.
Automate forwards their registration, not a new REST request schema or secrets.
Successful forwarding does not prove the provider has accounts, OAuth scopes,
tools or read permission for a particular source.

All bots share the capabilities of this Environment. Prompt instructions are
not account isolation. Separate Organization data by the existing Environment
boundary and provider grants; never switch a shared global Composio context
per bot or per turn. If the selected Environment mixes Organization accounts,
stop before activation and resolve the owner-approved separation first.

## Reproducible acceptance

From this repository, after its frozen dependency installation:

```sh
pnpm exec vitest run --config lazurio/vitest.config.mjs server/lazurio-environment-mcp.e2e.test.ts server/drivers/claude-mcp-servers.test.ts server/lazurio-removals.e2e.test.ts server/lazurio-codex-environment.e2e.test.ts server/drivers/lazurio-codex-environment.test.ts
pnpm typecheck
pnpm lint
```

The real fixture server uses a temporary home and fake engines. It must never
receive real credentials or the production data directory.

| Scenario | Evidence / boundary |
| --- | --- |
| Executor and Computer MCP reach a Claude bot | Inspect the fake engine's actual turn MCP config in the server E2E test. |
| Change/remove Executor registration between turns | The next turn sees the new registration/removal without a server restart; unrelated Computer registration remains. |
| Codex keeps native Environment configuration | Existing Codex fixture tests inspect home, arguments and configuration handling; they do not execute real Codex or authenticate Executor. |
| Explicit Claude directory belongs to another identity | Unit fixture proves no merging or fallback to HOME on missing/malformed config. |
| Legacy connector cannot be reintroduced | Removal E2E tests reject removed config and routes. |
| Missing provider account / denied scope / revoked OAuth | Not proven by fake engines. Later operator-approved, read-only provider qualification is required; no new sign-in, grant or write is authorized by this recipe. |
| Organization isolation | Requires inspection of the actual target Environment and provider identities; fixtures cannot certify a production boundary. |

## Change plan — requires separate deployment approval

1. Record the exact installed release, immutable manifest/digest, service
   invocation, Environment owner and approved account identities. Map every
   bot's old connector, routines/triggers and source requirements. Keep this
   private operational inventory outside the public source repository.
2. Take an owner-approved consistent backup/snapshot of the current version,
   configuration and application data using the standard lifecycle. Restrict
   access because a legacy configuration may contain credentials. Never paste
   it into an issue, PR or new application settings. Demonstrate restoration in
   an isolated fixture before a production change.
3. Qualify the candidate release against its exact source revision. Confirm
   Lazurio Integrations register Executor for both supported engines and that
   the existing Environment session resolves the intended Organization/accounts.
   A Launchpad selection alone does not prove identity in an engine subprocess.
   Record sources and UTC inspection time without exposing secrets.
4. In a separately approved maintenance window, prevent new legacy jobs by the
   standard lifecycle, wait for in-flight work, then update the application via
   the supported release lifecycle. Do not hand-edit the release directory or
   perform manual schema/credential migrations. Keep schedules disabled.
5. Verify rendering and the normal browser path, then perform separately
   approved read-only checks for the required Gmail, ClickUp and meeting-note
   sources. Record tool/account identity, grants, source and time. Do not send,
   create drafts remotely, modify tasks or publish anything during qualification.
6. Activate pilot jobs only after explicit approval and evidence of correct
   sources, private outputs, deduplication and error reporting. Deployment and
   pilot activation are distinct decisions. This PR authorizes neither.

## Recovery plan

LazurioPlatform F21 (root 0166) replaces program rollback with forward repair
and Recovery mode. Do not promise an older program/configuration snapshot as a
supported recovery operation. A data backup preserves evidence and enables a
separately qualified, schema-compatible data repair; it does not authorize a
downgrade or manual selector replacement.

Before production update, qualify the exact release with the
[passive migration harness](lazurio-migration-acceptance.md), prove consistent
backup and data repair, and resolve Organization separation. Passive fixture
transformations (notably disabled memory upkeep) do not establish a production
maintenance mode. Without a supported procedure preventing all automatic work,
do not activate the candidate.

On failure retain diagnostics, prevent new work by the supported lifecycle and
repair forward, escalating to the release owner when needed. Do not re-enable
the legacy connector, replay failed work or reconnect accounts as an implicit
fallback. Revalidate provider identity and scopes before any authorized resume.
