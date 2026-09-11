import * as vscode from "vscode";
import { MENTION_WATERMARK_KEY } from "./constants";
import { AzureDevOpsClient } from "./azureDevOpsClient";
import { MentionNotification, WorkItemSummary } from "./models";
import { plainTextFromHtml } from "./security";
import { StateStore } from "./stateStore";

export class MentionMonitor implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: StateStore,
    private readonly onOpen: (id: number) => Promise<void>
  ) {}

  start(): void {
    this.stop();
    const minutes = vscode.workspace.getConfiguration("boardsDiscuss")
      .get<number>("notificationIntervalMinutes", 5);
    if (!minutes || minutes < 1) {
      return;
    }
    this.timer = setInterval(() => void this.check(), minutes * 60_000);
    setTimeout(() => void this.check(), 10_000);
  }

  async check(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const settings = this.store.settings;
    const pat = await this.store.getPat();
    if (!settings.organization || !pat) {
      return;
    }
    try {
      const client = new AzureDevOpsClient(settings, pat);
      const me = await client.getCurrentUser();
      if (!me.id && !me.uniqueName) {
        return;
      }
      const since = this.context.globalState.get<string>(MENTION_WATERMARK_KEY)
        ?? new Date(Date.now() - 24 * 60 * 60_000).toISOString();
      const filters = {
        query: "",
        states: [],
        types: [],
        assignedToMe: false,
        sort: "updated-desc" as const
      };
      const items = (await client.searchWorkItems(filters)).filter((item) => item.changedDate > since).slice(0, 30);
      const mentions = await this.findMentions(client, items, me.id, me.uniqueName, since);
      await this.context.globalState.update(MENTION_WATERMARK_KEY, new Date().toISOString());
      for (const mention of mentions.slice(0, 5)) {
        const action = await vscode.window.showInformationMessage(
          `${mention.author} mentioned you in #${mention.workItemId}: ${mention.preview}`,
          "Open discussion"
        );
        if (action) {
          await this.onOpen(mention.workItemId);
        }
      }
    } catch {
      // Background checks stay quiet; foreground actions surface connection errors.
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async findMentions(
    client: AzureDevOpsClient,
    items: WorkItemSummary[],
    identityId: string | undefined,
    uniqueName: string | undefined,
    since: string
  ): Promise<MentionNotification[]> {
    const notifications: MentionNotification[] = [];
    for (const item of items) {
      const comments = await client.getComments(item.id);
      for (const comment of comments) {
        if (comment.createdDate <= since || !isMentioned(comment.renderedText, identityId, uniqueName)) {
          continue;
        }
        notifications.push({
          key: `${item.id}:${comment.id}`,
          workItemId: item.id,
          workItemTitle: item.title,
          commentId: comment.id,
          author: comment.createdBy.displayName,
          createdDate: comment.createdDate,
          preview: plainTextFromHtml(comment.renderedText).slice(0, 100)
        });
      }
    }
    return notifications.sort((a, b) => a.createdDate.localeCompare(b.createdDate));
  }
}

function isMentioned(html: string, identityId?: string, uniqueName?: string): boolean {
  const lower = html.toLocaleLowerCase();
  return Boolean(
    (identityId && lower.includes(identityId.toLocaleLowerCase()))
    || (uniqueName && lower.includes(uniqueName.toLocaleLowerCase()))
  );
}
