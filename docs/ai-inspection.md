# AI protocols and built-in host inspection

The AI panel has Chat and Inspection views. Both use the saved AI configuration.
Choose an API protocol in AI Settings, enter its API key and optional base URL,
fetch or enter a model name, and save before starting a task.

| Protocol | Default base URL | Credentials |
| --- | --- | --- |
| OpenAI compatible | https://api.openai.com/v1 | Bearer API key |
| Anthropic / Claude | https://api.anthropic.com/v1 | x-api-key |
| Google Gemini | https://generativelanguage.googleapis.com/v1beta | x-goog-api-key |
| Ollama | http://localhost:11434 | Optional Bearer API key |

OpenAI-compatible providers such as DeepSeek, Qwen, GLM and API gateways use
their own base URL and model names. Native Anthropic and Gemini use native
streaming and tool-message formats. Model-list availability depends on the
provider/gateway; a model can also be entered manually. Gemini model pagination
filters out embedding-only models. Opaque Gemini function thought signatures
are preserved across tool turns. No cloud account or subscription is supplied
by gxShell.

Existing OpenAI/custom configurations remain usable. Changing the protocol or
API address requires an explicit API key instead of forwarding a masked stored
key to a different endpoint. API keys remain in the existing secure store and
are sent in headers, never in Gemini query strings. Redirects to a different
API origin are rejected to avoid forwarding credentials.

## Host inspection

1. Connect one remote SSH server and select it in the Inspection view.
2. Start inspection and confirm its target and data access in the native dialog.
3. The built-in workflow reads system/CPU information, load, disk, memory,
   failed systemd units or OpenRC status, listening TCP ports, and containers.
4. The model analyzes that evidence and may make at most three follow-up rounds,
   each with at most three queries. The final model turn is report-only.
5. View the report, expand evidence, or copy the report. Previous reports remain
   available in local history.

The workflow is defined in backend/workflow, not downloaded from a model.
The common backend-owned query tools are inspect_check and inspect_service.
Disk diagnosis additionally exposes inspect_disk for a fixed scope enum.
Service identifiers are validated before command construction.
No arbitrary commands, file paths, restarts, configuration edits, installations,
or privilege escalation are accepted. Repeated queries reuse existing evidence.

Tasks pin their SSH session, profile, model, protocol and API configuration.
Switching a chat, terminal or AI configuration cannot retarget an active task.
There is one active inspection per server, a five-minute task deadline, a
20-second query deadline, and bounded evidence/report output. Stop propagates
cancellation to the model request and SSH exec channel; channel closure does not
prove the remote command or detached children stopped.

Collected means output was obtained, not that a service or resource is healthy.
Missing utilities, denied access, transport failures and truncated output remain
visible as unavailable or incomplete evidence. Docker/systemd need not exist on
every host. Model conclusions should be checked against the evidence, especially
when recommending changes.

## Structured reports and export

New reports use a versioned document containing a summary, fixed check overview,
severity-ranked findings with impact and recommendations, and unconfirmed items.
Version 2 additionally requires an AI assessment, one to four evidence-linked
insights, prioritized next checks and assessment limitations. Healthy hosts
still receive an operational opinion explaining why readings matter and where
verification is worthwhile. Insights distinguish supported interpretations,
possible explanations and uncertainty. These are public diagnostic explanations,
not the model's private reasoning stream. Unsupported causes cannot become
confirmed findings merely because the model proposes them.
The backend validates check identifiers and evidence references before accepting
conclusions. Missing/truncated evidence stays unconfirmed. A successful empty
failed-unit query explicitly means no failed systemd units were reported.
Disk usage, memory and load measurements are extracted from collected output,
separately from model interpretation.

The sidebar shows the report summary. View Full Report opens the formal document
with its host, report ID, timestamp and duration. Evidence references open and
scroll to the corresponding output. Export MD opens a native save dialog and
writes the complete report including evidence; Copy Report copies the same
Markdown. Default filenames contain the host, timestamp and report ID.

New reports use the interface language captured when the task starts. Chinese
prose is validated before acceptance. A malformed or wrong-language answer gets
one formatting-only retry with tools disabled, within the existing task deadline.
If that fails, the partial structured report preserves the evidence. Commands,
service names and raw logs retain their original text. Historical Markdown
reports remain readable and exportable without automatic translation.

