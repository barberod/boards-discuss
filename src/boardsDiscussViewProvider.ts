import * as vscode from "vscode";
import { AzureDevOpsClient, AzureDevOpsError } from "./azureDevOpsClient";
import { DEFAULT_FILTERS, VIEW_ID } from "./constants";
import { Identity, WorkItemDetails, WorkItemFilters } from "./models";
import { sanitizeAzureHtml } from "./security";
import { StateStore } from "./stateStore";

type IncomingMessage =
  | { type: "ready" }
  | { type: "search"; filters: WorkItemFilters }
  | { type: "select"; id: number }
  | { type: "addComment"; id: number; html: string }
  | { type: "deleteComment"; workItemId: number; commentId: number }
  | { type: "toggleFavorite"; id: number }
  | { type: "togglePinned"; id: number }
  | { type: "searchIdentities"; query: string }
  | { type: "openWorkItem"; id: number }
  | { type: "openLink"; url: string }
  | { type: "configure" }
  | { type: "signIn" }
  | { type: "signOut" }
  | { type: "showHelp" };

export class BoardsDiscussViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = VIEW_ID;

  private view: vscode.WebviewView | undefined;
  private requestController: AbortController | undefined;
  private currentItem: WorkItemDetails | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: StateStore
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")]
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(
      (message: IncomingMessage) => this.handleMessage(message),
      undefined,
      this.context.subscriptions
    );
    webviewView.onDidDispose(() => {
      this.view = undefined;
      this.requestController?.abort();
    });
  }

  async refresh(): Promise<void> {
    if (this.view) {
      await this.loadInitialState();
    }
  }

  async revealWorkItem(id: number): Promise<void> {
    await vscode.commands.executeCommand("workbench.view.extension.boardsDiscuss");
    await this.waitForView();
    await this.loadWorkItem(id);
  }

  private async handleMessage(message: IncomingMessage): Promise<void> {
    try {
      switch (message.type) {
        case "ready": await this.loadInitialState(); break;
        case "search": await this.search(message.filters); break;
        case "select": await this.loadWorkItem(message.id); break;
        case "addComment": await this.addComment(message.id, message.html); break;
        case "deleteComment": await this.deleteComment(message.workItemId, message.commentId); break;
        case "toggleFavorite": await this.toggleFavorite(message.id); break;
        case "togglePinned": await this.togglePinned(message.id); break;
        case "searchIdentities": await this.searchIdentities(message.query); break;
        case "openWorkItem": await this.openWorkItem(message.id); break;
        case "openLink": await this.openLink(message.url); break;
        case "configure": await vscode.commands.executeCommand("boardsDiscuss.configure"); break;
        case "signIn": await vscode.commands.executeCommand("boardsDiscuss.signIn"); break;
        case "signOut": await vscode.commands.executeCommand("boardsDiscuss.signOut"); break;
        case "showHelp": await vscode.commands.executeCommand("boardsDiscuss.showHelp"); break;
      }
    } catch (error) {
      await this.post({ type: "error", message: errorMessage(error) });
    }
  }

  private async loadInitialState(): Promise<void> {
    const state = this.store.state;
    const settings = this.store.settings;
    const pat = await this.store.getPat();
    await this.post({
      type: "bootstrap",
      configured: Boolean(settings.organization),
      authenticated: Boolean(pat),
      organization: settings.organization,
      project: settings.project,
      state
    });
    if (settings.organization && pat) {
      await this.search(state.filters ?? { ...DEFAULT_FILTERS });
      if (state.lastWorkItemId) {
        await this.loadWorkItem(state.lastWorkItemId);
      }
    }
  }

  private async search(filters: WorkItemFilters): Promise<void> {
    const client = await this.getClient();
    this.requestController?.abort();
    this.requestController = new AbortController();
    await this.store.saveFilters(filters);
    await this.post({ type: "loading", target: "items", loading: true });
    try {
      const [items, savedItems] = await Promise.all([
        client.searchWorkItems(filters, this.requestController.signal),
        client.getWorkItems(
          [...this.store.state.pinned, ...this.store.state.favorites],
          this.requestController.signal
        )
      ]);
      await this.post({ type: "items", items, savedItems, state: this.store.state });
    } finally {
      await this.post({ type: "loading", target: "items", loading: false });
    }
  }

  private async loadWorkItem(id: number): Promise<void> {
    const client = await this.getClient();
    await this.post({ type: "loading", target: "discussion", loading: true });
    try {
      const item = await client.getWorkItem(id);
      const [comments, me] = await Promise.all([
        client.getComments(id, item.project),
        client.getCurrentUser().catch(() => ({ displayName: "" } as Identity))
      ]);
      item.description = sanitizeAzureHtml(item.description);
      item.acceptanceCriteria = sanitizeAzureHtml(item.acceptanceCriteria);
      for (const comment of comments) {
        comment.renderedText = sanitizeAzureHtml(comment.renderedText);
      }
      this.currentItem = item;
      await this.store.setLastWorkItem(id);
      await this.post({ type: "workItem", item, comments, me, state: this.store.state });
    } finally {
      await this.post({ type: "loading", target: "discussion", loading: false });
    }
  }

  private async addComment(id: number, html: string): Promise<void> {
    const trimmed = html.trim();
    if (!trimmed || trimmed.length > 32_000) {
      throw new Error(trimmed ? "Comments must be 32,000 characters or fewer." : "Write a comment first.");
    }
    if (!this.currentItem || this.currentItem.id !== id) {
      throw new Error("Select the work item again before posting.");
    }
    await (await this.getClient()).addComment(id, this.currentItem.project, trimmed);
    await this.post({ type: "toast", message: "Comment posted." });
    await this.loadWorkItem(id);
  }

  private async deleteComment(workItemId: number, commentId: number): Promise<void> {
    const answer = await vscode.window.showWarningMessage(
      "Delete this discussion comment? This cannot be undone.",
      { modal: true },
      "Delete"
    );
    if (answer !== "Delete") {
      return;
    }
    if (!this.currentItem || this.currentItem.id !== workItemId) {
      throw new Error("Select the work item again before deleting a comment.");
    }
    await (await this.getClient()).deleteComment(workItemId, this.currentItem.project, commentId);
    await this.post({ type: "toast", message: "Comment deleted." });
    await this.loadWorkItem(workItemId);
  }

  private async toggleFavorite(id: number): Promise<void> {
    const state = await this.store.toggleFavorite(id);
    await this.post({ type: "savedState", state });
  }

  private async togglePinned(id: number): Promise<void> {
    const state = await this.store.togglePinned(id);
    await this.post({ type: "savedState", state });
  }

  private async searchIdentities(query: string): Promise<void> {
    const identities = await (await this.getClient()).searchIdentities(query);
    await this.post({ type: "identities", identities });
  }

  private async openWorkItem(id: number): Promise<void> {
    const client = await this.getClient();
    const project = this.currentItem?.id === id ? this.currentItem.project : this.store.settings.project;
    if (!project) {
      throw new Error("Select the work item again before opening it in Azure DevOps.");
    }
    await vscode.env.openExternal(vscode.Uri.parse(client.getWorkItemWebUrl(id, project)));
  }

  private async openLink(url: string): Promise<void> {
    let uri: vscode.Uri;
    try {
      uri = vscode.Uri.parse(url, true);
    } catch {
      throw new Error("That link is not valid.");
    }
    if (!["https", "http", "mailto"].includes(uri.scheme.toLocaleLowerCase())) {
      throw new Error("Only web and email links can be opened.");
    }
    await vscode.env.openExternal(uri);
  }

  private async getClient(): Promise<AzureDevOpsClient> {
    const settings = this.store.settings;
    if (!settings.organization) {
      throw new Error("Configure an Azure DevOps organization to get started.");
    }
    const pat = await this.store.getPat();
    if (!pat) {
      throw new Error("Connect to Azure DevOps to get started.");
    }
    return new AzureDevOpsClient(settings, pat);
  }

  private async post(message: unknown): Promise<void> {
    await this.view?.webview.postMessage(message);
  }

  private async waitForView(): Promise<void> {
    for (let attempts = 0; !this.view && attempts < 20; attempts += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.css"));
    const nonce = randomNonce();
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>Boards Discuss</title>
</head>
<body>
  <main id="app" aria-live="polite"></main>
  <div id="toast" role="status" aria-live="polite"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function randomNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

function errorMessage(error: unknown): string {
  if (error instanceof AzureDevOpsError && error.details) {
    return `${error.message}\n${error.details}`;
  }
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}
