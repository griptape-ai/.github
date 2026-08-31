import { graphql, GraphqlResponseError } from "@octokit/graphql";

const PAGE_SIZE = 100;

export function makeClient() {
  const token = process.env.PROJECTS_TOKEN;
  if (!token) {
    throw new Error("PROJECTS_TOKEN env var is required");
  }
  return graphql.defaults({
    headers: { authorization: `token ${token}` },
  });
}

export function projectCoords() {
  const owner = process.env.PROJECT_OWNER;
  const number = Number(process.env.PROJECT_NUMBER);
  if (!owner || !Number.isInteger(number)) {
    throw new Error("PROJECT_OWNER and PROJECT_NUMBER env vars are required");
  }
  return { owner, number };
}

// Resolve project ID and Status field metadata by human name so the scripts stay
// correct if the field is recreated. Only the options a script writes are
// resolved: renaming an option nothing writes must not break a sweep.
export async function loadProjectMetadata(client) {
  const { owner, number } = projectCoords();
  const data = await client(
    `
    query($owner: String!, $number: Int!) {
      organization(login: $owner) {
        projectV2(number: $number) {
          id
          fields(first: 50) {
            nodes {
              __typename
              ... on ProjectV2SingleSelectField {
                id name
                options { id name }
              }
            }
          }
        }
      }
    }
    `,
    { owner, number },
  );

  const project = data.organization?.projectV2;
  if (!project) {
    throw new Error(`Project ${owner}/projects/${number} not found or not accessible`);
  }

  const status = project.fields.nodes.find((f) => f.name === "Status");
  if (!status) {
    throw new Error("Project must have a Status field");
  }

  const statusOption = (name) => {
    const opt = status.options.find((o) => o.name === name);
    if (!opt) throw new Error(`Status option "${name}" not found`);
    return opt.id;
  };

  return {
    projectId: project.id,
    statusFieldId: status.id,
    statusOptionIds: {
      toTriage: statusOption("To Triage"),
      backlog: statusOption("Backlog"),
      inProgress: statusOption("In Progress"),
    },
  };
}

// Walk every project item, yielding the bits the sweeps care about. The Status
// value carries its own `updatedAt`, which moves only when Status changes, so it
// is the item's age in its current stage rather than a last-touched proxy.
//
// Items whose `content` field 403s (e.g. issue lives in a repo the token can't
// see) are surfaced via partial-data errors; we log the paths and use whatever
// resolved instead of failing the whole sweep.
export async function* iterateProjectItems(client) {
  const { owner, number } = projectCoords();
  let cursor = null;
  while (true) {
    let data;
    try {
      data = await client(
      `
      query($owner: String!, $number: Int!, $cursor: String) {
        organization(login: $owner) {
          projectV2(number: $number) {
            items(first: ${PAGE_SIZE}, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                isArchived
                fieldValues(first: 30) {
                  nodes {
                    __typename
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      field { ... on ProjectV2SingleSelectField { name } }
                      optionId
                      name
                      updatedAt
                    }
                  }
                }
                content {
                  __typename
                  ... on Issue {
                    id
                    number
                    state
                    repository { nameWithOwner }
                    assignees(first: 10) { nodes { login } }
                  }
                  ... on PullRequest {
                    id
                    number
                    state
                    repository { nameWithOwner }
                    assignees(first: 10) { nodes { login } }
                  }
                }
              }
            }
          }
        }
      }
      `,
      { owner, number, cursor },
    );
    } catch (err) {
      if (!(err instanceof GraphqlResponseError) || !err.response?.data) throw err;
      const nodes = err.response.data.organization?.projectV2?.items?.nodes ?? [];
      for (const e of err.errors ?? []) {
        const path = e.path ?? [];
        // Path shape we care about: organization.projectV2.items.nodes.N.content
        const idx = path[3] === "nodes" ? path[4] : null;
        const itemId = typeof idx === "number" ? nodes[idx]?.id : null;
        const suffix = itemId ? ` (item ${itemId})` : "";
        console.warn(`partial-data error at ${path.join(".")}${suffix}: ${e.message}`);
      }
      data = err.response.data;
    }

    const page = data.organization.projectV2.items;
    for (const item of page.nodes) {
      if (item.isArchived) continue;
      const status = item.fieldValues.nodes.find(
        (v) => v.__typename === "ProjectV2ItemFieldSingleSelectValue" && v.field?.name === "Status",
      );
      yield {
        id: item.id,
        statusOptionId: status?.optionId ?? null,
        statusName: status?.name ?? null,
        statusUpdatedAt: status?.updatedAt ?? null,
        contentId: item.content?.id ?? null,
        contentState: item.content?.state ?? null,
        assignees: (item.content?.assignees?.nodes ?? []).map((n) => n?.login).filter(Boolean),
        contentRef: item.content
          ? `${item.content.repository?.nameWithOwner}#${item.content.number}`
          : "(draft)",
      };
    }

    if (!page.pageInfo.hasNextPage) return;
    cursor = page.pageInfo.endCursor;
  }
}

export async function setStatus(client, projectId, statusFieldId, itemId, optionId) {
  await client(
    `
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { singleSelectOptionId: $optionId }
      }) { projectV2Item { id } }
    }
    `,
    { projectId, itemId, fieldId: statusFieldId, optionId },
  );
}

// Comment on the issue or PR behind a project item. `subjectId` is the content
// node ID, not the project item ID; draft issues have no content and cannot be
// commented on.
export async function addComment(client, subjectId, body) {
  await client(
    `
    mutation($subjectId: ID!, $body: String!) {
      addComment(input: { subjectId: $subjectId, body: $body }) {
        clientMutationId
      }
    }
    `,
    { subjectId, body },
  );
}

// Walk every open issue in the org that is NOT already on the project. Used by
// the triage sweep to pull newly created issues onto the board. Search
// excludes pull requests via `is:issue` and excludes anything already on the
// project via `-project:OWNER/NUMBER`.
export async function* searchUntriagedIssues(client) {
  const { owner, number } = projectCoords();
  const queryString = `is:issue is:open org:${owner} -project:${owner}/${number}`;
  let cursor = null;
  while (true) {
    const data = await client(
      `
      query($q: String!, $cursor: String) {
        search(query: $q, type: ISSUE, first: ${PAGE_SIZE}, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            ... on Issue {
              id
              number
              repository { nameWithOwner }
            }
          }
        }
      }
      `,
      { q: queryString, cursor },
    );

    for (const node of data.search.nodes) {
      if (!node?.id) continue;
      yield {
        contentId: node.id,
        contentRef: `${node.repository.nameWithOwner}#${node.number}`,
      };
    }

    if (!data.search.pageInfo.hasNextPage) return;
    cursor = data.search.pageInfo.endCursor;
  }
}

// Add an issue/PR to the project. Idempotent: if the item already exists, the
// API returns the existing item ID rather than erroring.
export async function addItemToProject(client, projectId, contentId) {
  const data = await client(
    `
    mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
        item { id }
      }
    }
    `,
    { projectId, contentId },
  );
  return data.addProjectV2ItemById.item.id;
}
