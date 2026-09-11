export interface ConnectionSettings {
  organization: string;
  project: string;
  pageSize: number;
}

export interface WorkItemSummary {
  id: number;
  title: string;
  type: string;
  state: string;
  assignedTo?: Identity;
  changedDate: string;
  tags: string[];
  url: string;
}

export interface WorkItemDetails extends WorkItemSummary {
  description: string;
  acceptanceCriteria: string;
  areaPath: string;
  iterationPath: string;
}

export interface Identity {
  id?: string;
  displayName: string;
  uniqueName?: string;
  imageUrl?: string;
}

export interface DiscussionComment {
  id: number;
  parentCommentId: number;
  text: string;
  renderedText: string;
  createdBy: Identity;
  createdDate: string;
  modifiedDate?: string;
  isDeleted: boolean;
}

export type WorkItemSort = "updated-desc" | "updated-asc" | "id-desc" | "id-asc" | "title";

export interface WorkItemFilters {
  query: string;
  states: string[];
  types: string[];
  assignedToMe: boolean;
  sort: WorkItemSort;
}

export interface MentionNotification {
  key: string;
  workItemId: number;
  workItemTitle: string;
  commentId: number;
  author: string;
  createdDate: string;
  preview: string;
}

export interface PersistedViewState {
  favorites: number[];
  pinned: number[];
  lastWorkItemId?: number;
  filters?: WorkItemFilters;
}
