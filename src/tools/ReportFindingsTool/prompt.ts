import { REPORT_FINDINGS_TOOL_NAME } from './constants.js'

export const DESCRIPTION = `Report code-review findings as a typed list so the host UI can render them.
Use this only when the active code-review instructions tell you to report findings with this tool;
otherwise follow whatever output format those instructions specify. When reporting a review's results,
call it once with the verified findings ranked most-severe first (empty array if nothing survived
verification) and do not also print the findings as text. When re-reporting after applying fixes
(only if the apply instructions ask for it), set \`outcome\` on each finding to what actually happened.`

export const PROMPT = `Report code-review findings with this tool. Call once with findings ranked most-severe first, or empty array if nothing survived verification. Do not print findings as text — use this tool instead.

Each finding must have:
- \`file\`: repo-relative path
- \`summary\`: one-sentence description of the defect
- \`failure_scenario\`: concrete inputs/state leading to wrong output or crash

Optional fields:
- \`line\`: 1-indexed line the finding anchors to
- \`category\`: short kebab-case slug (e.g. "correctness", "efficiency", "test-coverage")
- \`verdict\`: "CONFIRMED" or "PLAUSIBLE" when a verify pass ran
- \`outcome\`: "fixed" | "skipped" | "no_change_needed" — set ONLY when re-reporting after applying fixes`
