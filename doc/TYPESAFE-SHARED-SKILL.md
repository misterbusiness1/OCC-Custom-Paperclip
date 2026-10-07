# TypeSafe shared skill: installation and pilot

## Scope

Use the official `typesafe-ai` skill for developer API guidance and the shared
[`typesafe-judge`](../skills/typesafe-judge/SKILL.md) skill for operational judgments.
The existing `typesafe_judge` runtime tool is the only execution path. Paperclip
retains task ownership, company isolation, live-run authority, managed credentials,
permissions, approval gates, budgets, and execution. Agent models stay unchanged.

Automatic skill advice and background classification are separate features.
Leave their implementation intact and pause further development until direct use
shows a useful benefit. This change adds no provider client or database migration.

## Install and discover

### Official developer skill

Check the actual CTO, Commerce Engineer, and Code Quality Engineer runtime first.
A skill installed in an operator's home does not prove an agent can load it.
Inspect the agent's adapter, execution user, workspace, skill assignments, and
effective per-run skill directory. Reuse an existing complete installation.

The [official installation guide](https://docs.typesafe.ai/agent-skill) supports:

- Claude Code: `claude plugin marketplace add typesafe-ai/skills`, then
  `claude plugin install typesafe@typesafe-ai`.
- Other supported agents: `npx skills add typesafe-ai/skills --skill typesafe-ai`;
  choose the actual runtime. Installation is project-local by default.
- Manual installation: copy the entire official skill directory, including its
  references, to the runtime's supported skills directory.

Use one method, under the execution user and workspace the agent actually uses.
For Paperclip-managed skill delivery, import the official source into the company
library through the existing [company skills workflow](../skills/paperclip/references/company-skills.md),
verify immutable provenance, and attach its returned key with `mode: "add"`.
Do not duplicate an existing installation. Verify the next runtime's discovered
skill content; a successful installer command alone is insufficient.

[Jev with coding agents](https://docs.typesafe.ai/introduction/coding-agents)
explains why Jev supplements a reasoning model rather than replacing it.

### Shared operational skill

The repository's runtime bundle discovers `skills/typesafe-judge/` through the
existing bundled inventory. The company library gives it the canonical key
`paperclipai/paperclip/typesafe-judge`. No adapter implementation change is needed.
The company library and desired-skill assignment remain distinct.

On an instance running this revision:

1. Read `GET /api/companies/:companyId/skills` and confirm the canonical key and
   current version. Inspect `SKILL.md` and `pilot.json` through the skill files API.
2. For the one pilot agent, use the existing authenticated
   `POST /api/agents/:agentId/skills/sync` with:

   ```json
   {"mode":"add","desiredSkills":["paperclipai/paperclip/typesafe-judge"]}
   ```

3. Read `GET /api/agents/:agentId/skills`; confirm selection and runtime delivery.
   On Codex, inspect the next run's injected skill snapshot; a `configured` entry
   means scheduled for delivery, not proof it loaded. For Kimi with explicitly
   configured CLI engine, inspect the next run's prepared `--skills-dir` snapshot.
   For Kimi on the default ACP engine, a local task run materializes the
   selected skills into a per-run bundle under the run state directory and names
   that skill root and the selected skills in the prompt. The selected skills do not
   appear in Kimi's native skill list. A local task run also adds the task-bound
   runtime-tools MCP server ("Paperclip connections") to the run's native MCP
   server list, authorized with that run's own bearer. A conversation turn
   keeps its ACP session, so it receives the runtime tools through the
   environment only and its selected skills stay tracked only. Remote Kimi ACP targets are unchanged: selected skills stay
   tracked only and no runtime-tools MCP server is added. A persistent
   skill-sync check does not prove ACP loading or `typesafe_judge` discovery;
   inspect the run's prompt and MCP registration. A local `kimi_local` agent on
   the default ACP engine is eligible for this pilot. The complete skill
   directory must contain both files. Existing assignments stay intact.
4. Have the task-bound agent explicitly load `typesafe-judge` and enumerate its
   tools. Require `typesafe_judge` in that run's actual tool discovery.

The skill does not become mandatory or automatically selected for the fleet.

## Isolated pilot configuration

Use one existing eligible agent in an authorized isolated instance. Record its
source commit, image/build ID, adapter and engine, company/agent/task/run IDs,
skill revision, and timestamp in private evidence. Keep credentials out of the
evidence and public pull request.

Set these **only in the isolated instance**:

```dotenv
PAPERCLIP_TYPESAFE_TOOL_ENABLED=true
PAPERCLIP_TYPESAFE_TIMEOUT_MS=8000
PAPERCLIP_TYPESAFE_SKILL_SUGGESTION_ACTIVE=false
PAPERCLIP_TYPESAFE_SKILL_SUGGESTION_SHADOW=false
```

If the suggestion plugin is installed, preserve other fields but set:

```json
{
  "enabled": false,
  "activeEnabled": false,
  "issueClassificationShadowEnabled": false,
  "issueClassificationKillSwitch": true
}
```

The direct tool does not require the plugin to be installed or running. Plugin
`apiKeyRef` is not a substitute for the agent binding. The invoking agent needs
`adapterConfig.env.TYPESAFE_API_KEY` with `type: "secret_ref"`, a company-scoped
`secretId`, and an allowed version. Validate existing managed binding metadata
and permissions; never source a host API key into an agent to bypass denial.
Keep applicable OneCLI policies unchanged. A OneCLI credential alone does not
satisfy this runtime contract.

Production and fleet-wide flag changes, restarts, and deployments are separate
actions. Preserve a record of prior isolated settings and assignments for rollback.

## Pilot procedure and evidence

1. Confirm the tested revision includes PR [#139](https://github.com/misterbusiness1/paperclip/pull/139)
   and its model-validation/retry tests. A branch name is not evidence of inclusion.
2. Use a normal assigned synthetic task and let Paperclip issue its ordinary
   live-run tool authority. Do not construct tokens, reuse another run, or insert
   authority rows in the database. Existing task, approval, and budget gates apply.
3. Ask the agent to load the shared skill, read `pilot.json`, and invoke
   `typesafe_judge` once with that object. It contains independent Choice, Noul,
   and Score questions over one non-sensitive example.
4. Retain the discovery record, skill-load event or transcript, actual invocation,
   structured result, model, latency, token usage if returned, and the subsequent
   agent response. Require `ok: true` and validated answers of the requested types.
5. Exercise a controlled unavailable result in the isolated instance by disabling
   `PAPERCLIP_TYPESAFE_TOOL_ENABLED`, then starting another normal synthetic task
   after the required isolated configuration reload. The agent must report no
   available optional judgment, continue only authorized ordinary work, and make
   no alternate TypeSafe HTTP request or retry loop. Restore the pilot setting.
   Existing injected-provider runtime tests cover malformed answers without
   deliberately exhausting provider quota. They do not prove agent behavior.
6. Verify no active/shadow recommendation or classification calls occurred during
   either run. Stop the pilot and retain its records after these bounded cases.

A smoke test demonstrates the path and observed behavior only. It does not prove
accuracy, cost savings, faster task completion, or fleet readiness. Evaluate those
separately against ordinary execution before expanding use.

If the isolated build, existing agent, managed binding, or authority is missing,
record that exact missing prerequisite. Unit tests, a host API call, or a skill
file on disk cannot replace the real-agent checks above.

The current tool catalog can advertise `typesafe_judge` while execution is
disabled. In the controlled failure case, require the actual structured
`{"ok":false,"error":{"code":"disabled","retryable":false}}` result and
the agent's subsequent behavior. Do not expect the tool name to disappear.

## Rollback

Remove only the pilot's `paperclipai/paperclip/typesafe-judge` assignment using
the skill sync API with `mode: "remove"`; retain other assignments. Restore the
recorded isolated tool flag and timeout and reload that isolated instance if
needed. Keep recommendation/classification disabled unless separately authorized.
Revert the entire shared-skill PR delta to remove the shipped bundle, including
its follow-up documentation changes. If the PR was squash-merged, revert that
squash commit; otherwise revert its commits in reverse order, newest first.
Retain task history and secret bindings. No database rollback or credential
rotation is required by this change. Remove a newly installed vendor skill only if this pilot
installed it and no other agent or task depends on it.
