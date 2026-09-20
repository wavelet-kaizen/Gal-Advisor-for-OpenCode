# Gal loop recovery protocol

Applies to the main agent. The gal-advisor subagent follows its own diagnostic-only prompt.

After failed verification, ask whether new objective evidence was produced.
Stop edits and retries immediately when the same failure survives two fixes,
the same tool fails twice, three edits leave the failure unchanged, searches
repeat three times without information, a refuted hypothesis is reused,
mechanical facts are manually re-reasoned, or work drifts from the original goal.
Two distinct soft signals within eight tool calls also require consultation.
Passing tests, fewer failures, changed error class/file, and evidence-backed
refutation count as progress. Merely rephrasing a command does not.
After a recognized verification passes and the current OpenSpec task is marked [x], treat the task as a verified completion checkpoint. Do not reopen the implementation for cosmetic/speculative cleanup. Read/grep/glob, read-only git/OpenSpec discovery and recognized verification remain allowed. To modify files again, first obtain new objective evidence after the checkpoint and call gal_reopen(reason,evidence). A failing recognized verification invalidates the checkpoint automatically.
Only edits related to the located failure file count as fix attempts. If output shows a CLI flag error or a host-shell mismatch (for example POSIX syntax under PowerShell), fix the command/environment first rather than editing source files.

With the plugin: the human does not need to request goal registration explicitly. Read/glob/grep and read-only OpenSpec/git discovery may run first; before the first edit/write/patch or non-discovery bash verification, the Guard requires the main agent to register a concise current-task goal with gal_report(goal=...). Use gal_report to record hypotheses with
SUPPORTED / REFUTED / UNTESTED plus evidence IDs from gal_status. Report visible
manual_verification / contradicted_baseline signals immediately. Never inspect
or report hidden chain of thought. Semantic detection is cooperative, not guaranteed.

When triggered, invoke task with subagent_type=gal-advisor. Never provide task_id:
each consultation needs fresh context. The plugin supplies a bounded evidence packet.
Then state GAL ACCEPT or GAL REJECT. Use the decision-specific recovery tool:
gal_accept(reason,evidence) uses the Advisor NEXT and accepts no replacement move;
gal_reject(reason,evidence,next_tool,next_args) requires objective evidence and one different valid observation.
Execute the contracted call before any other operation. The Guard enters NEXT_EXECUTING and only releases after its result is observed; the tool result then contains GAL RECOVERY COMPLETE with the resulting phase.
If a mismatched NEXT is attempted, the attempted tool does not run, phase returns to CONTRACT, and the bad NEXT is cleared. Re-contract with gal_accept or gal_reject. Do NOT use REPAIR for a NEXT mismatch.
Use gal_repair only when the correct contracted tool visibly returned a tool/schema/infrastructure error but no completion hook was observed, and choose a different valid observation.
Do not silently resume the stalled approach.

Without the plugin: maintain the same packet (goal/subgoal, failure, baseline,
attempts, evidence, hypotheses), counters and contract in visible text.
Maximum two consultations per problem, and never consult again without new
evidence. At EXHAUSTED stop autonomous debugging, report facts, attempts, remaining
uncertainty and the decision needed from the user. Do not spawn another agent or
rename the problem to bypass the limit.
