import { API_VERSION } from "./constants";
import {
  ConnectionSettings,
  DiscussionComment,
  Identity,
  WorkItemDetails,
  WorkItemFilters,
  WorkItemSummary
} from "./models";

interface AzureList<T> {
  count: number;
  value: T[];
}

interface WiqlResult {
  workItems: Array<{ id: number; url: string }>;
}

interface AzureWorkItem {
  id: number;
  url: string;
  fields: Record<string, unknown>;
}

interface AzureComment {
  id: number;
  parentCommentId?: number;
  text?: string;
  renderedText?: string;
  createdBy?: unknown;
  createdDate?: string;
  modifiedDate?: string;
  isDeleted?: boolean;
}

interface AzureCommentList {
  count: number;
  totalCount: number;
  comments: AzureComment[];
}

export class AzureDevOpsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly details?: string
  ) {
    super(message);
    this.name = "AzureDevOpsError";
  }
}

export class AzureDevOpsClient {
  private readonly baseUrl: string;
  private readonly organization: string;

  constructor(
    private readonly settings: ConnectionSettings,
    private readonly pat: string
  ) {
    this.organization = normalizeOrganization(settings.organization);
    this.baseUrl = `https://dev.azure.com/${encodeURIComponent(this.organization)}`;
  }

  async getCurrentUser(signal?: AbortSignal): Promise<Identity> {
    const profile = await this.request<Record<string, unknown>>(
      `https://vssps.dev.azure.com/${encodeURIComponent(this.organization)}/_apis/profile/profiles/me?api-version=7.1`,
      { signal }
    );
    return toIdentity(profile);
  }

  async searchIdentities(query: string, signal?: AbortSignal): Promise<Identity[]> {
    if (query.trim().length < 2) {
      return [];
    }
    const result = await this.request<Record<string, unknown>>(
      `https://vssps.dev.azure.com/${encodeURIComponent(this.organization)}/_apis/IdentityPicker/Identities?api-version=7.1-preview.1`,
      {
        method: "POST",
        body: JSON.stringify({
          query: query.trim(),
          identityTypes: ["user"],
          operationScopes: ["ims", "source"],
          options: { MinResults: 1, MaxResults: 12 }
        }),
        signal
      }
    );
    const rawResults = Array.isArray(result.results) ? result.results : [];
    return rawResults.flatMap((bucket) => {
      if (!bucket || typeof bucket !== "object") {
        return [];
      }
      const identities = (bucket as Record<string, unknown>).identities;
      return Array.isArray(identities) ? identities.map(toIdentityPickerIdentity) : [];
    });
  }

  async searchWorkItems(filters: WorkItemFilters, signal?: AbortSignal): Promise<WorkItemSummary[]> {
    const clauses = ["[System.TeamProject] <> ''"];
    if (this.settings.project) {
      clauses.push(`[System.TeamProject] = '${escapeWiql(this.settings.project)}'`);
    }
    if (filters.assignedToMe) {
      clauses.push("[System.AssignedTo] = @Me");
    }
    if (filters.states.length) {
      clauses.push(`[System.State] IN (${filters.states.map(quoteWiql).join(", ")})`);
    }
    if (filters.types.length) {
      clauses.push(`[System.WorkItemType] IN (${filters.types.map(quoteWiql).join(", ")})`);
    }
    if (filters.query.trim()) {
      const query = escapeWiql(filters.query.trim());
      if (/^#?\d+$/.test(query)) {
        clauses.push(`[System.Id] = ${query.replace("#", "")}`);
      } else {
        clauses.push(`([System.Title] CONTAINS '${query}' OR [System.Tags] CONTAINS '${query}')`);
      }
    }

    const orderBy = filters.sort === "updated-asc"
      ? "[System.ChangedDate] ASC"
      : filters.sort === "id-desc"
        ? "[System.Id] DESC"
        : filters.sort === "id-asc"
          ? "[System.Id] ASC"
          : filters.sort === "title"
            ? "[System.Title] ASC"
            : "[System.ChangedDate] DESC";
    const wiql = `SELECT [System.Id] FROM WorkItems WHERE ${clauses.join(" AND ")} ORDER BY ${orderBy}`;
    const queryResult = await this.request<WiqlResult>(this.projectApiUrl("wit/wiql"), {
      method: "POST",
      body: JSON.stringify({ query: wiql }),
      signal
    });
    const ids = queryResult.workItems.slice(0, this.settings.pageSize).map((item) => item.id);
    if (!ids.length) {
      return [];
    }
    const fields = [
      "System.Id",
      "System.TeamProject",
      "System.Title",
      "System.WorkItemType",
      "System.State",
      "System.AssignedTo",
      "System.ChangedDate",
      "System.Tags"
    ].join(",");
    const items = await this.request<AzureList<AzureWorkItem>>(
      this.apiUrl(`wit/workitems?ids=${ids.join(",")}&fields=${encodeURIComponent(fields)}&errorPolicy=Omit`),
      { signal }
    );
    return sortWorkItems(items.value.map(toWorkItemSummary), filters.sort);
  }

