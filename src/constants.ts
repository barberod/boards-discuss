export const EXTENSION_ID = "boards-discuss";
export const VIEW_ID = "boardsDiscuss.main";
export const SECRET_PAT_KEY = "boardsDiscuss.azureDevOpsPat";
export const VIEW_STATE_KEY = "boardsDiscuss.viewState";
export const MENTION_WATERMARK_KEY = "boardsDiscuss.mentionWatermark";
export const API_VERSION = "7.1";

export const DEFAULT_FILTERS = {
  query: "",
  states: [] as string[],
  types: [] as string[],
  assignedToMe: true,
  sort: "updated-desc" as const
};
