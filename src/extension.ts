import * as vscode from "vscode";
import { BoardsDiscussViewProvider } from "./boardsDiscussViewProvider";
import { MentionMonitor } from "./mentionMonitor";
import { StateStore } from "./stateStore";

export function activate(context: vscode.ExtensionContext): void {
  const store = new StateStore(context);
  const provider = new BoardsDiscussViewProvider(context, store);
  const mentionMonitor = new MentionMonitor(context, store, (id) => provider.revealWorkItem(id));

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(BoardsDiscussViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand("boardsDiscuss.open", () =>
      vscode.commands.executeCommand("workbench.view.extension.boardsDiscuss")
    ),
    vscode.commands.registerCommand("boardsDiscuss.configure", async () => {
      const current = store.settings;
      const organization = await vscode.window.showInputBox({
        title: "Boards Discuss — Azure DevOps organization",
        prompt: "Enter the organization name or full dev.azure.com URL",
        value: current.organization,
        placeHolder: "contoso",
        ignoreFocusOut: true,
        validateInput: (value) => value.trim() ? undefined : "Organization is required."
      });
      if (organization === undefined) return;
      const project = await vscode.window.showInputBox({
        title: "Boards Discuss — Azure DevOps project",
        prompt: "Enter a project name, or leave blank to search across projects",
        value: current.project,
        placeHolder: "Web Platform",
        ignoreFocusOut: true
      });
      if (project === undefined) return;
      const config = vscode.workspace.getConfiguration("boardsDiscuss");
      await config.update("organization", organization.trim(), vscode.ConfigurationTarget.Global);
      await config.update("project", project.trim(), vscode.ConfigurationTarget.Global);
      await provider.refresh();
      void vscode.window.showInformationMessage("Boards Discuss connection settings saved.");
    }),
    vscode.commands.registerCommand("boardsDiscuss.signIn", async () => {
      const pat = await vscode.window.showInputBox({
        title: "Boards Discuss — Personal Access Token",
        prompt: "Use a token with Work Items (read & write) permission",
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) => value.trim().length >= 20 ? undefined : "Enter a valid personal access token."
      });
      if (!pat) return;
      await store.savePat(pat);
      await provider.refresh();
      mentionMonitor.start();
      void vscode.window.showInformationMessage("Azure DevOps token saved securely in VS Code SecretStorage.");
    }),
    vscode.commands.registerCommand("boardsDiscuss.signOut", async () => {
      const answer = await vscode.window.showWarningMessage(
        "Forget the Azure DevOps token saved by Boards Discuss?",
        { modal: true },
        "Forget token"
      );
      if (answer !== "Forget token") return;
      await store.deletePat();
      await provider.refresh();
    }),
    vscode.commands.registerCommand("boardsDiscuss.refresh", () => provider.refresh()),
    vscode.commands.registerCommand("boardsDiscuss.showHelp", () => showHelp()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("boardsDiscuss")) {
        mentionMonitor.start();
        void provider.refresh();
      }
    }),
    mentionMonitor
  );
  mentionMonitor.start();
}

export function deactivate(): void {}

async function showHelp(): Promise<void> {
  const action = await vscode.window.showInformationMessage(
    "Boards Discuss uses an Azure DevOps PAT with Work Items read/write access. The token is kept in VS Code's encrypted SecretStorage and is never written to settings.",
    "Open setup guide",
    "Open settings"
  );
  if (action === "Open setup guide") {
    await vscode.env.openExternal(vscode.Uri.parse("https://learn.microsoft.com/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate"));
  } else if (action === "Open settings") {
    await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:barberod.boards-discuss");
  }
}
