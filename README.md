# Approval Gate — Paperclip Plugin

Require human approval before any agent run executes.

When an agent is triggered on an issue, the plugin posts a comment and holds the run. The issue moves to **`in_review`** status so the agent can move on to other tasks. When a team member clicks **Approve**, the issue returns to `in_progress` and the agent starts working.

**Zero tokens are spent while waiting.**

```
Agent triggered on issue
         │
         ▼
Run created (approvalGate = true)
Issue status → in_review  ← agent skips it, picks up other tasks
         │
         ▼
Plugin posts comment in the issue:
  "⏸️ Approval required — click Approve to proceed"
         │
         ▼
Human clicks green Approve button in the issue
  (or replies /approve as a comment)
         │
         ▼
Issue status → in_progress
Gate cleared → heartbeat picks up the run on next tick
         │
         ▼
Agent executes ✅
```

Multiple issues can be gated simultaneously — each has its own **Approve** button and they do not block each other.

---

## Requirements

- Paperclip instance with plugin support
- Access to Paperclip server source code (to apply patches)
- Node.js 18+

---

## Installation

Follow these steps in order.

### Step 1 — Apply the DB migration

```sql
ALTER TABLE "heartbeat_runs"
  ADD COLUMN IF NOT EXISTS "approval_gate" boolean DEFAULT false NOT NULL;
```

---

### Step 2 — Patch Paperclip core

#### `packages/db/src/schema/heartbeat_runs.ts`

Add the `approvalGate` column after `processLossRetryCount`:

```ts
approvalGate: boolean("approval_gate").notNull().default(false),
```

---

#### `packages/shared/src/constants.ts`

Add to `PLUGIN_EVENT_TYPES`:

```ts
"heartbeat.run.queued",
```

Add to `PLUGIN_CAPABILITIES`:

```ts
"runs.approvalGate.clear",
```

---

#### `packages/shared/src/types/heartbeat.ts`

Add `approvalGate` to the `HeartbeatRun` interface:

```ts
approvalGate: boolean;
```

---

#### `packages/plugins/sdk/src/types.ts`

Add `PluginRunsClient` and wire it into `PluginContext`:

```ts
export interface PluginRunsClient {
  approveRun(runId: string, companyId: string): Promise<void>;
}

// In PluginContext, add after `agents`:
runs: PluginRunsClient;
```

---

#### `packages/plugins/sdk/src/protocol.ts`

In `WorkerToHostMethods`, add:

```ts
"runs.approveRun": [
  params: { runId: string; companyId: string },
  result: void,
];
```

---

#### `packages/plugins/sdk/src/host-client-factory.ts`

```ts
// In HostServices interface:
runs: { approveRun(params: { runId: string; companyId: string }): Promise<void> };

// In METHOD_CAPABILITY_MAP:
"runs.approveRun": "runs.approvalGate.clear",

// In createHostClientHandlers:
"runs.approveRun": (params) => services.runs.approveRun(params),
```

---

#### `packages/plugins/sdk/src/worker-rpc-host.ts`

Add `runs` to the plugin context:

```ts
runs: {
  approveRun: (runId: string, companyId: string) =>
    rpc.call("runs.approveRun", { runId, companyId }),
},
```

---

#### `server/src/services/heartbeat.ts`

This is the most important file. There are **two separate code paths** that create runs — both must respect the approval gate.

**a)** In `claimQueuedRun`, skip gated runs without cancelling them:

```ts
if (run.approvalGate) return null;
```

**b)** In `startNextQueuedRunForAgent`, exclude gated runs from the pick-up query:

```ts
.where(and(
  eq(heartbeatRuns.agentId, agentId),
  eq(heartbeatRuns.status, "queued"),
  eq(heartbeatRuns.approvalGate, false),   // ← add this
))
```

**c)** In `enqueueWakeup`, calculate `approvalGateEnabled` **before** both code paths (issue-scoped transaction and non-issue-scoped path). Place this right after the `bypassIssueExecutionLock` constant:

```ts
// Compute once — used in both the issue-scoped path (tx) and the non-issue-scoped path below.
const approvalGateEnabled =
  source !== "timer" &&
  parseObject(parseObject(agent.runtimeConfig).approvalGate).enabled === true;
```

