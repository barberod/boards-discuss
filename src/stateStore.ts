import * as vscode from "vscode";
import { DEFAULT_FILTERS, SECRET_PAT_KEY, VIEW_STATE_KEY } from "./constants";
import { ConnectionSettings, PersistedViewState, WorkItemFilters } from "./models";

const DEFAULT_STATE: PersistedViewState = {
  favorites: [],
  pinned: [],
  filters: { ...DEFAULT_FILTERS }
};

export class StateStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  get settings(): ConnectionSettings {
    const config = vscode.workspace.getConfiguration("boardsDiscuss");
    return {
      organization: config.get<string>("organization", "").trim(),
      project: config.get<string>("project", "").trim(),
      pageSize: config.get<number>("pageSize", 50)
    };
  }

  get state(): PersistedViewState {
    const saved = this.context.globalState.get<PersistedViewState>(VIEW_STATE_KEY);
    return {
      ...DEFAULT_STATE,
      ...saved,
      favorites: saved?.favorites ?? [],
      pinned: saved?.pinned ?? [],
      filters: { ...DEFAULT_FILTERS, ...saved?.filters }
    };
  }

  async getPat(): Promise<string | undefined> {
    return this.context.secrets.get(SECRET_PAT_KEY);
  }

  async savePat(pat: string): Promise<void> {
    await this.context.secrets.store(SECRET_PAT_KEY, pat.trim());
  }

  async deletePat(): Promise<void> {
    await this.context.secrets.delete(SECRET_PAT_KEY);
  }

  async saveFilters(filters: WorkItemFilters): Promise<void> {
    await this.update({ filters });
  }

  async setLastWorkItem(id: number): Promise<void> {
    await this.update({ lastWorkItemId: id });
  }

  async toggleFavorite(id: number): Promise<PersistedViewState> {
    const state = this.state;
    state.favorites = toggleNumber(state.favorites, id);
    await this.context.globalState.update(VIEW_STATE_KEY, state);
    return state;
  }

  async togglePinned(id: number): Promise<PersistedViewState> {
    const state = this.state;
    state.pinned = toggleNumber(state.pinned, id);
    await this.context.globalState.update(VIEW_STATE_KEY, state);
    return state;
  }

  private async update(patch: Partial<PersistedViewState>): Promise<void> {
    await this.context.globalState.update(VIEW_STATE_KEY, { ...this.state, ...patch });
  }
}

function toggleNumber(values: number[], id: number): number[] {
  return values.includes(id) ? values.filter((value) => value !== id) : [...values, id];
}