  async getWorkItems(ids: number[], signal?: AbortSignal): Promise<WorkItemSummary[]> {
    const safeIds = [...new Set(ids)].filter(Number.isSafeInteger).slice(0, 200);
    if (!safeIds.length) {
      return [];
    }
    const fields = [
      "System.Id",
      "System.TeamProject",
      "System.Title",
      "System.WorkItemType",
      "System.State",
      "System.AssignedTo",
      "System.ChangedDate",
      "System.Tags"
    ].join(",");
    const result = await this.request<AzureList<AzureWorkItem>>(
      this.apiUrl(`wit/workitems?ids=${safeIds.join(",")}&fields=${encodeURIComponent(fields)}&errorPolicy=Omit`),
      { signal }
    );
    return result.value.map(toWorkItemSummary);
  }

  async getWorkItem(id: number, signal?: AbortSignal): Promise<WorkItemDetails> {
    const item = await this.request<AzureWorkItem>(this.apiUrl(`wit/workitems/${id}?$expand=Fields`), { signal });
    const summary = toWorkItemSummary(item);
    return {
      ...summary,
      description: fieldString(item.fields, "System.Description"),
      acceptanceCriteria: fieldString(item.fields, "Microsoft.VSTS.Common.AcceptanceCriteria"),
      areaPath: fieldString(item.fields, "System.AreaPath"),
      iterationPath: fieldString(item.fields, "System.IterationPath")
    };
  }

  async getComments(id: number, project: string, signal?: AbortSignal): Promise<DiscussionComment[]> {
    const result = await this.request<AzureCommentList>(
      this.scopedApiUrl(project, `wit/workItems/${id}/comments?$top=200&$expand=renderedText&order=asc`, "7.1-preview.4"),
      { signal }
    );
    return result.comments.map(toComment).filter((comment) => !comment.isDeleted);
  }

  async addComment(id: number, project: string, text: string, signal?: AbortSignal): Promise<DiscussionComment> {
    const comment = await this.request<AzureComment>(
      this.scopedApiUrl(project, `wit/workItems/${id}/comments?format=html`, "7.1-preview.4"), {
      method: "POST",
      body: JSON.stringify({ text }),
      signal
      }
    );
    return toComment(comment);
  }

  async deleteComment(workItemId: number, project: string, commentId: number, signal?: AbortSignal): Promise<void> {
    await this.request<unknown>(
      this.scopedApiUrl(project, `wit/workItems/${workItemId}/comments/${commentId}`, "7.1-preview.4"),
      { method: "DELETE", signal }
    );
  }

  getWorkItemWebUrl(id: number, project: string): string {
    return `${this.baseUrl}/${encodeURIComponent(project)}/_workitems/edit/${id}`;
  }

  private apiUrl(path: string): string {
    return `${this.baseUrl}/_apis/${path}${path.includes("?") ? "&" : "?"}api-version=${API_VERSION}`;
  }

  private projectApiUrl(path: string): string {
    const project = this.settings.project ? `/${encodeURIComponent(this.settings.project)}` : "";
    return `${this.baseUrl}${project}/_apis/${path}?api-version=${API_VERSION}`;
  }

  private scopedApiUrl(project: string, path: string, version = API_VERSION): string {
    const separator = path.includes("?") ? "&" : "?";
    return `${this.baseUrl}/${encodeURIComponent(project)}/_apis/${path}${separator}api-version=${version}`;
  }

