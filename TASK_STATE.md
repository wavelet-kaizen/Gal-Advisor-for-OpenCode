# Control input recovery: implementation state

Goal: prevent the reported goal-registration loop while keeping Gal control-input failures from blocking the main agent or exhausting recovery budgets. User explicitly cautioned against restoring past self-locks. Single agent; no Gal control tools available in this Codex session, so goal and evidence were recorded visibly.

Decisions / implementation:
- Normal goal registration uses only goal. Tool descriptions, argument schemas, README and AGENTS distinguish the optional strict changePath/taskIDs/requiredChecks registration. changePath is the OpenSpec directory containing tasks.md.
- Explicit ControlInputError validation failures from report/accept/reject/repair/reopen have separate advisory diagnostics. Same tool/code twice produces GAL CONTROL INPUT REPEAT with a concrete correction. This does not call observe/trigger, create an episode, change phase/contracts/completion/holds, consume consultations or add tool restrictions.
- Diagnostics persist across reload; successful correction clears them. Either contract decision clears ACCEPT/REJECT diagnostics. Transactions retire advice when phase/completion changes make that control unavailable, including late NEXT completion.
- Ordinary guard refusals, infrastructure/permission errors and host schema rejections remain excluded from this counter. Original recovery gates and consultation limits still apply.
- Strict registration prevalidates capabilities, configured IDs, tasks.md and selected tasks. Report validates all arguments before assigning goal/immutable state, preventing partial registration on failure. Existing strict state and verification results are preserved on rejected re-registration.

Changed files:
- .opencode/gal/control.ts (new), guard.ts, plugin.ts, runtime.ts
- tests/control.test.ts (new, 8 regression tests)
- README.md, AGENTS.md, TASK_STATE.md

Validation:
- Final complete suite: 94/94 passed with SDK 2.0.0 (root), 2.2.0 and 2.3.0 (existing isolated .runtime copies).
- TypeScript typecheck passed in all three environments. Final outputs are in ignored .runtime/control-root-final-*.log and .runtime/sdk-2.{2,3}.0/control-final-*.log.
- Initial permission-fixture failure was corrected by creating tasks.md before testing authorization. A regression test reproduced stale repair advice after late completion; transaction-level diagnostic pruning fixed it. No unresolved test failures or consultations.
- Root dependencies and SDK versions unchanged. Isolated source copies/logs are ignored.

Limits / next step:
- Tests exercise shared hooks and V1/V2 adapter fixtures, not a live OpenCode session. Existing Eclipse/Strata integration limits remain.
- User requested committing this improvement. Commit scope includes the implementation, regression tests, README, AGENTS instructions and this handoff. No additional implementation is pending; deployment has not been requested. When installing, copy the full .opencode/gal folder (including control.ts), the plugin, and updated instructions as documented.
