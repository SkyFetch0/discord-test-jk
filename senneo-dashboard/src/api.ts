async function get<T>(path: string): Promise<T> {
  const r = await fetch(path); if (!r.ok) throw new Error(`HTTP ${r.status}: ${path}`); return r.json();
}
async function post<T>(path: string, body: unknown, headers?: Record<string, string>): Promise<T> {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  if (!r.ok) { const err = await r.json().catch(() => ({ error: r.statusText })); throw new Error((err as any).error ?? r.statusText); }
  return r.json();
}
async function put<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) { const err = await r.json().catch(() => ({ error: r.statusText })); throw new Error((err as any).error ?? r.statusText); }
  return r.json();
}
async function del<T>(path: string): Promise<T> {
  const r = await fetch(path, { method: "DELETE" }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json();
}

export const api = {
  auth: {
    login:      (username: string, password: string) => post<{ ok: boolean; user: import('./types').AuthUser }>("/auth/login", { username, password }),
    logout:     () => post("/auth/logout", {}),
    me:         () => get<{ user: import('./types').AuthUser }>("/auth/me"),
    users:      () => get<{ users: import('./types').DashboardUser[] }>("/auth/users"),
    createUser: (data: { username: string; password: string; displayName?: string; role?: string }) => post("/auth/users", data),
    deleteUser: (username: string) => del(`/auth/users/${username}`),
    updateUser: (username: string, data: { password?: string; displayName?: string; role?: string }) =>
      fetch(`/auth/users/${username}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }).then(r => r.json()),
    tasks:          (all?: boolean) => get<{ tasks: import('./types').UserTask[] }>(`/auth/tasks${all ? '?all=1' : ''}`),
    createTask:     (data: { assignedTo: string; title: string; description?: string; priority?: string; deadline?: string }) => post("/auth/tasks", data),
    updateTask:     (taskId: string, data: { status?: string; assignedTo?: string; channelIds?: string[]; guildId?: string }) =>
      fetch(`/auth/tasks/${taskId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error ?? r.statusText); return j; }),
    deleteTask:     (taskId: string, assignedTo: string) => del(`/auth/tasks/${taskId}?assignedTo=${assignedTo}`),
    distributeTasks:() => post<{ ok: boolean; distributed: number; total?: number; users?: number; message?: string }>("/auth/distribute-tasks", {}),
    notifications:  () => get<{ notifications: import('./types').UserNotification[] }>("/auth/notifications"),
    markRead:       (id: string) => fetch(`/auth/notifications/${id}/read`, { method: "PUT" }).then(r => r.json()),
    heartbeat:      () => post("/auth/heartbeat", {}),
    online:         () => get<{ users: import('./types').UserOnlineStatus[] }>("/auth/online"),
    activity:       (username: string, limit = 50) => get<{ activities: import('./types').UserActivity[] }>(`/auth/activity/${username}?limit=${limit}`),
    userStats:      (username: string) => get<import('./types').UserStats>(`/auth/stats/${username}`),
    leaderboard:    () => get<{ leaderboard: import('./types').LeaderboardEntry[] }>("/auth/leaderboard"),
    taskComments:   (taskId: string, assignedTo: string) => get<{ comments: import('./types').TaskComment[] }>(`/auth/tasks/${taskId}/comments?assignedTo=${assignedTo}`),
    addComment:     (taskId: string, content: string, assignedTo?: string) => post("/auth/tasks/" + taskId + "/comments", { content, assignedTo }),
    sessions:       (username?: string) => get<{ sessions: import('./types').UserSession[] }>(`/auth/sessions${username ? `?username=${username}` : ''}`),
    revokeSession:  (sessionId: string) => fetch(`/auth/sessions/${sessionId}`, { method: "DELETE" }).then(r => r.json()),
    forceLogout:    (username: string) => post(`/auth/force-logout/${username}`, {}),
    changePassword: (currentPassword: string, newPassword: string) =>
      fetch("/auth/change-password", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword, newPassword }) }).then(r => { if (!r.ok) return r.json().then(e => { throw new Error(e.error); }); return r.json(); }),
    resetPassword:  (username: string, newPassword: string) => post(`/auth/users/${username}/reset-password`, { newPassword }),
    myServers:      () => get<import('./types').MyServersResponse>("/auth/my-servers"),
    // U1 — Page Permissions
    pagePermissions: (username: string) => get<import('./types').PagePermissionsResponse>(`/auth/page-permissions/${username}`),
    setPagePermissions: (username: string, pages: string[]) =>
      fetch(`/auth/page-permissions/${username}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pages }) }).then(r => r.json()),
    // U4 — Password Policy
    passwordPolicy: () => get<import('./types').PasswordPolicy>('/auth/password-policy'),
    setPasswordPolicy: (data: { maxDays: number; enforce: boolean; minLength: number }) =>
      fetch('/auth/password-policy', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error ?? r.statusText); return j; }),
    // U5 — Bulk Task
    bulkCreateTask: (data: { usernames: string[]; title: string; description?: string; priority?: string; deadline?: string }) =>
      post<{ ok: boolean; created: number; usernames: string[] }>('/auth/tasks/bulk', data),
  },
  health: {
    all: () => get("/health/all"),
    systemStats: () => get<import('./types').SystemStatsResponse>("/system-stats"),
  },
  live: {
    summary: () => get("/live/summary"),
    recent: (limit = 30, channelId?: string) => get(`/live/recent?limit=${limit}${channelId ? `&channelId=${channelId}` : ""}`),
    channels: (opts: { limit?: number; offset?: number; phase?: string; guildId?: string; accountId?: string; schedulerState?: string; pauseRequested?: boolean; pauseSource?: string; requestedPauseSource?: string; q?: string; sort?: string } = {}) => {
      const p = new URLSearchParams();
      if (opts.limit)   p.set("limit",   String(opts.limit));
      if (opts.offset)  p.set("offset",  String(opts.offset));
      if (opts.phase && opts.phase !== "all") p.set("phase", opts.phase);
      if (opts.guildId) p.set("guildId", opts.guildId);
      if (opts.accountId) p.set("accountId", opts.accountId);
      if (opts.schedulerState) p.set("schedulerState", opts.schedulerState);
      if (opts.pauseRequested != null) p.set("pauseRequested", String(opts.pauseRequested));
      if (opts.pauseSource) p.set("pauseSource", opts.pauseSource);
      if (opts.requestedPauseSource) p.set("requestedPauseSource", opts.requestedPauseSource);
      if (opts.q)       p.set("q",       opts.q);
      if (opts.sort)    p.set("sort",    opts.sort);
      return get<import('./types').ChannelPage>(`/live/channels?${p.toString()}`);
    },
    guilds: () => get("/live/guilds"),
    scraperLog: (opts: { since?: number; limit?: number; type?: string } = {}) => {
      const p = new URLSearchParams();
      if (opts.since) p.set("since", String(opts.since));
      if (opts.limit) p.set("limit", String(opts.limit));
      if (opts.type)  p.set("type",  opts.type);
      return get(`/live/scraper-log?${p.toString()}`);
    },
  },
  accounts: {
    list: () => get<import('./types').AccountsResponse>("/accounts"),
    accountsList: (page = 1, limit = 50, q?: string) => {
      const p = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (q) p.set("q", q);
      return get<import('./types').AccountsListResponse>(`/accounts/accounts-list?${p.toString()}`);
    },
    add: (token: string, email?: string, accountPassword?: string, mailPassword?: string, mailSite?: string) =>
      post("/accounts", { token, email: email || null, accountPassword: accountPassword || null, mailPassword: mailPassword || null, mailSite: mailSite || null }),
    remove: (idx: number) => del(`/accounts/${idx}`),
    refreshCache: () => post("/accounts/refresh-cache", {}),
    guildChannels: (guildId: string, opts: { accountId?: string; accIdx?: number }) => {
      const p = new URLSearchParams();
      if (opts.accountId) p.set("accountId", opts.accountId);
      if (opts.accIdx != null) p.set("accIdx", String(opts.accIdx));
      return get<import('./types').AccountGuildChannelOption[]>(`/accounts/guild/${guildId}/channels?${p.toString()}`);
    },
    guildInfo: (guildId: string, opts: { accountId?: string; accIdx?: number }) => {
      const p = new URLSearchParams();
      if (opts.accountId) p.set("accountId", opts.accountId);
      if (opts.accIdx != null) p.set("accIdx", String(opts.accIdx));
      return get(`/accounts/guild/${guildId}/info?${p.toString()}`);
    },
    addTarget:    (channelId: string, guildId: string, label?: string, accountId?: string) => post("/accounts/targets", { channelId, guildId, label, accountId }),
    removeTarget: (channelId: string) => del(`/accounts/targets/${channelId}`),
    targets: () => get<import('./types').AccountTarget[]>("/accounts/targets"),
    accountTargets: (accountId: string, opts: { limit?: number; offset?: number; q?: string; guildId?: string } = {}) => {
      const p = new URLSearchParams();
      if (opts.limit) p.set("limit", String(opts.limit));
      if (opts.offset) p.set("offset", String(opts.offset));
      if (opts.q) p.set("q", opts.q);
      if (opts.guildId) p.set("guildId", opts.guildId);
      return get<import('./types').AccountTargetsResponse>(`/accounts/${accountId}/targets?${p.toString()}`);
    },
    syncGuildTargets: (accountId: string, guildId: string, channelIds: string[]) =>
      fetch(`/accounts/${accountId}/guilds/${guildId}/targets`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channelIds }) }).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error ?? r.statusText); return j as import('./types').SyncGuildTargetsResponse; }),
    guildOwners: (guildId: string) => get<import('./types').GuildOwnerOptionsResponse>(`/accounts/guild/${guildId}/owners`),
    updateTarget: (channelId: string, data: { accountId?: string; label?: string }) =>
      fetch(`/accounts/targets/${channelId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error ?? r.statusText); return j; }),
    getCredentials: (accountId: string) =>
      get<import('./types').AccountCredentials>(`/accounts/${accountId}/credentials`),
    updateCredentials: (accountId: string, data: { email?: string; accountPassword?: string; mailPassword?: string; mailSite?: string }) =>
      fetch(`/accounts/${accountId}/credentials`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error ?? r.statusText); return j; }),
    pauseState: (accountId: string) => get<import('./types').AccountPauseState>(`/accounts/${accountId}/pause`),
    pause: (accountId: string, reason?: string) =>
      fetch(`/accounts/${accountId}/pause`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(reason ? { reason } : {}) }).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error ?? r.statusText); return j as import('./types').AccountPauseState; }),
    resume: (accountId: string) =>
      fetch(`/accounts/${accountId}/pause`, { method: "DELETE" }).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error ?? r.statusText); return j as import('./types').AccountPauseState; }),
    targetPauseState: (channelId: string) => get<import('./types').ChannelPauseState>(`/accounts/targets/${channelId}/pause`),
    pauseTarget: (channelId: string, reason?: string) =>
      fetch(`/accounts/targets/${channelId}/pause`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(reason ? { reason } : {}) }).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error ?? r.statusText); return j as import('./types').ChannelPauseState; }),
    resumeTarget: (channelId: string) =>
      fetch(`/accounts/targets/${channelId}/pause`, { method: "DELETE" }).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error ?? r.statusText); return j as import('./types').ChannelPauseState; }),
    // A4 — Bulk action
    bulkAction: (accountIds: string[], action: 'pause' | 'resume', reason?: string) =>
      post<{ ok: boolean; results: { accountId: string; ok: boolean; error?: string }[]; succeeded: number }>('/accounts/bulk-action', { accountIds, action, reason }),
  },
  proxies: {
    overview: (force = false) => get<import('./types').ProxyOverviewResponse>(`/proxies${force ? '?force=1' : ''}`),
    saveConfig: (data: import('./types').ProxyConfigPayload) => put<{ ok: boolean; config: import('./types').ProxyOverviewResponse['config'] }>("/proxies", data),
  },
  messages: {
    byChannel: (channelId: string, limit = 50) => get(`/messages/channel/${channelId}?limit=${limit}`),
    badges: (mask: number, limit = 100, mode: 'all' | 'any' = 'all') => get(`/messages/badges?badgeMask=${mask}&limit=${limit}&mode=${mode}`),
    badgeCounts: () => get<{ counts: Record<string, number>; totalUsersWithBadges: number }>("/messages/badges/counts"),
    badgeEnrich: (limit = 5000) => post("/messages/badges/enrich", { limit }),
    badgeEnrichStatus: () => get<{ running: boolean; processed: number; updated: number; total: number; errors: number }>("/messages/badges/enrich/status"),
    stats: (channelId: string) => get(`/messages/stats/${channelId}`),
    byId: (messageId: string) => get(`/messages/${messageId}`),
    context: (messageId: string, depth = 5) => get(`/messages/context?messageId=${messageId}&depth=${depth}`),
    search: (opts: { q: string; limit?: number; sort?: string; match?: string; guildId?: string; channelId?: string; authorId?: string; from?: string; to?: string }) => {
      const p = new URLSearchParams();
      p.set("q", opts.q);
      if (opts.limit)     p.set("limit", String(opts.limit));
      if (opts.sort)      p.set("sort", opts.sort);
      if (opts.match)     p.set("match", opts.match);
      if (opts.guildId)   p.set("guildId", opts.guildId);
      if (opts.channelId) p.set("channelId", opts.channelId);
      if (opts.authorId)  p.set("authorId", opts.authorId);
      if (opts.from)      p.set("from", opts.from);
      if (opts.to)        p.set("to", opts.to);
      return get(`/messages/search?${p.toString()}`);
    },
  },
  db: {
    ch: {
      tables:      () => get("/db/ch/tables"),
      rows:        (table: string, limit = 50, offset = 0) => get(`/db/ch/tables/${table}/rows?limit=${limit}&offset=${offset}`),
      query:       (sql: string) => post("/db/ch/query", { sql }, { "X-Confirm-Destructive": "yes" }),
      topUsers:    (limit = 20) => get(`/db/ch/analytics/topusers?limit=${limit}`),
      topChannels: (limit = 10) => get(`/db/ch/analytics/topchannels?limit=${limit}`),
      activity:    (days = 30)  => get(`/db/ch/analytics/activity?days=${days}`),
      hourly:      ()           => get("/db/ch/analytics/hourly"),
      search:       (q: string, limit = 50) => get(`/db/ch/analytics/search?q=${encodeURIComponent(q)}&limit=${limit}`),
      userById:     (authorId: string) => get(`/db/ch/analytics/user?authorId=${authorId}`),
      userByName:   (name: string, limit = 20) => get(`/db/ch/analytics/user?name=${encodeURIComponent(name)}&limit=${limit}`),
      userHistory:  (authorId: string, field?: string, limit = 100) => get(`/db/ch/analytics/user-history?authorId=${authorId}${field ? `&field=${field}` : ''}&limit=${limit}`),
      contentTypes: (days = 30) => get(`/db/ch/analytics/content-types?days=${days}`),
      mediaTypes:   (days = 30) => get(`/db/ch/analytics/media-types?days=${days}`),
      msgSize:      (days = 30) => get(`/db/ch/analytics/msg-size?days=${days}`),
      heatmap:      (days = 30) => get(`/db/ch/analytics/heatmap?days=${days}`),
      weeklyGrowth: (weeks = 12) => get(`/db/ch/analytics/weekly-growth?weeks=${weeks}`),
      channelHourly:(channelId: string, days = 30) => get(`/db/ch/analytics/channel-hourly?channelId=${channelId}&days=${days}`),
      overview:     (days = 30) => get(`/db/ch/analytics/overview?days=${days}`),
      dedupStatus:  () => get("/db/ch/dedup/status"),
      dedupRun:     () => post("/db/ch/dedup/run", {}),
    },
    scylla: {
      tables: () => get("/db/scylla/tables"),
      query:  (cql: string) => post("/db/scylla/query", { cql }, { "X-Confirm-Destructive": "yes" }),
    },
  },
  errors: {
    list: (opts: { limit?: number; offset?: number; category?: string; source?: string; severity?: string; q?: string; channelId?: string; guildId?: string; accountId?: string; accountIdx?: number | string; since?: string; until?: string } = {}) => {
      const p = new URLSearchParams();
      if (opts.limit)      p.set("limit",      String(opts.limit));
      if (opts.offset)     p.set("offset",     String(opts.offset));
      if (opts.category)   p.set("category",   opts.category);
      if (opts.source)     p.set("source",     opts.source);
      if (opts.severity)   p.set("severity",   opts.severity);
      if (opts.q)          p.set("q",          opts.q);
      if (opts.channelId)  p.set("channelId",  opts.channelId);
      if (opts.guildId)    p.set("guildId",    opts.guildId);
      if (opts.accountId)  p.set("accountId",  opts.accountId);
      if (opts.accountIdx != null) p.set("accountIdx", String(opts.accountIdx));
      if (opts.since)      p.set("since",      opts.since);
      if (opts.until)      p.set("until",      opts.until);
      return get(`/errors?${p.toString()}`);
    },
    summary: (since = "24h") => get(`/errors/summary?since=${since}`),
  },
  guilds: {
    stats:           () => get("/guilds/stats"),
    syncStatus:      () => get("/guilds/sync/status"),
    triggerSync:     () => post("/guilds/sync", {}),
    accountGuilds:   (accountIdOrIdx: string | number) => get<import('./types').AccountGuildsResponse>(`/guilds/accounts/${accountIdOrIdx}`),
    names:           (ids: string[]) => get<{ names: Record<string, string> }>(`/guilds/names?ids=${ids.join(",")}`),
    all:             (limit = 50, q?: string) => get(`/guilds/all?limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}`),
    invites: {
      list:        (opts: { status?: string; q?: string; limit?: number; offset?: number; accountId?: string; accountIdx?: number | string; sort?: string } = {}) => {
        const p = new URLSearchParams();
        if (opts.status)  p.set("status", opts.status);
        if (opts.q)       p.set("q", opts.q);
        if (opts.limit)   p.set("limit", String(opts.limit));
        if (opts.offset)  p.set("offset", String(opts.offset));
        if (opts.sort)    p.set("sort", opts.sort);
        if (opts.accountId) p.set("accountId", opts.accountId);
        if (opts.accountIdx != null) p.set("accountIdx", String(opts.accountIdx));
        return get(`/guilds/invites?${p.toString()}`);
      },
      addBatch:    (entries: Array<{ code: string; sourceName?: string | null }>) => post("/guilds/invites/batch", { entries }),
      jobStatus:   (jobId: string) => get(`/guilds/invites/jobs/${jobId}`),
      activeJob:   () => get(`/guilds/invites/jobs/active`),
      remove:      (code: string) => del(`/guilds/invites/${code}`),
      cleanup:     () => post("/guilds/invites/cleanup", {}),
      recheck:     () => post("/guilds/invites/recheck", {}),
      fullCheck:   () => post("/guilds/invites/full-check", {}),
      verify:      () => post("/guilds/invites/verify", {}),
    },
    categories: {
      list:        (opts: { limit?: number; offset?: number; q?: string } = {}) => {
        const p = new URLSearchParams();
        if (opts.limit)  p.set("limit", String(opts.limit));
        if (opts.offset) p.set("offset", String(opts.offset));
        if (opts.q)      p.set("q", opts.q);
        return get(`/guilds/categories?${p.toString()}`);
      },
      create:      (name: string, description?: string) => post("/guilds/categories", { name, description }),
      update:      (id: string, fields: { name?: string; description?: string }) => fetch(`/guilds/categories/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fields) }).then(r => r.json()),
      remove:      (id: string, moveTo?: string) => del(`/guilds/categories/${id}${moveTo ? `?moveTo=${moveTo}` : ""}`),
      guilds:      (id: string, opts: { q?: string; membership?: string; limit?: number; offset?: number } = {}) => {
        const p = new URLSearchParams();
        if (opts.q)          p.set("q", opts.q);
        if (opts.membership) p.set("membership", opts.membership);
        if (opts.limit)      p.set("limit", String(opts.limit));
        if (opts.offset)     p.set("offset", String(opts.offset));
        return get(`/guilds/categories/${id}/guilds?${p.toString()}`);
      },
      addGuild:    (catId: string, guild: { guildId: string; guildName?: string; guildIcon?: string; inviteCode?: string }) => post(`/guilds/categories/${catId}/guilds`, guild),
      removeGuild: (catId: string, guildId: string) => del(`/guilds/categories/${catId}/guilds/${guildId}`),
    },
    accountList: () => get<{ accounts: import('./types').AccountListEntry[] }>("/guilds/account-list"),
    refreshAccounts: () => post("/guilds/refresh-accounts", {}),
    refreshIcons:    () => post("/guilds/icons/refresh", {}),
    importExisting: () => post("/guilds/invites/import-existing", {}),
    reassignWaiting: () => post("/guilds/invites/reassign-waiting", {}),
    uncategorized: (q?: string) => get(`/guilds/uncategorized${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  },
  archive: {
    list:     () => get<{ accounts: import('./types').ArchivedAccount[]; total: number }>("/archive"),
    failed:   () => get<{ accounts: import('./types').FailedAccount[]; total: number }>("/archive/failed"),
    clearFailed: (accountId: string) => del(`/archive/failed/${accountId}`),
    detail:   (accountId: string) => get<import('./types').ArchivedDetailResponse>(`/archive/accounts/${accountId}`),
    create:   (accountId: string, reason?: string) => post(`/archive/accounts/${accountId}`, { reason }),
    remove:   (accountId: string) => del(`/archive/accounts/${accountId}`),
    transfer: (accountId: string, token: string) => post<{ ok: boolean; newAccountId: string; newUsername: string; invitesCreated: number; targetsCreated: number; totalGuilds: number }>(`/archive/accounts/${accountId}/transfer`, { token }),
  },
  alerts: {
    list:   () => get("/alerts"),
    create: (rule: { pattern: string; matchMode?: string; channelIds?: string[]; webhookUrl: string }) => post("/alerts", rule),
    update: (id: string, fields: Record<string, unknown>) => fetch(`/alerts/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fields) }).then(r => r.json()),
    remove: (id: string) => del(`/alerts/${id}`),
    test:   (pattern: string, matchMode?: string) => post("/alerts/test", { pattern, matchMode }),
  },
};

const MAX_EXPORT_ROWS = 10_000; // P2-3: Prevent browser crash with huge exports
export function exportCSV(rows: Record<string, unknown>[], filename: string) {
  if (!rows.length) return;
  const limited = rows.length > MAX_EXPORT_ROWS ? rows.slice(0, MAX_EXPORT_ROWS) : rows;
  if (rows.length > MAX_EXPORT_ROWS) console.warn(`[export] Truncated ${rows.length} rows to ${MAX_EXPORT_ROWS}`);
  const cols = Object.keys(limited[0]);
  const lines = [cols.join(","), ...limited.map(r => cols.map(c => JSON.stringify(r[c] ?? "")).join(","))];
  download(lines.join("\n"), filename + ".csv", "text/csv");
}
export function exportJSON(data: unknown, filename: string) { download(JSON.stringify(data, null, 2), filename + ".json", "application/json"); }
function download(content: string, filename: string, type: string) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([content], { type })); a.download = filename; a.click(); URL.revokeObjectURL(a.href);
}