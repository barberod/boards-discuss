(function () {
  const vscode = acquireVsCodeApi();
  const previous = vscode.getState() || {};
  const state = {
    configured: false,
    authenticated: false,
    organization: "",
    project: "",
    items: [],
    savedItems: [],
    favorites: [],
    pinned: [],
    selected: null,
    comments: [],
    me: null,
    loadingItems: false,
    loadingDiscussion: false,
    filters: previous.filters || { query: "", states: [], types: [], assignedToMe: true, sort: "updated-desc" },
    activeTab: previous.activeTab || "discussion",
    identities: [],
    mentionQuery: ""
  };
  let searchTimer;
  let mentionTimer;

  const app = document.getElementById("app");
  const toast = document.getElementById("toast");

  window.addEventListener("message", (event) => {
    const message = event.data;
    switch (message.type) {
      case "bootstrap":
        Object.assign(state, {
          configured: message.configured,
          authenticated: message.authenticated,
          organization: message.organization,
          project: message.project,
          favorites: message.state.favorites || [],
          pinned: message.state.pinned || [],
          filters: message.state.filters || state.filters
        });
        render();
        break;
      case "items":
        state.items = message.items || [];
        state.savedItems = message.savedItems || [];
        state.favorites = message.state.favorites || [];
        state.pinned = message.state.pinned || [];
        render();
        break;
      case "workItem":
        state.selected = message.item;
        state.comments = message.comments || [];
        state.me = message.me;
        state.favorites = message.state.favorites || [];
        state.pinned = message.state.pinned || [];
        render();
        requestAnimationFrame(() => document.querySelector(".comments")?.lastElementChild?.scrollIntoView({ block: "nearest" }));
        break;
      case "savedState":
        state.favorites = message.state.favorites || [];
        state.pinned = message.state.pinned || [];
        render();
        break;
      case "identities":
        state.identities = message.identities || [];
        renderMentions();
        break;
      case "loading":
        if (message.target === "items") state.loadingItems = message.loading;
        if (message.target === "discussion") state.loadingDiscussion = message.loading;
        render();
        break;
      case "error":
        state.loadingItems = false;
        state.loadingDiscussion = false;
        showToast(message.message, true);
        render();
        break;
      case "toast": showToast(message.message); break;
    }
  });

  function render() {
    saveUiState();
    if (!state.configured || !state.authenticated) {
      app.innerHTML = onboardingHtml();
      wireCommonActions();
      return;
    }
    app.innerHTML = `<div class="shell">
      <div class="toolbar">
        <div class="search"><input id="search" type="search" value="${escapeAttr(state.filters.query)}" placeholder="Search title, tag, or #ID" aria-label="Search work items"></div>
        <button class="icon-button" data-action="refresh" title="Refresh" aria-label="Refresh">↻</button>
        <button class="icon-button" data-action="configure" title="Configure" aria-label="Configure">⚙</button>
      </div>
      <div class="filters">
        <label>Sort <select id="sort">${sortOptions()}</select></label>
        <label><input id="mine" type="checkbox" ${state.filters.assignedToMe ? "checked" : ""}> Assigned to me</label>
        <label class="wide">State <input id="states" value="${escapeAttr(state.filters.states.join(", "))}" placeholder="Active, New (blank = any)"></label>
        <label class="wide">Type <input id="types" value="${escapeAttr(state.filters.types.join(", "))}" placeholder="Bug, User Story (blank = any)"></label>
      </div>
      <section id="items-region" aria-label="Work items">${itemsHtml()}</section>
      <section id="detail-region" aria-label="Selected work item">${detailHtml()}</section>
    </div>`;
    wireCommonActions();
    wireFilters();
    wireItems();
    wireDetail();
  }

  function onboardingHtml() {
    const ready = state.configured && state.authenticated;
    return `<div class="status-card">
      <h2>Bring Azure Boards discussions into VS Code</h2>
      <p>Search, read context, and respond without losing your place in code. Your token is safely stored in VS Code's encrypted secret storage.</p>
      <div class="status-actions">
        <button class="primary" data-action="configure">${state.configured ? "Edit connection" : "Configure organization"}</button>
        <button class="primary" data-action="signIn">${state.authenticated ? "Reconnect" : "Connect"}</button>
        <button class="secondary" data-action="help">Setup help</button>
      </div>
      ${ready ? "" : `<p class="hint">Authentication requires Work Items (Read & write) access. Credentials are never written to settings or logs.</p>`}
    </div>`;
  }

  function itemsHtml() {
    if (state.loadingItems && !state.items.length) return `<div class="loading"></div><div class="skeleton"></div>`;
    const pinned = uniqueItems(state.savedItems.filter((item) => state.pinned.includes(item.id)));
    const favorites = uniqueItems(state.savedItems.filter((item) => state.favorites.includes(item.id) && !state.pinned.includes(item.id)));
    const regular = state.items.filter((item) => !state.pinned.includes(item.id));
    if (!pinned.length && !favorites.length && !regular.length) {
      return `<div class="empty"><h2>No matching work items</h2><p>Try a broader search or remove a filter.</p></div>`;
    }
    return `${state.loadingItems ? '<div class="loading"></div>' : ""}
      ${itemGroup("Pinned", pinned)}
      ${itemGroup("Favorites", favorites)}
      ${itemGroup("Work items", regular)}`;
  }

  function itemGroup(label, items) {
    if (!items.length) return "";
    return `<div class="section-label">${label}</div><div class="item-list">${items.map(itemHtml).join("")}</div>`;
  }

  function itemHtml(item) {
    const selected = state.selected?.id === item.id;
    const marks = `${state.pinned.includes(item.id) ? "●" : ""}${state.favorites.includes(item.id) ? "★" : ""}`;
    return `<button class="work-item ${selected ? "active" : ""}" data-id="${item.id}" aria-current="${selected}">
      <span class="id">#${item.id}</span>
      <span><span class="title">${escapeHtml(item.title)}</span><br><span class="meta">${escapeHtml(item.type)} · ${escapeHtml(item.state)} · ${relativeTime(item.changedDate)}</span></span>
      <span class="saved-marks" aria-hidden="true">${marks}</span>
    </button>`;
  }

  function detailHtml() {
    if (state.loadingDiscussion && !state.selected) return `<div class="loading"></div><div class="skeleton"></div>`;
    if (!state.selected) return `<div class="empty"><h2>Select a work item</h2><p>Its discussion and context will appear here.</p></div>`;
    const item = state.selected;
    return `${state.loadingDiscussion ? '<div class="loading"></div>' : ""}
      <header class="detail-header">
        <div class="detail-kicker">${escapeHtml(item.type)} #${item.id} · <span class="badge">${escapeHtml(item.state)}</span></div>
        <h2 class="detail-title">${escapeHtml(item.title)}</h2>
        <div class="detail-actions">
          <button class="icon-button" data-action="favorite" title="${state.favorites.includes(item.id) ? "Remove favorite" : "Add favorite"}" aria-pressed="${state.favorites.includes(item.id)}">${state.favorites.includes(item.id) ? "★" : "☆"}</button>
          <button class="icon-button" data-action="pin" title="${state.pinned.includes(item.id) ? "Unpin" : "Pin"}" aria-pressed="${state.pinned.includes(item.id)}">${state.pinned.includes(item.id) ? "●" : "○"}</button>
          <span class="spacer"></span>
          <button class="secondary" data-action="openWorkItem">Open in Azure DevOps ↗</button>
        </div>
      </header>
      <nav class="tabs" aria-label="Work item content">
        ${tabButton("discussion", `Discussion (${state.comments.length})`)}
        ${tabButton("description", "Description")}
        ${tabButton("acceptance", "Acceptance criteria")}
      </nav>
      <div class="tab-panel">${tabPanelHtml()}</div>`;
  }

  function tabButton(name, label) {
    return `<button class="tab ${state.activeTab === name ? "active" : ""}" data-tab="${name}" aria-selected="${state.activeTab === name}">${label}</button>`;
  }

  function tabPanelHtml() {
    if (state.activeTab === "description") {
      return state.selected.description ? `<div class="rich-text link-surface">${state.selected.description}</div>` : emptyContext("No description provided.");
    }
    if (state.activeTab === "acceptance") {
      return state.selected.acceptanceCriteria ? `<div class="rich-text link-surface">${state.selected.acceptanceCriteria}</div>` : emptyContext("No acceptance criteria provided.");
    }
    return `${commentsHtml()}${composerHtml()}`;
  }

  function commentsHtml() {
    if (!state.comments.length) return `<div class="empty"><h2>No discussion yet</h2><p>Start the conversation below.</p></div>`;
    return `<div class="comments">${state.comments.map((comment) => {
      const own = sameIdentity(comment.createdBy, state.me);
      const avatar = comment.createdBy.imageUrl
        ? `<img src="${escapeAttr(comment.createdBy.imageUrl)}" alt="">`
        : escapeHtml(initials(comment.createdBy.displayName));
      return `<article class="comment">
        <div class="avatar">${avatar}</div>
        <div><header class="comment-head"><span class="comment-author">${escapeHtml(comment.createdBy.displayName)}</span><time class="comment-time" datetime="${escapeAttr(comment.createdDate)}">${relativeTime(comment.createdDate)}</time>${own ? `<button class="icon-button comment-delete" data-delete="${comment.id}" title="Delete your comment" aria-label="Delete comment">🗑</button>` : ""}</header>
        <div class="comment-body rich-text link-surface">${comment.renderedText}</div></div>
      </article>`;
    }).join("")}</div>`;
  }

  function composerHtml() {
    return `<div class="composer">
      <div id="mentions" class="mentions hidden" role="listbox"></div>
      <div class="format-bar" aria-label="Comment formatting">
        <button class="icon-button" data-format="bold" title="Bold"><b>B</b></button>
        <button class="icon-button" data-format="italic" title="Italic"><i>I</i></button>
        <button class="icon-button" data-format="code" title="Inline code">&lt;/&gt;</button>
        <button class="icon-button" data-format="link" title="Link">↗</button>
      </div>
      <textarea id="composer" placeholder="Add to the discussion… Use @ to mention a coworker." aria-label="New discussion comment"></textarea>
      <div class="composer-footer"><span class="hint">Markdown styling is supported</span><button class="primary" data-action="post">Post comment</button></div>
    </div>`;
  }

  function emptyContext(message) { return `<div class="empty"><p>${message}</p></div>`; }

  function wireCommonActions() {
    document.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => {
      const action = button.dataset.action;
      if (action === "configure") vscode.postMessage({ type: "configure" });
      if (action === "signIn") vscode.postMessage({ type: "signIn" });
      if (action === "signOut") vscode.postMessage({ type: "signOut" });
      if (action === "help") vscode.postMessage({ type: "showHelp" });
      if (action === "refresh") search();
      if (action === "favorite" && state.selected) vscode.postMessage({ type: "toggleFavorite", id: state.selected.id });
      if (action === "pin" && state.selected) vscode.postMessage({ type: "togglePinned", id: state.selected.id });
      if (action === "openWorkItem" && state.selected) vscode.postMessage({ type: "openWorkItem", id: state.selected.id });
      if (action === "post") postComment();
    }));
  }

  function wireFilters() {
    const searchBox = document.getElementById("search");
    searchBox?.addEventListener("input", () => {
      state.filters.query = searchBox.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(search, 350);
    });
    document.getElementById("sort")?.addEventListener("change", (event) => { state.filters.sort = event.target.value; search(); });
    document.getElementById("mine")?.addEventListener("change", (event) => { state.filters.assignedToMe = event.target.checked; search(); });
    for (const [id, key] of [["states", "states"], ["types", "types"]]) {
      document.getElementById(id)?.addEventListener("change", (event) => {
        state.filters[key] = event.target.value.split(",").map((value) => value.trim()).filter(Boolean);
        search();
      });
    }
  }

  function wireItems() {
    document.querySelectorAll(".work-item").forEach((button) => button.addEventListener("click", () =>
      vscode.postMessage({ type: "select", id: Number(button.dataset.id) })
    ));
  }

  function wireDetail() {
    document.querySelectorAll("[data-tab]").forEach((tab) => tab.addEventListener("click", () => {
      state.activeTab = tab.dataset.tab;
      render();
    }));
    document.querySelectorAll("[data-delete]").forEach((button) => button.addEventListener("click", () =>
      vscode.postMessage({ type: "deleteComment", workItemId: state.selected.id, commentId: Number(button.dataset.delete) })
    ));
    document.querySelectorAll("[data-format]").forEach((button) => button.addEventListener("click", () => applyFormat(button.dataset.format)));
    document.querySelectorAll(".link-surface a").forEach((link) => link.addEventListener("click", (event) => {
      event.preventDefault();
      vscode.postMessage({ type: "openLink", url: link.href });
    }));
    const composer = document.getElementById("composer");
    composer?.addEventListener("input", handleMentionInput);
    composer?.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); postComment(); }
    });
  }

  function search() {
    saveUiState();
    vscode.postMessage({ type: "search", filters: state.filters });
  }

  function postComment() {
    const composer = document.getElementById("composer");
    if (!composer || !composer.value.trim() || !state.selected) return;
    vscode.postMessage({ type: "addComment", id: state.selected.id, html: markdownToHtml(composer.value) });
    composer.value = "";
  }

  function applyFormat(format) {
    const editor = document.getElementById("composer");
    if (!editor) return;
    const selected = editor.value.slice(editor.selectionStart, editor.selectionEnd);
    const wrappers = { bold: ["**", "**"], italic: ["_", "_"], code: ["`", "`"], link: ["[", "](https://)"] };
    const [before, after] = wrappers[format] || ["", ""];
    const replacement = before + (selected || (format === "link" ? "link text" : "text")) + after;
    editor.setRangeText(replacement, editor.selectionStart, editor.selectionEnd, "select");
    editor.focus();
  }

  function handleMentionInput(event) {
    const editor = event.target;
    const beforeCursor = editor.value.slice(0, editor.selectionStart);
    const match = beforeCursor.match(/(?:^|\s)@([^@\n]{2,40})$/);
    if (!match) { hideMentions(); return; }
    state.mentionQuery = match[1];
    clearTimeout(mentionTimer);
    mentionTimer = setTimeout(() => vscode.postMessage({ type: "searchIdentities", query: state.mentionQuery }), 250);
  }

  function renderMentions() {
    const list = document.getElementById("mentions");
    if (!list) return;
    if (!state.identities.length) { hideMentions(); return; }
    list.innerHTML = state.identities.map((identity, index) => `<button class="mention-option" role="option" data-identity="${index}">${escapeHtml(identity.displayName)} <span class="hint">${escapeHtml(identity.uniqueName || "")}</span></button>`).join("");
    list.classList.remove("hidden");
    list.querySelectorAll("[data-identity]").forEach((button) => button.addEventListener("click", () => insertMention(state.identities[Number(button.dataset.identity)])));
  }

  function insertMention(identity) {
    const editor = document.getElementById("composer");
    if (!editor || !identity.id) return;
    const start = editor.value.slice(0, editor.selectionStart).lastIndexOf("@");
    const token = `@[${identity.displayName}](${identity.id}) `;
    editor.setRangeText(token, start, editor.selectionStart, "end");
    editor.focus();
    hideMentions();
  }

  function hideMentions() {
    state.identities = [];
    document.getElementById("mentions")?.classList.add("hidden");
  }

  function markdownToHtml(value) {
    let html = escapeHtml(value);
    html = html.replace(/@\[([^\]]+)]\(([a-zA-Z0-9-]+)\)/g, '<a href="#" data-vss-mention="version:2.0,$2">@$1</a>');
    html = html.replace(/\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
    html = html.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/_([^_\n]+)_/g, "<em>$1</em>");
    html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    return `<p>${html.replace(/\n/g, "<br>")}</p>`;
  }

  function sortOptions() {
    return [["updated-desc", "Recently updated"], ["updated-asc", "Least recently updated"], ["id-desc", "Newest ID"], ["id-asc", "Oldest ID"], ["title", "Title"]]
      .map(([value, label]) => `<option value="${value}" ${state.filters.sort === value ? "selected" : ""}>${label}</option>`).join("");
  }

  function saveUiState() { vscode.setState({ filters: state.filters, activeTab: state.activeTab }); }
  function uniqueItems(items) { return [...new Map(items.map((item) => [item.id, item])).values()]; }
  function sameIdentity(a, b) { return Boolean(a && b && ((a.id && b.id && a.id === b.id) || (a.uniqueName && b.uniqueName && a.uniqueName.toLowerCase() === b.uniqueName.toLowerCase()))); }
  function initials(name) { return String(name || "?").split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase(); }
  function relativeTime(value) {
    if (!value) return "";
    const delta = new Date(value).getTime() - Date.now();
    const abs = Math.abs(delta);
    const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    if (abs < 60_000) return formatter.format(Math.round(delta / 1000), "second");
    if (abs < 3_600_000) return formatter.format(Math.round(delta / 60_000), "minute");
    if (abs < 86_400_000) return formatter.format(Math.round(delta / 3_600_000), "hour");
    return formatter.format(Math.round(delta / 86_400_000), "day");
  }
  function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
  function escapeAttr(value) { return escapeHtml(value).replace(/`/g, "&#96;"); }
  function showToast(message, isError) {
    toast.textContent = message;
    toast.style.color = isError ? "var(--vscode-errorForeground)" : "";
    toast.classList.add("show");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove("show"), isError ? 7000 : 2500);
  }

  vscode.postMessage({ type: "ready" });
})();