  private async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(`:${this.pat}`, "utf8").toString("base64")}`,
        "Content-Type": "application/json",
        ...init.headers
      }
    });
    if (!response.ok) {
      const body = await response.text();
      const summary = body.length > 500 ? `${body.slice(0, 500)}…` : body;
      throw new AzureDevOpsError(
        response.status === 401 || response.status === 403
          ? "Azure DevOps rejected the saved token. Check its organization and Work Items permissions."
          : `Azure DevOps request failed (${response.status} ${response.statusText}).`,
        response.status,
        summary
      );
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return response.json() as Promise<T>;
  }
}

export function normalizeOrganization(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  const match = trimmed.match(/^https:\/\/dev\.azure\.com\/([^/]+)$/i);
  if (match) {
    return decodeURIComponent(match[1]);
  }
  if (/^[a-z0-9][a-z0-9-]{1,62}$/i.test(trimmed)) {
    return trimmed;
  }
  throw new AzureDevOpsError("Enter an organization name or a https://dev.azure.com/{organization} URL.");
}

function escapeWiql(value: string): string {
  return value.replace(/'/g, "''");
}

function quoteWiql(value: string): string {
  return `'${escapeWiql(value)}'`;
}

function fieldString(fields: Record<string, unknown>, name: string): string {
  const value = fields[name];
  return typeof value === "string" ? value : "";
}

function toIdentity(value: unknown): Identity {
  if (!value || typeof value !== "object") {
    return { displayName: "Unknown" };
  }
  const identity = value as Record<string, unknown>;
  return {
    id: typeof identity.id === "string" ? identity.id : undefined,
    displayName: typeof identity.displayName === "string" ? identity.displayName : "Unknown",
    uniqueName: typeof identity.uniqueName === "string"
      ? identity.uniqueName
      : typeof identity.emailAddress === "string" ? identity.emailAddress : undefined,
    imageUrl: typeof identity.imageUrl === "string" ? identity.imageUrl : undefined
  };
}

function toIdentityPickerIdentity(value: unknown): Identity {
  if (!value || typeof value !== "object") {
    return { displayName: "Unknown" };
  }
  const identity = value as Record<string, unknown>;
  const properties = identity.properties && typeof identity.properties === "object"
    ? identity.properties as Record<string, unknown>
    : {};
  return {
    id: typeof identity.localId === "string"
      ? identity.localId
      : typeof identity.entityId === "string" ? identity.entityId : undefined,
    displayName: typeof identity.displayName === "string" ? identity.displayName : "Unknown",
    uniqueName: typeof identity.signInAddress === "string"
      ? identity.signInAddress
      : typeof identity.mail === "string" ? identity.mail : undefined,
    imageUrl: typeof properties.Avatar === "string" ? properties.Avatar : undefined
  };
}

function toWorkItemSummary(item: AzureWorkItem): WorkItemSummary {
  const assigned = item.fields["System.AssignedTo"];
  return {
    id: item.id,
    project: fieldString(item.fields, "System.TeamProject"),
    title: fieldString(item.fields, "System.Title") || `Work item ${item.id}`,
    type: fieldString(item.fields, "System.WorkItemType") || "Work Item",
    state: fieldString(item.fields, "System.State") || "Unknown",
    assignedTo: assigned ? toIdentity(assigned) : undefined,
    changedDate: fieldString(item.fields, "System.ChangedDate"),
    tags: fieldString(item.fields, "System.Tags").split(";").map((tag) => tag.trim()).filter(Boolean),
    url: item.url
  };
}

function toComment(comment: AzureComment): DiscussionComment {
  return {
    id: comment.id,
    parentCommentId: comment.parentCommentId ?? 0,
    text: comment.text ?? "",
    renderedText: comment.renderedText ?? comment.text ?? "",
    createdBy: toIdentity(comment.createdBy),
    createdDate: comment.createdDate ?? "",
    modifiedDate: comment.modifiedDate,
    isDeleted: comment.isDeleted ?? false
  };
}

function sortWorkItems(items: WorkItemSummary[], sort: WorkItemFilters["sort"]): WorkItemSummary[] {
  return items.sort((a, b) => {
    switch (sort) {
      case "updated-asc": return a.changedDate.localeCompare(b.changedDate);
      case "id-desc": return b.id - a.id;
      case "id-asc": return a.id - b.id;
      case "title": return a.title.localeCompare(b.title);
      default: return b.changedDate.localeCompare(a.changedDate);
    }
  });
}