## Service access diagnosis

Select Service Cannot Be Accessed and enter the service name and TCP port.
The fixed workflow reads system information, failed services, listeners, the
selected service status and 80 recent journal lines, then probes 127.0.0.1
on that port from the server using bounded nc or bash/timeout commands.
Inputs are validated and pinned. There are still at most three follow-up rounds.
The model cannot supply probe addresses, URLs, ports or arbitrary commands.

A successful local connection does not establish public reachability, DNS,
firewall state or socket ownership. Unavailable tools and permissions are
unconfirmed rather than faults. The current step and every executed follow-up
query include an explanation.

## Disk space diagnosis

Select Disk Space Diagnosis to collect filesystem usage, inode usage, directory
sizes, journal size and Docker storage. Directory scans are limited to
/var/log, /var/cache, /var/lib/docker, /home and /tmp, stay on each filesystem,
and stop after 12 seconds. They use idle I/O priority and niceness when available;
without timeout the scan is unavailable. Scanning a large tree still performs
I/O. Missing directories, permissions and partial scans remain unconfirmed.
No files are removed by diagnosis.

Measured disk/inode usage at 90% is flagged for attention and at 95% as critical.
An inactive selected service and failed local TCP probe are also reconciled
against collected evidence, even when a model claims the checks are healthy.
These measurements remain visible if model report generation fails.

## Human review

Each unconfirmed item has a Manually Verified checkbox, result selector
(Normal, Confirmed Issue, Not Applicable), optional note and Save Confirmation.
Unchecking and saving withdraws a confirmation. The report tracks outstanding
items and shows Manually Reviewed when all have been addressed. A confirmed
issue remains visible as attention.

Reviews are separate from the original AI verdict, measurements and evidence.
The local OS account and time are recorded for each save/withdrawal; the
renderer cannot choose the reviewer. Reviews survive restart and appear in
Markdown export and copy. New diagnoses start with their own review state.
This is local application history, not a cryptographically signed attestation.

## Report follow-ups and host background

Continue Report Analysis creates a new task linked to the original report.
It includes the user's question, the original summary/assessment and the latest
sample for each previously collected query. Inherited samples retain their
source report/evidence IDs and collection times. Selecting focused evidence
refreshes that query first; the model can request additional predefined queries
within the existing three-round budget. A repeated query runs at most once in
the new task. New samples supersede historical samples for current check
conclusions, while the old output remains inspectable.

The native dialog confirms the original SSH connection, model, question and
data access. A disconnected/replaced connection requires a fresh report.
The original report, review state and action plans are preserved. Follow-ups
have their own review/feedback state. No arbitrary shell commands, paths or
probe addresses are accepted. Listener queries include process attribution
when current permissions permit; missing attribution remains uncertain.

Host Background records a saved server's purpose, environment, expected
services/TCP ports, container expectation and notes. It is local editable
background, not a replacement for current health evidence. Each save/clear has
a revision, local OS reviewer and time, with previous revisions retained.
Optimistic revision checks prevent overwriting a newer edit. A confirmed
uncertainty can open the background editor with its report/item as source;
the user reviews and saves that expectation explicitly. Unconfirmed sources
and sources from another server are rejected.

Every new inspection/follow-up captures the current background revision before
execution. Later edits cannot silently change that task's context. The captured
background is sent to the selected model and included in the report/MD export.
Clearing background affects future tasks; historical report snapshots remain.
Stored background and feedback do not train the model or automatically turn
past healthy measurements into permanent facts.

## Comparison and action plans

A full report can select an earlier report for the same saved server and
workflow (including service and port). Comparison uses collected evidence,
not model prose: filesystem usage, inodes, fixed directory sizes, memory,
load, listening addresses, failed units and selected service state as applicable.
Incomplete/truncated evidence is explicitly inconclusive. It does not establish
the cause of a change. The comparison is stored with the current report.

Two backend-owned plans are available when their required evidence is complete:

- Restart the selected loaded service after a service diagnosis.
- Vacuum archived system journals older than seven days after a disk diagnosis.
  This permanently removes those archived logs. Active journals are excluded.

