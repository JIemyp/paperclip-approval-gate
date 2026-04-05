# Approval Gate — Paperclip Plugin

Require human approval before any agent run executes.

When an agent is triggered on an issue, the plugin posts a comment and holds the run until a team member replies `/approve`. **No tokens are spent while waiting** — the heartbeat scheduler simply skips gated runs on every tick.

```
Agent assigned to issue
       │
       ▼
Run created (approvalGate = true)
       │
       ▼
Heartbeat sees gate → skips run (zero tokens spent)
       │
       ▼
Plugin posts comment:
  "⏸️ Approval required — reply /approve to proceed"
       │
       ▼
Human replies /approve in the issue
       │
       ▼
Plugin clears gate → heartbeat picks up run on next tick
       │
       ▼
Agent executes ✅
```

---

## Requirements

- Paperclip instance with plugin support
- Access to your Paperclip server source code (to apply 7 small patches)
- Node.js 18+ / pnpm

---

## Installation

The plugin requires small changes to the Paperclip core. Follow these steps in order.

### Step 1 — Apply the DB migration

Run this SQL against your Paperclip database:

```sql
ALTER TABLE "heartbeat_runs"
  ADD COLUMN IF NOT EXISTS "approval_gate" boolean DEFAULT false NOT NULL;
```

### Step 2 — Patch Paperclip core (7 files)

#### `packages/db/src/schema/heartbeat_runs.ts`

Add the `approvalGate` column. Find the block near `processLossRetryCount` and add after it:

```ts
approvalGate: boolean("approval_gate").notNull().default(false),
```

---

#### `packages/shared/src/constants.ts`

In `PLUGIN_EVENT_TYPES`, add `"heartbeat.run.queued"`:

```ts
export const PLUGIN_EVENT_TYPES = [
  // ... existing entries ...
  "heartbeat.run.queued",   // ← add this
  "agent.run.started",
  // ...
] as const;
```

In `PLUGIN_CAPABILITIES`, add `"runs.approvalGate.clear"`:

```ts
export const PLUGIN_CAPABILITIES = [
  // ... existing entries ...
  "runs.approvalGate.clear",   // ← add this
] as const;
```

---

#### `packages/plugins/sdk/src/types.ts`

Add the `PluginRunsClient` interface and wire it into `PluginContext`:

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

Add the capability and handler:

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

Add `runs` to the plugin context object:

```ts
runs: {
  approveRun: (runId: string, companyId: string) =>
    rpc.call("runs.approveRun", { runId, companyId }),
},
```

---

#### `server/src/services/heartbeat.ts`

**a)** In `claimQueuedRun`, add at the top of the function (before any execution logic):

```ts
if (run.approvalGate) return null; // skip without cancelling
```

**b)** In `enqueueWakeup`, after the run is inserted, add the gate logic:

```ts
const approvalGateEnabled =
  source !== "timer" &&
  parseObject(parseObject(agent.runtimeConfig).approvalGate).enabled === true;

// In the insert values:
approvalGate: approvalGateEnabled,

// After publishLiveEvent, if gate is set:
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
      issueId: readNonEmptyString(enrichedContextSnapshot.issueId) ?? null,
      projectId: readNonEmptyString(enrichedContextSnapshot.projectId) ?? null,
    },
  });
}
```

**c)** In the returned service object, add `clearRunApprovalGate`:

```ts
clearRunApprovalGate: async (runId: string) => {
  const run = await getRun(runId);
  if (!run || run.status !== "queued" || !run.approvalGate) return run ?? null;
  const updated = await db
    .update(heartbeatRuns)
    .set({ approvalGate: false, updatedAt: new Date() })
    .where(
      and(
        eq(heartbeatRuns.id, runId),
        eq(heartbeatRuns.approvalGate, true),
        eq(heartbeatRuns.status, "queued"),
      ),
    )
    .returning()
    .then((rows) => rows[0] ?? null);
  if (updated) {
    await startNextQueuedRunForAgent(updated.agentId);
  }
  return updated ?? run;
},
```

