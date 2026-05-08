// Pull every open issue in the org that isn't already on the project onto the
// board with Status = "To Triage".
//
// Rationale: humans should never have to remember to add their issue to the
// project. The search query `is:issue is:open org:OWNER -project:OWNER/NUMBER`
// returns exactly the issues that need to be triaged, so this script is
// idempotent: nothing to do once everything is on the board, and any issue
// opened in any repo (including new repos) lands on the board on the next run.
//
// Pull requests are intentionally excluded (`is:issue`); the project's
// built-in "PR opened -> In Review" workflow handles those.

import {
  makeClient,
  loadProjectMetadata,
  searchUntriagedIssues,
  addItemToProject,
  setStatus,
} from "./project-helpers.mjs";

const DRY_RUN = process.env.DRY_RUN === "true";

async function main() {
  const client = makeClient();
  const meta = await loadProjectMetadata(client);

  let scanned = 0;
  let added = 0;
  for await (const issue of searchUntriagedIssues(client)) {
    scanned += 1;
    console.log(
      `${DRY_RUN ? "[dry-run] " : ""}${issue.contentRef}: add to project + Status = To Triage`,
    );
    if (!DRY_RUN) {
      const itemId = await addItemToProject(client, meta.projectId, issue.contentId);
      await setStatus(
        client,
        meta.projectId,
        meta.statusFieldId,
        itemId,
        meta.statusOptionIds.toTriage,
      );
    }
    added += 1;
  }

  console.log(`Scanned ${scanned} untriaged issues, added ${added} to project.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
