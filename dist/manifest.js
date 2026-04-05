export const manifest = {
    id: "paperclip.approval-gate",
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Approval Gate",
    description: "Requires human approval before any agent run executes. " +
        "When an agent is about to start a run, the plugin posts an approval comment " +
        "on the issue and holds the run until a team member replies /approve.",
    author: "Paperclip",
    categories: ["automation"],
    entrypoints: {
        worker: "./dist/index.js",
    },
    capabilities: [
        "events.subscribe",
        "issues.read",
        "issue.comments.read",
        "issue.comments.create",
        "agents.read",
        "runs.approvalGate.clear",
        "plugin.state.read",
        "plugin.state.write",
    ],
};
//# sourceMappingURL=manifest.js.map