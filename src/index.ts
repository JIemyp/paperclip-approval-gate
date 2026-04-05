/**
 * Approval Gate Plugin
 *
 * Holds every agent run in a gated (queued-but-not-executing) state until a
 * human team member explicitly approves it by posting "/approve" in the issue
 * comment thread.
 *
 * ## How it works
 *
 * 1. The Paperclip core server creates the heartbeat run with `approvalGate = true`
 *    whenever the assignee agent has `runtimeConfig.approvalGate.enabled = true`.
 * 2. The heartbeat scheduler skips gated runs — no tokens are spent.
 * 3. This plugin receives the `heartbeat.run.queued` event and posts an approval
 *    request comment on the associated issue.
 * 4. When a human member comments "/approve" (or "/approve <reason>"), the plugin
 *    calls `ctx.runs.approveRun()` to clear the gate.
 * 5. The heartbeat scheduler picks up the now-ungated run and executes it.
 *
 * ## Enabling the gate on an agent
 *
 * Set the following in the agent's Runtime Config (JSON):
 * ```json
 * { "approvalGate": { "enabled": true } }
 * ```
 *
 * This can be done from the agent settings page in the Paperclip UI.
 *
 * ## Approval commands (post as a comment on the issue)
 *
 * - `/approve`          — approve the pending run
 * - `/approve <note>`   — approve with an optional note
 * - `/reject`           — cancel the pending run (not yet supported; cancel manually)
 */

import { definePlugin } from "@paperclipai/plugin-sdk";

/**
 * State key used to track the pending run for an issue.
 * Stored as:  ctx.state  scopeKind="issue"  stateKey="pendingApprovalRun"
 * Value: { runId: string; agentId: string; postedAt: string }
 */
const PENDING_APPROVAL_KEY = "pendingApprovalRun";

export default definePlugin({
  async setup(ctx) {
    // -------------------------------------------------------------------------
    // 1. Intercept new gated runs
    // -------------------------------------------------------------------------
    ctx.events.on("heartbeat.run.queued", async (event) => {
      const { runId, agentId, issueId } = event.payload as {
        runId: string;
        agentId: string;
        issueId?: string | null;
      };

      // Timer-triggered heartbeats have no issueId — skip them (no gating for
      // periodic background tasks, only for issue-scoped work).
      if (!issueId) {
        ctx.logger.debug("heartbeat.run.queued: no issueId, skipping approval gate", { runId });
        return;
      }

      ctx.logger.info("heartbeat.run.queued: posting approval request", { runId, agentId, issueId });

      // Persist pending state so the comment handler knows which run to approve.
      await ctx.state.set(
        { scopeKind: "issue", scopeId: issueId, stateKey: PENDING_APPROVAL_KEY },
        { runId, agentId, postedAt: new Date().toISOString() },
      );

      // Post the approval request comment.
      try {
        await ctx.issues.createComment(
          issueId,
          [
            "⏸️ **Approval required** — an agent is ready to start working on this issue.",
            "",
            "Reply **`/approve`** to allow the run to proceed, or manually cancel the run from the agent panel.",
            "",
            `> Run ID: \`${runId}\``,
          ].join("\n"),
          event.companyId,
        );
      } catch (err) {
        ctx.logger.error("Failed to post approval comment", {
          runId,
          issueId,
          err: String(err),
        });
      }
    });

    // -------------------------------------------------------------------------
    // 2. Watch for approval comments
    // -------------------------------------------------------------------------
    ctx.events.on("issue.comment.created", async (event) => {
      // Ignore comments made by agents — only human approvals are accepted.
      if (event.actorType === "agent") return;

      const issueId = event.entityId;
      if (!issueId) return;

      const body: string = ((event.payload as Record<string, unknown>)?.body as string) ?? "";
      const trimmed = body.trim();

      if (!trimmed.startsWith("/approve")) return;

      // Look up the pending run for this issue.
      const pending = (await ctx.state.get({
        scopeKind: "issue",
        scopeId: issueId,
        stateKey: PENDING_APPROVAL_KEY,
      })) as { runId: string; agentId: string; postedAt: string } | null;

      if (!pending) {
        ctx.logger.debug("/approve received but no pending run found", { issueId });
        return;
      }

      ctx.logger.info("Approving run", {
        runId: pending.runId,
        issueId,
        approvedBy: event.actorId,
      });

      // Clear the approval gate — the heartbeat will pick up the run on the
      // next tick.
      try {
        await ctx.runs.approveRun(pending.runId, event.companyId);
      } catch (err) {
        ctx.logger.error("Failed to approve run", {
          runId: pending.runId,
          err: String(err),
        });
        return;
      }

      // Clear persisted pending state.
      await ctx.state.delete({
        scopeKind: "issue",
        scopeId: issueId,
        stateKey: PENDING_APPROVAL_KEY,
      });

      ctx.logger.info("Run approved and gate cleared", { runId: pending.runId });
    });
  },
});
