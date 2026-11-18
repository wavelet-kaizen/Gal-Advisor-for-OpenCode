// Only explicit argument errors enter the advisory control-input counter.
// Guard refusals, host permission failures and infrastructure errors must not.
export class ControlInputError extends Error {
  readonly code:string;
  readonly nextAction:string;
  constructor(code:string,message:string,nextAction:string) {
    super(message);this.code=code;this.nextAction=nextAction;
  }
}

export const normalGoalHelp='For normal goal registration call gal_report with only {"goal":"one current task"}. Omit changePath, taskIDs and requiredChecks together. Do not add checks or change configuration merely to register a normal goal.';
export const strictHelp='Strict completion is optional. To request it, supply all three: changePath = OpenSpec change directory containing tasks.md (not a source file), taskIDs = selected task IDs, requiredChecks = IDs registered in .opencode/gal.json. '+normalGoalHelp;
