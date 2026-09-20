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
Only edits related to the located failure file count as fix attempts. If output shows a CLI flag error or a host-shell mismatch (for example POSIX syntax under PowerShell), fix the command/environment first rather than editing source files.

With the plugin: register the original goal with gal_report before verification when practical. Use gal_report to record hypotheses with
SUPPORTED / REFUTED / UNTESTED plus evidence IDs from gal_status. Report visible
manual_verification / contradicted_baseline signals immediately. Never inspect
or report hidden chain of thought. Semantic detection is cooperative, not guaranteed.

When triggered, invoke task with subagent_type=gal-advisor. Never provide task_id:
each consultation needs fresh context. The plugin supplies a bounded evidence packet.
Then state GAL ACCEPT or GAL REJECT. Call gal_recover with the decision, reason and
evidence IDs. ACCEPT automatically uses the Advisor's NEXT MOVE — next_tool and
next_args are optional (the stored recommendation is used). REJECT requires objective
evidence, a different next_tool/next_args, and an explanation of what evidence
invalidates the Advisor's suggestion. Execute the contracted call before any other
operation. The Guard enters NEXT_EXECUTING and only releases after its result is observed.
If a mismatched NEXT is attempted, use the reported expected/received delta and submit a corrected contract; the bad NEXT is cancelled automatically.
Use gal_recover decision=REPAIR only when the contracted tool visibly returned a schema/infrastructure error but no completion hook was observed, and choose a different valid observation.
Do not silently resume the stalled approach.

Without the plugin: maintain the same packet (goal/subgoal, failure, baseline,
attempts, evidence, hypotheses), counters and contract in visible text.
Maximum two consultations per problem, and never consult again without new
evidence. At EXHAUSTED stop autonomous debugging, report facts, attempts, remaining
uncertainty and the decision needed from the user. Do not spawn another agent or
rename the problem to bypass the limit.