---

#### `server/src/services/plugin-host-services.ts`

Add the `runs` namespace to the plugin host services object:

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

#### `ui/src/components/AgentConfigForm.tsx` (optional — adds UI toggle)

If you want a toggle in the agent settings UI instead of editing JSON manually, apply this patch:

**a)** In the `Overlay` interface, add:
```ts
approvalGate: Record<string, unknown>;
```

**b)** In `emptyOverlay`, add:
```ts
approvalGate: {},
```

**c)** In `isOverlayDirty`, add:
```ts
Object.keys(o.approvalGate).length > 0 ||
```

**d)** In `handleSave`, extend the `runtimeConfig` merge block:
```ts
if (Object.keys(overlay.heartbeat).length > 0 || Object.keys(overlay.approvalGate).length > 0) {
  const existingRc = (agent.runtimeConfig ?? {}) as Record<string, unknown>;
  const existingHb = (existingRc.heartbeat ?? {}) as Record<string, unknown>;
  const existingAg = (existingRc.approvalGate ?? {}) as Record<string, unknown>;
  patch.runtimeConfig = {
    ...existingRc,
    ...(Object.keys(overlay.heartbeat).length > 0 ? { heartbeat: { ...existingHb, ...overlay.heartbeat } } : {}),
    ...(Object.keys(overlay.approvalGate).length > 0 ? { approvalGate: { ...existingAg, ...overlay.approvalGate } } : {}),
  };
}
```

**e)** In the resolve-values block, add:
```ts
const approvalGateConfig = !isCreate
  ? ((runtimeConfig.approvalGate ?? {}) as Record<string, unknown>)
  : {};
```

**f)** In `agent-config-primitives.tsx`, add to the `help` object:
```ts
approvalGate: "Require a human to reply /approve before any run executes. No tokens are spent while waiting.",
```

**g)** In the "Advanced Run Policy" collapsible section of `AgentConfigForm.tsx`, add after the "Wake on demand" toggle:
```tsx
<ToggleField
  label="Approval gate"
  hint={help.approvalGate}
  checked={eff("approvalGate", "enabled", approvalGateConfig.enabled === true)}
  onChange={(v) => mark("approvalGate", "enabled", v)}
/>
```

---

### Step 3 — Build Paperclip

```bash
cd /your/paperclip
pnpm build
```

### Step 4 — Clone and build this plugin

```bash
git clone https://github.com/JIemyp/paperclip-approval-gate.git
cd paperclip-approval-gate
npm install
npm run build
```

### Step 5 — Install the plugin in Paperclip UI

1. Go to **Settings → Plugins**
2. Click **Install Plugin**
3. Point it to the absolute path of `dist/manifest.js` in this repo
4. Confirm the requested capabilities
5. Click **Install**

### Step 6 — Enable the gate on an agent

1. Go to the agent's settings page
2. Open **Run Policy**
3. Expand **Advanced Run Policy**
4. Toggle **Approval gate** on
5. Save

---

## Usage

When the plugin is active, any issue assigned to a gated agent receives a comment:

> ⏸️ **Approval required** — an agent is ready to start working on this issue.
>
> Reply **`/approve`** to allow the run to proceed, or manually cancel the run from the agent panel.
>
> > Run ID: `abc-123...`

Reply with:

```
/approve
```

Or with an optional note:

```
/approve looks good, proceed
```

---

## What runs are gated?

Only **issue-scoped** runs are gated (runs triggered by issue assignment or an agent invocation with an `issueId` in context).

**Timer-based heartbeat runs** (periodic background ticks) are **not** gated — they always run without approval. This prevents blocking agents from doing routine background maintenance.

---

## Roadmap

- `/reject` command to cancel a pending run
- Per-project gate configuration instead of per-agent
- CEO-agent approval: let a designated AI agent (in "CEO role") review and approve runs on behalf of humans