**d)** Inside the issue-scoped `db.transaction`, add `approvalGate` to the run insert and move the issue to `in_review`:

```ts
// In the heartbeatRuns insert values:
approvalGate: approvalGateEnabled,

// Replace the issues.update block with:
const issueStatusPatch: Partial<typeof issues.$inferInsert> = {
  executionRunId: newRun.id,
  executionAgentNameKey: agentNameKey,
  executionLockedAt: new Date(),
  updatedAt: new Date(),
};
if (approvalGateEnabled) {
  issueStatusPatch.status = "in_review";
}
await tx
  .update(issues)
  .set(issueStatusPatch)
  .where(
    approvalGateEnabled
      ? and(eq(issues.id, issue.id), eq(issues.status, "in_progress"))
      : eq(issues.id, issue.id),
  );
```

**e)** After the issue-scoped transaction returns, fire `logActivity` and skip `startNextQueuedRunForAgent` when gated:

```ts
if (approvalGateEnabled) {
  void logActivity(db, {
    companyId: newRun.companyId,
    actorType: "system",
    actorId: "heartbeat",
    action: "heartbeat.run.queued",
    entityType: "heartbeat_run",
    entityId: newRun.id,
    agentId: newRun.agentId,
    runId: newRun.id,
    details: {
      runId: newRun.id,
      agentId: newRun.agentId,
      invocationSource: newRun.invocationSource,
      issueId: issueId ?? null,
      projectId: readNonEmptyString(enrichedContextSnapshot.projectId) ?? null,
    },
  });
} else {
  await startNextQueuedRunForAgent(agent.id);
}
```

**f)** In the non-issue-scoped path (further down in `enqueueWakeup`), add `approvalGate` to the run insert and the same `in_review` / `logActivity` logic:

```ts
// In the heartbeatRuns insert values:
approvalGate: approvalGateEnabled,

// After publishLiveEvent:
if (approvalGateEnabled) {
  const gatedIssueId = readNonEmptyString(enrichedContextSnapshot.issueId) ?? null;
  if (gatedIssueId) {
    await db
      .update(issues)
      .set({ status: "in_review", updatedAt: new Date() })
      .where(and(
        eq(issues.id, gatedIssueId),
        eq(issues.companyId, newRun.companyId),
        eq(issues.status, "in_progress"),
      ));
  }
  void logActivity(db, { /* same as above */ });
}
await startNextQueuedRunForAgent(agent.id);
```

**g)** Add `clearRunApprovalGate` to the returned service object. On approval it clears the gate **and** restores the issue to `in_progress`:

```ts
clearRunApprovalGate: async (runId: string) => {
  const run = await getRun(runId);
  if (!run || run.status !== "queued" || !run.approvalGate) return run ?? null;

  const updated = await db
    .update(heartbeatRuns)
    .set({ approvalGate: false, updatedAt: new Date() })
    .where(and(
      eq(heartbeatRuns.id, runId),
      eq(heartbeatRuns.approvalGate, true),
      eq(heartbeatRuns.status, "queued"),
    ))
    .returning()
    .then((rows) => rows[0] ?? null);

  if (updated) {
    const approvedIssueId = readNonEmptyString(
      (updated.contextSnapshot as Record<string, unknown> | null)?.issueId,
    );
    if (approvedIssueId) {
      await db
        .update(issues)
        .set({ status: "in_progress", updatedAt: new Date() })
        .where(and(
          eq(issues.id, approvedIssueId),
          eq(issues.companyId, updated.companyId),
          eq(issues.status, "in_review"),
        ));
    }
    await startNextQueuedRunForAgent(updated.agentId);
  }
  return updated ?? run;
},
```

---

#### `server/src/services/plugin-host-services.ts`

Add the `runs` namespace:

```ts
runs: {
  async approveRun(params: { runId: string; companyId: string }) {
    const companyId = ensureCompanyId(params.companyId);
    await ensurePluginAvailableForCompany(companyId);
    const run = await heartbeat.getRun(params.runId);
    if (!run || run.companyId !== companyId) {
      throw new Error(`Run not found: ${params.runId}`);
    }
    await heartbeat.clearRunApprovalGate(params.runId);
  },
},
```

---

#### `server/src/routes/agents.ts`

