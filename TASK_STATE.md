# Reviewed loop-recovery extensions: implementation state

Goal: implement docs/loop-recovery-java-generation-spec.md, preserving OpenCode 1.18.31 and V2. Single agent. Existing user changes, including .gitignore, preserved. No Gal control tools in this session; goal/recovery evidence was recorded visibly.

Implemented:
- verification.ts: Java/JSP locations; JUnit text/XML; conservative javac/Ant verification; conflicting/missing/zero-test results cannot pass.
- config.ts/runtime.ts: validated .opencode/gal.json, registered shell/external-tool routes, asynchronous execution IDs and persisted deduplication, source/config-definition hashes, selected taskIDs/requiredChecks, stale-result invalidation.
- inspect.ts: permission-checked canonical-path bounded strict UTF-8 byte/codepoint inspection, integrated into NEXT and the Advisor two-observation budget.
- Guard schema 3 preserves schema-2 history/budgets; strict completion and one-edit/reverify recovery; preserves semantic numeric/hex evidence and ignores unrelated edits for investigation reset.
- Generation holds preserve phase/NEXT/budgets on reload and do not roll back late results. Notification adapter uses public lifecycle metadata, avoids auto-resuming the model and cleans up subscriptions/timers.
- Agent/AGENTS instructions, full-folder installation docs, example config, implementation coverage and SDK CI matrix updated.

Checks:
- Initial baseline: 70/70 tests passed.
- Final source, tested in root with SDK2.0.0 and isolated .runtime copies with SDK2.2.0/2.3.0: all 86 tests passed in each; typecheck passed in each.
- Bun entrypoint import passed. git diff --check passed.
- Official v2.2.0 permission source confirms permission.assert. Runtime capability detection preserves old hosts and fails closed for new permission-dependent functionality.
- Interim failures were resolved with objective progress: type collisions/missing API; Node strip-only constructor syntax; host-level strict reopen prematurely re-arming. No unresolved test failures, no consultations, no OpenSpec completion checkpoint.

Limits / next integration inputs:
- Actual Eclipse response schemas and a real OpenCode2.2 patch + Strata cancellation confirmation are unavailable. External adapters are configured and fixture-tested; no real Eclipse/Strata session exercised.
- Generation interrupt mode is rejected. Holds are internal tested foundations, not a connected cancellation/resume feature. Notification mode is optional (default off), advisory and not proof of semantic looping. No hidden reasoning content is processed.
- V2 hosts lacking permission.assert cannot use the new inspection/strict completion; V1 inspection uses ToolContext.ask. Only strict UTF-8 decoding is implemented; unknown dump provenance is not inferred.
- Root dependencies stay pinned. Isolated SDK projects and logs are ignored. Next substantive work requires real host/tool integration evidence for the explicitly gated functionality.

User requested committing the implementation with docs/ ignored. Added docs/ to .gitignore, preserved the existing tmp/ exclusion, and removed the README link to the untracked local specification. Commit scope includes implementation, tests, CI, setup documentation and this handoff; local docs/logs/dependency caches are excluded. No runtime changes after the verified 86-test SDK matrix.
