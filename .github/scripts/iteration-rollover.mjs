// Sweep "In Progress" items whose iteration has ended and move them back to
// "Backlog", clearing the Iteration field.
//
// Rationale: "In Progress" without a future or current iteration means the
// work was claimed but slipped past its sprint. Returning it to Backlog forces
// a deliberate replan rather than letting it sit as silent rot.
//
// Items in "In Review" / "Done" / "Blocked" are left alone. Items whose
// iteration is still active or in the future are left alone.

import {
  makeClient,
  loadProjectMetadata,
  iterateProjectItems,
  setStatus,
  clearIteration,
  isIterationEnded,
} from "./project-helpers.mjs";

const DRY_RUN = process.env.DRY_RUN === "true";

async function main() {
  const client = makeClient();
  const meta = await loadProjectMetadata(client);

  let scanned = 0;
  let rolledOver = 0;
  for await (const item of iterateProjectItems(client)) {
    scanned += 1;
    if (item.statusOptionId !== meta.statusOptionIds.inProgress) continue;
    if (!item.iterationValue) continue;
    if (!isIterationEnded(item.iterationValue)) continue;

    rolledOver += 1;
    console.log(
      `${DRY_RUN ? "[dry-run] " : ""}${item.contentRef}: In Progress (${item.iterationValue.title}) -> Backlog (iteration cleared)`,
    );
    if (!DRY_RUN) {
      await setStatus(
        client,
        meta.projectId,
        meta.statusFieldId,
        item.id,
        meta.statusOptionIds.backlog,
      );
      await clearIteration(client, meta.projectId, meta.iterationFieldId, item.id);
    }
  }

  console.log(`Scanned ${scanned} items, rolled ${rolledOver} back to Backlog.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