**a)** Add the approve endpoint next to the `/cancel` endpoint:

```ts
router.post("/heartbeat-runs/:runId/approve", async (req, res) => {
  assertBoard(req);
  const runId = req.params.runId as string;
  const run = await heartbeat.clearRunApprovalGate(runId);

  if (run) {
    await logActivity(db, {
      companyId: run.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "heartbeat.run.approved",
      entityType: "heartbeat_run",
      entityId: run.id,
      details: { agentId: run.agentId },
    });
  }

  res.json(run);
});
```

**b)** Add `approvalGate` to the `/issues/:issueId/live-runs` select:

```ts
approvalGate: heartbeatRuns.approvalGate,
```

---

#### `ui/src/api/heartbeats.ts`

Add `approvalGate` to `LiveRunForIssue` and the `approve` method:

```ts
// In LiveRunForIssue interface:
approvalGate?: boolean;

// In heartbeatsApi:
approve: (runId: string) => api.post<HeartbeatRun>(`/heartbeat-runs/${runId}/approve`, {}),
```

---

#### `ui/src/components/AgentConfigForm.tsx` — Approval Gate toggle

Adds a toggle in **Run Policy → Advanced Run Policy** so users can enable the gate without editing JSON.

Key changes:
1. Add `approvalGate: Record<string, unknown>` to the `Overlay` interface and `emptyOverlay`
2. Add it to `isOverlayDirty`
3. In `handleSave`, merge `overlay.approvalGate` into `runtimeConfig.approvalGate`
4. Add `approvalGateConfig` to the resolve-values block
5. Add a `ToggleField` in the Advanced Run Policy section

---

#### `ui/src/components/LiveRunWidget.tsx` — Approve button in issue view

When a run is waiting for approval (`status === "queued" && approvalGate === true`), show a green **Approve** button directly in the issue's Live Runs widget:

```tsx
{run.status === "queued" && run.approvalGate && (
  <button
    onClick={() => handleApproveRun(run.id)}
    disabled={approvingRunIds.has(run.id)}
    className="inline-flex items-center gap-1 rounded-full border border-green-500/30 bg-green-500/[0.08] px-2.5 py-1 text-[11px] font-medium text-green-700 transition-colors hover:bg-green-500/[0.15] dark:text-green-300 disabled:opacity-50"
  >
    <Check className="h-2.5 w-2.5" />
    {approvingRunIds.has(run.id) ? "Approving…" : "Approve"}
  </button>
)}
```

---

#### `server/src/routes/plugins.ts` — Add to bundled examples

So the plugin appears in **Settings → Plugins** with a one-click Install button:

```ts
{
  packageName: "@paperclipai/plugin-approval-gate",
  pluginKey: "paperclip.approval-gate",
  displayName: "Approval Gate",
  description: "Require human approval before any agent run executes.",
  localPath: "packages/plugins/approval-gate",
  tag: "example",
},
```

---

### Step 3 — Build Paperclip

```bash
cd /your/paperclip
pnpm build
systemctl --user restart paperclip.service
```

### Step 4 — Build this plugin

```bash
git clone https://github.com/JIemyp/paperclip-approval-gate.git
cd paperclip-approval-gate
npm install
npm run build
```

### Step 5 — Install the plugin

1. Go to **Settings → Plugins**
2. Find **Approval Gate** in the Available Plugins list
3. Click **Install**
4. Confirm the requested capabilities

### Step 6 — Enable on an agent

1. Open agent settings
2. Go to **Run Policy → Advanced Run Policy**
3. Toggle **Approval gate** on
4. Save

---

## How it looks

When the plugin is active and an agent gets a task:

1. The issue moves to **`in_review`** — agent ignores it, picks up other work
2. A comment appears on the issue asking for approval
3. A green **Approve** button appears in the Live Runs widget inside the issue
4. You click **Approve** → issue returns to `in_progress` → agent starts working

---

## Concurrent approvals

Each issue gets its own gated run with its own Approve button. They are fully independent — approving one does not affect others, and the agent freely works on non-gated tasks in the meantime.

---

## Roadmap

- `/reject` command to cancel a pending run
- Per-project gate configuration instead of per-agent
- CEO-agent approval: let a designated AI agent review and approve runs on behalf of humans
