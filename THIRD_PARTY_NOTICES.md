# Third-party notices ledger

Snapshot: 2026-11-16.

This file is the review ledger for **new** reuse decisions in the AI-OS refactor. It does not replace the root [`NOTICE`](NOTICE), which contains the copyright and full license text for third-party code already distributed with DS-Bot.

## Current change

**No third-party source code was copied into DS-Bot by this research change.** The new files are original decision assets. Therefore this change does not add a new copied-code notice.

## Existing adopted boundaries

| Component | Version | License | Boundary | Notice status |
|---|---|---|---|---|
| DeepSeek Harness | `0.2.2-rc.1` pinned; upstream `0.2.2-rc.3` inspected | MIT | DS-Bot runs as a DSH plugin and uses documented services | Existing copied/adapted portions are recorded in root `NOTICE` |
| `@modelcontextprotocol/client` / `@modelcontextprotocol/core` | `2.4.0` | Apache-2.0 (npm package metadata and lockfile) | Official SDK dependency for MCP clients | Package license ships in the npm artifact; root `NOTICE` has no dedicated MCP SDK paragraph at this snapshot |
| Agent Memory Repo format | head `8798cb26` | MIT | Markdown format and memory loop; no runtime code copied | Root `NOTICE` records the format inspiration under “Projects that gave us ideas” |
| DS-Bot / DSH UI and runtime dependencies | pinned by `package-lock.json` | Per package | Normal npm dependency graph | Continue release-time dependency/license audit; do not infer completeness from this ledger |

## Reference-only projects

The following projects were inspected as source-level references. **No code from them is copied by this change.**

| Project | Inspected version/commit | License | Use in this decision set |
|---|---|---|---|
| Hermes Agent | `v0.23.1`; head `e96221fa` | MIT | Design reference only |
| Hermes Bot Mode | archived head `80fee225` | MIT | Design reference only |
| OpenMausBot | `v0.1.161`; head `5c919b7a` | Apache-2.0 | Design/conformance reference only |
| OpenCode | `v2.3.0`; dev head `0fad04b3` | MIT | Design reference only |
| Goose | `v1.59.1`; canonical head `0bf8b624` | Apache-2.0 | Design reference only |
| Pi | `v1.5.2`; canonical head `22fc026b` | MIT | Design reference only |
| Obelisk | `v0.2.5`; head `cc75c2dd` | AGPL-3.0 | Design reference only; no copy or link |
| OpenViking | `v0.5.5`; head `5f53cbf0` | Server AGPL-3.0; `@openviking/sdk` 0.1.0 and `@openviking/dsh-memory-plugin` 0.5.36 Apache-2.0 | Design reference only; possible future arm’s-length external adapter, not linked into this product |
| Temporal | `v1.32.2`; head `170fb83d` | MIT | Design reference only |
| LangGraph | `1.2.22`; head `41fb001d` | MIT | Design reference only |
| LiteLLM | `v1.109.1`; head `8d200a4f` | MIT outside `litellm/enterprise/`; separate enterprise license requiring commercial authorization | Optional external gateway, no copy |
| MCP specification/SDK/servers | spec `2026-07-28`; SDK/servers `2.4.0` | Apache-2.0/MIT transition; docs CC-BY-4.0 | Official protocol/interface boundary; SDK already used |
| OpenTelemetry JS | `v3.1.1`; head `5a78e6ae` | Apache-2.0 | Use through DSH `ctx.otel`, not as a direct DS-Bot dependency |

## Notice rules for future adoption

### Direct code (A)

Before merging a copied file:

1. Pin the exact upstream commit and file path.
2. Confirm the license at that commit, including subdirectory exceptions.
3. Add the copyright and required license text to root `NOTICE`.
4. Record the copied and modified files in `THIRD_PARTY_COMPONENTS.md` and `docs/reuse/code-reuse-registry.json`.
5. Keep upstream tests that cover the copied logic, or add equivalent contract tests.
6. State the local divergence and rollback path.

### SDK or official interface (B)

1. Record the package/protocol version and official documentation.
2. Keep the dependency at the package boundary; do not copy internal source.
3. Confirm the package license and include it in the release dependency audit.
4. Keep authentication, consent, redaction and failure policy in DS-Bot/DSH, not in an unreviewed adapter.
5. Record when the SDK is used but no source is copied.

### Extracted module + adapter (C)

1. Keep the extracted module in its own directory with an explicit public interface.
2. Record the exact source and all modifications.
3. Do not import a foreign roster, session id or permission result into DS-Bot without translation.
4. Keep a feature flag and a removal path.
5. Re-run the adapter's upstream tests and DS-Bot's integration tests.

### AGPL boundary

Obelisk and the OpenViking server are not linked into the Apache-2.0 product. A future OpenViking integration can consume its Apache-2.0 DSH plugin/SDK only against an arm's-length external server, with a separate deployment and review of AGPL obligations. No AGPL file, generated asset or modified source is to be copied into this repository, and the plugin's old DSH peer-version assumptions must pass a compatibility spike first.

## Release audit checklist

- `git grep` for new third-party headers and copied source markers.
- `npm ls --all` and `package-lock.json` license review.
- Confirm every `THIRD_PARTY_COMPONENTS.md` adoption has a matching root `NOTICE` entry.
- Confirm the machine registry points to the same version and commit as the lockfile or vendored directory.
- Confirm no secret, cookie, API key, user memory or DSH_HOME content is included in a notice or provenance artifact.
- Confirm the final release contains the applicable license texts and does not imply endorsement by an upstream project.
