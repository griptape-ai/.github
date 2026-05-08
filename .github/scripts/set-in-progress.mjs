// Reconcile project items into "In Progress" when they are scheduled and claimed.
//
// Rule: if an item is in the current Iteration AND has at least one assignee
// AND its Status is currently "Backlog", flip Status to "In Progress".
//
// This intentionally only moves Backlog -> In Progress. The reverse direction
// (In Progress -> Backlog when iteration ends) is handled by iteration-rollover.

import {
  makeClient,
  loadProjectMetadata,
  currentIterationId,
  iterateProjectItems,
  setStatus,
} from "./project-helpers.mjs";

const DRY_RUN = process.env.DRY_RUN === "true";

async function main() {
  const client = makeClient();
  const meta = await loadProjectMetadata(client);
  const currentId = currentIterationId(meta.iterations);
  if (!currentId) {
    console.log("No active iteration covers today; nothing to reconcile.");
    return;
  }

  let scanned = 0;
  let flipped = 0;
  for await (const item of iterateProjectItems(client)) {
    scanned += 1;
    if (item.statusOptionId !== meta.statusOptionIds.backlog) continue;
    if (item.iterationId !== currentId) continue;
    if (item.assigneeCount === 0) continue;

    flipped += 1;
    console.log(
      `${DRY_RUN ? "[dry-run] " : ""}${item.contentRef}: Backlog -> In Progress`,
    );
    if (!DRY_RUN) {
      await setStatus(
        client,
        meta.projectId,
        meta.statusFieldId,
        item.id,
        meta.statusOptionIds.inProgress,
      );
    }
  }

  console.log(`Scanned ${scanned} items, flipped ${flipped} to In Progress.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