Generate a plan, review its exact command and impact, then choose Review and
Execute. A native dialog confirms the original SSH target, command, impact and
model used for the new diagnosis. Plans use current account permissions without
elevation; models and the renderer cannot supply arbitrary commands. An action
and another inspection/action cannot run concurrently on the same server.

Execution records output, exit code and remote outcome, then starts a separate
read-only diagnosis linked from the plan. Command success does not mean the
problem is fixed. Lost connections, interrupted execution and uncertain
outcomes do not replay the modifying command. A failed verification start is
recorded explicitly. On app restart an unfinished action becomes Unknown.

## History and failure behavior

Tasks and redacted evidence are written atomically under the gxShell data
directory's inspections folder, one JSON file per run, after each transition.
The UI lists the latest 30 records; older files are preserved. API keys and SSH
credentials are not part of the task schema. Known credentials and conventional
secret patterns are scrubbed before output goes into history or model context.
This is not a guarantee that all sensitive application log content is detected.

Cancellation, model failure and timeout preserve collected evidence and generate
a partial report. History write failures are shown explicitly while the current
report and evidence remain available in memory. Tasks found unfinished on startup are marked interrupted and
are never automatically re-executed. Start a new inspection to obtain fresh
evidence. Inspection is a desktop feature; it requires gxShell to be running.

## Diagnostic trace, feedback and model evaluation

Reports record query/model/validation steps with their reason, evidence IDs,
duration, outcome, error and model token usage. Interrupted steps are marked
explicitly. Raw evidence remains available through its links; private model
reasoning and full credential-bearing request payloads are not stored as trace.
The trace and feedback are also included in MD export.

Diagnostic Feedback supports Correct Assessment, False Alarm and Missed Issue.
False alarms/missed issues require a description. Feedback is independently
audited under the report without overwriting AI opinions or measurements.

Model Diagnostic Evaluation uses the currently saved model with four selectable
fixed fixtures: a healthy host, 98% disk usage, an inactive service/unreachable
local port, and missing Docker. It executes no SSH commands or tools.
Each case makes one bounded model call with simulated evidence and saves the
raw answer, expected/actual check states, format/reference validation, analysis
presence, tokens and duration. Results record model/protocol, case version and
prompt version, allowing comparisons after changing models or prompts.

Check accuracy is calculated from the original model answer BEFORE deterministic
report rules correct it. A model that misses disk pressure therefore loses the
case even if the runtime report would correct the status. The evaluation does
not semantically prove every narrative root-cause opinion or cover all Linux
environments. Cases, prompts and real-world feedback must continue to evolve.
Evaluation history survives restart; unfinished runs are marked interrupted
and are not automatically retried. The fixture data is sent to the selected API,
and normal provider token charges may apply.

## Validation

Local tests exercise native request schemas, authentication headers, model-list
pagination, streaming tool argument assembly, function-result round trips and
Gemini thought signatures. Incomplete/truncated tool streams do not authorize
execution. Workflow tests cover query restrictions, cancellation, target/model
pinning, round limits, secret redaction and interrupted-history recovery.
UI tests cover remote target selection, history, stopping the exact task and
progress events arriving before a start response, human review/withdrawal,
save errors, stale revisions, compatible baselines, plan IDs and verification
navigation.
Additional tests cover required AI opinions and citation validation, fresh
follow-up evidence replacing old conclusions, frozen background revisions,
cross-server/source rejection, save failures, feedback audit and raw-model
evaluation scoring without SSH execution.

The local fault fixture uses real loopback TCP/SSH channels through the app's
query executor, returning controlled Linux-shaped results: disk usage at 98%,
an inactive service, an incorrect listening port, failed local TCP and missing
Docker. The simulated model deliberately claims healthy checks to exercise
backend reconciliation. These are transport/diagnosis fixture tests, not live
Linux command or production-server tests. Actual Linux commands and real model
diagnostic quality still need a dedicated disposable Linux environment.

Provider protocol tests use local simulated servers. Successful live API calls
still depend on the user's endpoint, model, credentials and account access.

Protocol references:

- [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- [Anthropic streaming Messages](https://platform.claude.com/docs/en/api/messages-streaming)
- [Gemini GenerateContent](https://ai.google.dev/api/generate-content)
