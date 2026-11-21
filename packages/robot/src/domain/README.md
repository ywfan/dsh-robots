# Robot domain core

The domain has no DSH dependency. `RobotCatalog` and `RobotWorkflow` use one injected
`RobotStore`. The initial store is `FileRobotStore`; it is the authoritative source,
not a second copy of a DSH storage domain. Its writer lock intentionally fails closed
if another process (or an unexamined crash lock) owns the directory. After a crash,
verify the old process has stopped before removing `writer.lock`; then open the store
and call `recoverInterruptedRuns()` before accepting new work.

## Trust boundaries

- Construct `Principal` from the authenticated server/session context. Never take
  `kind`, `ownerId`, or an approval Boolean from request JSON as authority.
- `publish`, `selectRevision`, `grantInvocation`, `setDisabled`,
  `reviewProposals`, `approveAction`, `rejectAction`, `confirmCheck`, and
  `answerQuestion` enforce human authority. Agent work must use `kind: 'agent'`
  even when the same owner ID owns the session.
- A `ReadinessReceipt` is a trusted adapter result over the exact candidate digest.
  Do not expose an endpoint which lets a client supply this receipt directly.
- `recordArtifact`, `markDispatched`, `resolveAction`, `markUncertain`, and
  `recoverInterruptedRuns` are **trusted host operations**, not model tools. Verify
  real artifacts and real tool results before issuing those receipts.
- The adapter must classify actual external actions and map its tools to workflow
  action names. A prompt claiming a tool is safe is not enforcement. Reject unmapped
  tools and fail closed when the adapter cannot intercept execution.

## Integration order

1. Call `createRobot`, then review/edit the returned draft. The draft is not runnable.
   An optional `workspacePath` binds the robot to a host-validated directory
   relative to the configured workspace root. Existing records without the field
   use the root. The binding is immutable and stays out of robot spec exports.
2. `preparePublication` returns the exact digest and base version. The adapter checks
   resources, model, required capabilities, and prepares host resources without
   moving the formal pointer. Human `publish` validates the candidate again and
   atomically installs the immutable revision; clean up any failed host preparation.
3. `start` creates a `preparing` run pinned to one revision. Create the host session,
   then `attachBinding` records the actual model/adapter/harness/session provenance.
   Passing a binding to `start` is useful for hosts which have already prepared it.
4. Each model tool is gated through `requestAction` with the concrete input and a
   human-readable summary. External actions pause for `approveAction`. Persist
   `markDispatched` with the *same input* before invoking the actual tool. Persist
   `resolveAction` with its actual receipt. Never repeat a dispatched action whose
   outcome is unknown; reconcile the external system first.
5. `advance` requires declared outcomes and all current-visit receipts. A repeated
   visit cannot use the previous visit's evidence. Unsupported situations use
   `requestQuestion`, followed by a real human `answerQuestion`.
6. Produce proposals after useful outcomes or corrections. A run's success alone
   does not certify that a finding is true. Proposal sources must belong to the
   robot and pinned revision. Human review plus readiness publishes an accepted
   proposal. Differing batch edits require a combined reviewed draft.
7. `exportRobot` emits only a declarative, integrity-checked package. `importRobot`
   validates it, then pass its spec to `createRobot`; the copy has a fresh ID, owner,
   draft, no history, no share ACL, and no runtime binding. Missing selected skills
   reject export. The caller must review actual exported text for sensitive material;
   simple source-URL checks are not a general secret detector.

## Persistence and concurrency

Every aggregate or run update uses compare-and-swap. The store serializes writes,
fsyncs a temporary file, renames it atomically, and fsyncs its directory. Published
revision prefixes and run identity cannot be rewritten, including through direct
store updates. Domain updates preserve an old run's revision when content changes.
Write failures before rename leave the previous record in place and trigger
temporary file cleanup. After acquiring the writer lock, the store also clears
its abandoned temporary records. `COMMIT_UNCERTAIN` means rename succeeded and
directory finalization failed. Read back the record and compare its version and
intended contents before retrying the operation.
`schemaVersion: 1` aggregates reject unknown storage schemas; an upgrade must supply
an explicit backed-up migration rather than silently interpreting them.

The domain does not know whether a real model obeyed instructions, a tool genuinely
ran, or a receipt was fabricated by the host. Those claims require adapter integration
and end-to-end verification. Domain tests exercise real temporary file stores and
receipt-driven state transitions; they do not count as real DSH/model tests.
