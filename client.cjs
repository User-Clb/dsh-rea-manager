// dsh-rea-manager client half: settings panel with two tabs —
//   版本管理：完整版本列表、安装/更新/回退/启用
//   代理站点：测试、移除、添加、恢复默认，改动即时持久化
// The panel talks to the host half through `/api/plugin-rpc/dsh-rea-manager`,
// so the GUI and the model drive exactly the same code paths.
window.__ModuleLoader__.load({
  id: "dsh-rea-manager",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;

    const NAME = "dsh-rea-manager";
    const RPC_METHOD = "plugin-rpc/dsh-rea-manager";

    function rpcOf(ctx) {
      const connection = ctx?.get?.("connection", false) ?? ctx?.connection;
      const rpc = connection?.rpc;
      if (!rpc || typeof rpc.call !== "function") {
        throw new Error("connection.rpc 不可用：Client 与 Host 的 RPC 通道未挂载");
      }
      return rpc;
    }

    function timeoutSignal(ms) {
      return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(ms)
        : undefined;
    }

    async function callRpc(ctx, endpoint, payload = {}, timeoutMs = 120000) {
      const rpc = rpcOf(ctx);
      const response = await rpc.call("/api", RPC_METHOD, { endpoint, payload }, timeoutSignal(timeoutMs));
      if (!response || response.ok !== true) {
        const error = response?.error;
        throw new Error(`Host ${endpoint} 失败：${String(error?.code ?? "unknown")} ${String(error?.message ?? "")}`.trim());
      }
      return response.value;
    }

    const styles = {
      root: { display: "flex", flexDirection: "column", gap: "10px", fontSize: "12px" },
      row: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
      title: { fontSize: "13px", fontWeight: 600 },
      hint: { color: "var(--dsw-alias-label-secondary, #888)" },
      button: {
        height: "26px",
        padding: "0 10px",
        borderRadius: "6px",
        border: "1px solid var(--dsw-alias-border-l2, #d9d9d9)",
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
        fontSize: "12px",
      },
      buttonPrimary: {
        height: "26px",
        padding: "0 12px",
        borderRadius: "6px",
        border: "1px solid transparent",
        background: "#2563eb",
        color: "#fff",
        cursor: "pointer",
        fontSize: "12px",
      },
      buttonDanger: {
        height: "22px",
        padding: "0 8px",
        borderRadius: "6px",
        border: "1px solid rgba(220,38,38,.5)",
        background: "transparent",
        color: "#dc2626",
        cursor: "pointer",
        fontSize: "11px",
      },
      buttonTiny: {
        height: "22px",
        padding: "0 8px",
        borderRadius: "6px",
        border: "1px solid var(--dsw-alias-border-l2, #d9d9d9)",
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
        fontSize: "11px",
      },
      tab: {
        height: "26px",
        padding: "0 12px",
        borderRadius: "6px 6px 0 0",
        border: "1px solid transparent",
        borderBottom: "none",
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
        fontSize: "12px",
        opacity: 0.65,
      },
      tabActive: {
        opacity: 1,
        fontWeight: 600,
        border: "1px solid var(--dsw-alias-border-l2, #d9d9d9)",
        background: "var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08))",
      },
      select: {
        height: "26px",
        minWidth: "220px",
        padding: "0 6px",
        borderRadius: "6px",
        border: "1px solid var(--dsw-alias-border-l2, #d9d9d9)",
        background: "var(--dsw-alias-bg-layer-1, #fff)",
        color: "inherit",
        fontSize: "12px",
      },
      input: {
        height: "26px",
        padding: "0 8px",
        borderRadius: "6px",
        border: "1px solid var(--dsw-alias-border-l2, #d9d9d9)",
        background: "var(--dsw-alias-bg-layer-1, #fff)",
        color: "inherit",
        fontSize: "12px",
      },
      list: {
        maxHeight: "300px",
        overflow: "auto",
        border: "1px solid var(--dsw-alias-border-l2, #d9d9d9)",
        borderRadius: "8px",
      },
      item: {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "4px 8px",
        cursor: "pointer",
        borderBottom: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.2))",
      },
      itemActive: { background: "rgba(37,99,235,.12)" },
      badge: {
        padding: "0 6px",
        borderRadius: "999px",
        fontSize: "10px",
        lineHeight: "16px",
        border: "1px solid currentColor",
        opacity: 0.8,
      },
      badgeOk: { color: "#16a34a" },
      badgeBad: { color: "#dc2626" },
      error: { color: "#dc2626", whiteSpace: "pre-wrap" },
      log: {
        maxHeight: "160px",
        overflow: "auto",
        padding: "6px 8px",
        borderRadius: "8px",
        background: "var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08))",
        whiteSpace: "pre-wrap",
        fontFamily: "ui-monospace, monospace",
      },
      card: {
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        padding: "8px",
        border: "1px solid var(--dsw-alias-border-l2, #d9d9d9)",
        borderRadius: "8px",
      },
      mono: { fontFamily: "ui-monospace, monospace", fontSize: "11px", opacity: 0.8 },
      // Service control strip: pinned between the tab row and the tab body.
      bar: {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        flexWrap: "wrap",
        padding: "6px 8px",
        borderRadius: "8px",
        border: "1px solid var(--dsw-alias-border-l2, #d9d9d9)",
        background: "var(--dsw-alias-bg-layer-2, rgba(128,128,128,.06))",
      },
    };

    /* ------------------------------------------------------------ versions */

    function VersionPanel({ ctx, setBusy, setError, setMessage, busy }) {
      const [state, setState] = React.useState({ loading: true, versions: [], active: "", latest: "" });
      const [selected, setSelected] = React.useState("");

      const refresh = React.useCallback(async (force) => {
        setBusy("refresh");
        setError("");
        try {
          const [status, catalog] = await Promise.all([
            callRpc(ctx, "status", {}, 60000),
            callRpc(ctx, "versions", { refresh: force === true }, 180000),
          ]);
          setState({
            loading: false,
            versions: catalog.versions ?? [],
            active: status?.active?.version ?? "",
            latest: catalog.latest ?? "",
            installed: (status?.installed ?? []).map((entry) => entry.version),
            session: status?.session ?? null,
            node: status?.node ?? null,
          });
          setSelected((previous) => previous || status?.active?.version || catalog.versions?.[0]?.version || "");
        } catch (cause) {
          setError(String(cause?.message ?? cause));
          setState((previous) => ({ ...previous, loading: false }));
        } finally {
          setBusy("");
        }
      }, [ctx, setBusy, setError]);

      React.useEffect(() => {
        refresh(false);
      }, [refresh]);

      const run = React.useCallback(async (label, action) => {
        setBusy(label);
        setError("");
        setMessage("");
        try {
          const value = await action();
          setMessage(typeof value === "string" ? value : JSON.stringify(value, null, 2));
          await refresh(false);
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        } finally {
          setBusy("");
        }
      }, [refresh, setBusy, setError, setMessage]);

      const install = () => run("install", async () => {
        const value = await callRpc(ctx, "install", { version: selected }, 1800000);
        return `已安装并启用 REA ${value.version}（${value.channel}）${value.session?.tools ? `，MCP ${value.session.tools} 个工具` : ""}`;
      });
      const update = () => run("update", async () => {
        const value = await callRpc(ctx, "update", { version: "latest" }, 1800000);
        return `已更新到 ${value.version}（${value.channel}）${value.session?.tools ? `，MCP ${value.session.tools} 个工具` : ""}`;
      });
      const rollback = () => run("rollback", async () => {
        const value = await callRpc(ctx, "rollback", { version: selected }, 1800000);
        return `已回退到 ${value.version}（${value.channel}）${value.session?.tools ? `，MCP ${value.session.tools} 个工具` : ""}`;
      });
      const activate = () => run("activate", async () => {
        const value = await callRpc(ctx, "activate", { version: selected }, 120000);
        return `已切换为 ${value.active?.version ?? selected}`;
      });

      const disabled = busy !== "" || state.loading;
      const rows = state.versions ?? [];

      return h("div", { style: styles.root },
        h("div", { style: styles.row },
          h("span", { style: styles.hint }, "当前版本"),
          h("strong", null, state.active || "未安装"),
          state.node ? h("span", { style: styles.hint }, `Node ${state.node.version}${state.node.satisfiesReaEngines ? "" : "（超出 engines）"}`) : null,
          state.session?.running ? h("span", { style: styles.badge }, `MCP ${state.session.tools} 工具`) : null,
          state.latest ? h("span", { style: styles.hint }, `最新 ${state.latest}`) : null,
        ),
        h("div", { style: styles.row },
          h("select", {
            style: styles.select,
            value: selected,
            disabled,
            onChange: (event) => setSelected(event.target.value),
          }, rows.map((entry) => h("option", { key: entry.version, value: entry.version },
            `${entry.version}${entry.version === state.active ? " · 当前" : ""}${entry.installed ? " · 已安装" : ""}${entry.date ? ` · ${entry.date.slice(0, 10)}` : ""}`))),
          h("button", { type: "button", style: styles.buttonPrimary, disabled, onClick: install }, busy === "install" ? "安装中…" : "安装 / 切换到此版本"),
          h("button", { type: "button", style: styles.button, disabled, onClick: rollback }, busy === "rollback" ? "回退中…" : "回退到选中版本"),
          h("button", { type: "button", style: styles.button, disabled, onClick: update }, busy === "update" ? "更新中…" : "更新到最新"),
          h("button", { type: "button", style: styles.button, disabled, onClick: activate }, busy === "activate" ? "切换中…" : "仅启用已安装版本"),
          h("button", { type: "button", style: styles.button, disabled, onClick: () => refresh(true) }, busy === "refresh" ? "刷新中…" : "刷新版本列表"),
        ),
        h("div", { style: styles.list }, rows.map((entry) => h("div", {
          key: entry.version,
          style: { ...styles.item, ...(entry.version === state.active ? styles.itemActive : {}) },
          onClick: () => setSelected(entry.version),
        },
          h("span", { style: { width: "68px" } }, entry.version),
          h("span", { style: { ...styles.hint, width: "92px" } }, entry.date ? entry.date.slice(0, 10) : "—"),
          h("span", { style: { ...styles.hint, width: "76px" } }, (entry.sources ?? []).join("+")),
          entry.version === state.active ? h("span", { style: styles.badge }, "当前") : null,
          entry.installed ? h("span", { style: styles.badge }, "已安装") : null,
          entry.deprecated ? h("span", { style: styles.badge }, "已弃用") : null,
        ))),
        state.loading ? h("div", { style: styles.hint }, "加载版本列表…") : null,
      );
    }

    /* ------------------------------------------------------------- mirrors */

    const EMPTY_ROW = { id: "", kind: "git", url: "", label: "", priority: "" };

    function MirrorPanel({ ctx, setBusy, setError, setMessage, busy }) {
      const [data, setData] = React.useState({ loading: true, mirrors: [], counts: {}, removed: [] });
      const [draft, setDraft] = React.useState(EMPTY_ROW);
      const [adding, setAdding] = React.useState(false);
      const [testing, setTesting] = React.useState("");
      const [filter, setFilter] = React.useState("");

      const apply = React.useCallback((value) => {
        if (!value || !Array.isArray(value.mirrors)) return;
        setData({
          loading: false,
          mirrors: value.mirrors,
          counts: value.counts ?? {},
          removed: value.removed ?? [],
          probedAt: value.probedAt ?? "",
        });
      }, []);

      const load = React.useCallback(async () => {
        setBusy("mirrorLoad");
        setError("");
        try {
          apply(await callRpc(ctx, "mirrorList", {}, 60000));
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        } finally {
          setBusy("");
        }
      }, [ctx, apply, setBusy, setError]);

      React.useEffect(() => {
        load();
      }, [load]);

      const mutate = React.useCallback(async (label, endpoint, payload) => {
        setBusy(label);
        setError("");
        setMessage("");
        try {
          apply(await callRpc(ctx, endpoint, payload, 600000));
          setMessage("已保存");
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        } finally {
          setBusy("");
        }
      }, [ctx, apply, setBusy, setError, setMessage]);

      const testOne = React.useCallback(async (id) => {
        setTesting(id);
        setError("");
        try {
          const result = await callRpc(ctx, "mirrorTest", { id }, 180000);
          setMessage(`${result.id}：${result.ok ? `可用 ${result.ms}ms` : `失败 ${result.reason ?? ""}`}`);
          apply(await callRpc(ctx, "mirrorList", {}, 60000));
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        } finally {
          setTesting("");
        }
      }, [ctx, apply, setError, setMessage]);

      const testDraft = React.useCallback(async () => {
        if (!draft.id || !draft.url) {
          setError("请先填写 id 与 url");
          return;
        }
        setTesting("__draft__");
        setError("");
        try {
          const row = {
            id: draft.id.trim(),
            kind: draft.kind,
            url: draft.url.trim(),
            label: draft.label.trim() || draft.id.trim(),
          };
          const result = await callRpc(ctx, "mirrorTest", { row }, 180000);
          setMessage(`候选站点 ${result.id}：${result.ok ? `可用 ${result.ms}ms` : `失败 ${result.reason ?? ""}`}`);
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        } finally {
          setTesting("");
        }
      }, [ctx, draft, setError, setMessage]);

      const testAll = () => mutate("mirrorTestAll", "mirrorTestAll", {});
      const reset = () => mutate("mirrorReset", "mirrorReset", {});

      const add = React.useCallback(async () => {
        const row = {
          id: draft.id.trim(),
          kind: draft.kind,
          url: draft.url.trim(),
          label: draft.label.trim() || draft.id.trim(),
        };
        if (!row.id || !row.url) {
          setError("请先填写 id 与 url");
          return;
        }
        if (draft.priority !== "" && Number.isFinite(Number(draft.priority))) row.priority = Number(draft.priority);
        await mutate("mirrorAdd", "mirrorAdd", { row });
        setDraft(EMPTY_ROW);
        setAdding(false);
      }, [draft, mutate, setError]);

      const disabled = busy !== "";
      const counts = data.counts ?? {};
      const visible = (data.mirrors ?? []).filter((mirror) => {
        if (!filter.trim()) return true;
        const needle = filter.trim().toLowerCase();
        return mirror.id.toLowerCase().includes(needle)
          || mirror.url.toLowerCase().includes(needle)
          || mirror.kind.toLowerCase().includes(needle);
      });

      return h("div", { style: styles.root },
        h("div", { style: styles.row },
          h("span", { style: styles.hint }, `共 ${counts.total ?? 0} 个站点（git ${counts.git ?? 0} / npm ${counts.npm ?? 0} / node ${counts.node ?? 0}，自定义 ${counts.custom ?? 0}，已移除 ${counts.removed ?? 0}）`),
          data.probedAt ? h("span", { style: styles.hint }, `上次探测 ${String(data.probedAt).slice(0, 19).replace("T", " ")}`) : null,
        ),
        h("div", { style: styles.row },
          h("input", {
            style: { ...styles.input, width: "180px" },
            placeholder: "筛选 id / url / 类型",
            value: filter,
            onChange: (event) => setFilter(event.target.value),
          }),
          h("button", { type: "button", style: styles.buttonPrimary, disabled, onClick: testAll }, busy === "mirrorTestAll" ? "探测中…" : "测试全部"),
          h("button", { type: "button", style: styles.button, disabled, onClick: () => setAdding((value) => !value) }, adding ? "收起新增" : "添加站点"),
          h("button", { type: "button", style: styles.button, disabled, onClick: () => mutate("mirrorReorder", "mirrorReorder", { ids: sortByPriority(data.mirrors).map((mirror) => mirror.id) }) }, "按延迟重排"),
          h("button", { type: "button", style: styles.button, disabled, onClick: reset }, busy === "mirrorReset" ? "恢复中…" : "重置为默认站点"),
          h("button", { type: "button", style: styles.button, disabled, onClick: load }, busy === "mirrorLoad" ? "刷新中…" : "刷新"),
        ),
        adding ? h("div", { style: styles.card },
          h("div", { style: styles.title }, "添加代理站点"),
          h("div", { style: styles.row },
            h("input", { style: { ...styles.input, width: "140px" }, placeholder: "id（唯一，英文）", value: draft.id, onChange: (e) => setDraft({ ...draft, id: e.target.value }) }),
            h("select", { style: { ...styles.input, width: "90px" }, value: draft.kind, onChange: (e) => setDraft({ ...draft, kind: e.target.value }) },
              h("option", { value: "git" }, "git"),
              h("option", { value: "npm" }, "npm"),
              h("option", { value: "node" }, "node"),
            ),
            h("input", { style: { ...styles.input, width: "120px" }, placeholder: "名称（可选）", value: draft.label, onChange: (e) => setDraft({ ...draft, label: e.target.value }) }),
            h("input", { style: { ...styles.input, width: "80px" }, placeholder: "优先级", value: draft.priority, onChange: (e) => setDraft({ ...draft, priority: e.target.value }) }),
          ),
          h("input", {
            style: { ...styles.input, width: "100%" },
            placeholder: draft.kind === "git" ? "https://gh-proxy.com/{url}   或   https://gitee.com/mirrors/rea.git" : "https://registry.npmmirror.com",
            value: draft.url,
            onChange: (e) => setDraft({ ...draft, url: e.target.value }),
          }),
          h("div", { style: { ...styles.hint, fontSize: "11px" } },
            draft.kind === "git"
              ? "git 站点支持 {url} 占位符，会被替换成 https://github.com/morluto/rea.git；也可直接写完整仓库地址。"
              : draft.kind === "npm" ? "npm 站点填 registry 根地址，例如 https://registry.npmmirror.com。" : "node 站点填 Node 二进制分发根地址。"),
          h("div", { style: styles.row },
            h("button", { type: "button", style: styles.buttonTiny, disabled, onClick: testDraft }, testing === "__draft__" ? "测试中…" : "先测试"),
            h("button", { type: "button", style: styles.buttonPrimary, disabled, onClick: add }, busy === "mirrorAdd" ? "添加中…" : "添加并保存"),
            h("button", { type: "button", style: styles.button, disabled, onClick: () => { setDraft(EMPTY_ROW); setAdding(false); } }, "取消"),
          ),
        ) : null,
        h("div", { style: styles.list }, visible.map((mirror) => {
          const last = mirror.last;
          const stateText = last ? (last.ok ? `可用 ${last.ms}ms` : `失败 ${String(last.reason ?? "").slice(0, 48)}`) : "未测试";
          return h("div", { key: mirror.id, style: styles.item },
            h("span", { style: { ...styles.badge, width: "38px", textAlign: "center" } }, mirror.kind),
            h("span", { style: { width: "150px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: mirror.id }, mirror.id),
            mirror.origin === "custom"
              ? h("span", { style: styles.badge }, "自定义")
              : mirror.origin === "modified" ? h("span", { style: styles.badge }, "已改") : null,
            h("span", { style: { ...styles.hint, ...styles.mono, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: mirror.url }, mirror.url),
            h("span", { style: { ...styles.badge, ...(last ? (last.ok ? styles.badgeOk : styles.badgeBad) : {}) } }, stateText),
            h("button", { type: "button", style: styles.buttonTiny, disabled: disabled || testing === mirror.id, onClick: () => testOne(mirror.id) }, testing === mirror.id ? "测试中…" : "测试"),
            h("button", { type: "button", style: styles.buttonDanger, disabled, onClick: () => mutate("mirrorRemove", "mirrorRemove", { id: mirror.id }) }, "移除"),
          );
        })),
        visible.length === 0 && !data.loading ? h("div", { style: styles.hint }, "没有匹配的站点") : null,
        data.loading ? h("div", { style: styles.hint }, "加载站点列表…") : null,
        data.removed && data.removed.length > 0
          ? h("div", { style: { ...styles.hint, fontSize: "11px" } }, `已移除的内置站点：${data.removed.join("、")}（点“重置为默认站点”可全部恢复）`)
          : null,
      );
    }

    function sortByPriority(mirrors) {
      return [...(mirrors ?? [])].sort((left, right) => {
        const a = left.last;
        const b = right.last;
        const av = a && a.ok ? a.ms : Number.MAX_SAFE_INTEGER;
        const bv = b && b.ok ? b.ms : Number.MAX_SAFE_INTEGER;
        return av - bv;
      });
    }

    /* ------------------------------------------------------------- mcp bar */

    // Standalone service control. It sits between the tab row and the tab body
    // so start / stop / restart is reachable from every tab, not buried inside
    // the tool list.
    function McpBar({ ctx, busy, setBusy, setError, setMessage, status, onStatus }) {
      const running = status?.running === true;
      const disabled = busy !== "";

      const act = async (action) => {
        const label = action === "start" ? "启动" : action === "stop" ? "停止" : "重启";
        setBusy(`mcp-${action}`);
        setError("");
        setMessage("");
        try {
          const endpoint = action === "start" ? "mcpStart" : action === "stop" ? "mcpStop" : "mcpRestart";
          const next = await callRpc(ctx, endpoint, {}, 300000);
          onStatus?.(next);
          setMessage(`${label}完成：${next.running ? `运行中，${next.tools} 个工具` : "已停止"}`);
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        } finally {
          setBusy("");
        }
      };

      return h("div", { style: styles.bar },
        h("span", { style: styles.title }, "REA 服务"),
        h("span", { style: { ...styles.badge, ...(running ? styles.badgeOk : styles.badgeBad) } },
          running ? `运行中 · ${status.tools} 工具` : "已停止"),
        h("button", { type: "button", style: styles.buttonPrimary, disabled: disabled || running, onClick: () => act("start") },
          busy === "mcp-start" ? "启动中…" : "启动"),
        h("button", { type: "button", style: styles.button, disabled: disabled || !running, onClick: () => act("restart") },
          busy === "mcp-restart" ? "重启中…" : "重启"),
        h("button", { type: "button", style: styles.buttonDanger, disabled: disabled || !running, onClick: () => act("stop") },
          busy === "mcp-stop" ? "停止中…" : "停止"),
        status
          ? h("span", { style: styles.hint },
            `${status.enabled ? "允许启动" : "已显式停止"} · 超时 ${status.startupTimeoutMs}/${status.toolTimeoutMs}ms · 自动重连 ${status.autoReconnect ? "开" : "关"}`)
          : h("span", { style: styles.hint }, "读取服务状态…"),
      );
    }

    /* ------------------------------------------------------------ mcp tools */

    function ToolPanel({ ctx, setBusy, setError, setMessage, busy, mcp }) {
      const [state, setState] = React.useState({ loading: true, tools: [], total: 0, enabled: 0, disabled: 0, groups: [] });
      const [query, setQuery] = React.useState("");
      const [group, setGroup] = React.useState("");
      const [onlyDisabled, setOnlyDisabled] = React.useState(false);
      const [detail, setDetail] = React.useState(null);

      const applyList = React.useCallback((value) => {
        if (!value || !Array.isArray(value.tools)) return;
        setState({
          loading: false,
          tools: value.tools,
          total: value.total ?? 0,
          enabled: value.enabled ?? 0,
          disabled: value.disabled ?? 0,
          groups: value.groups ?? [],
          version: value.version ?? "",
        });
      }, []);

      const load = React.useCallback(async () => {
        setBusy("toolLoad");
        setError("");
        try {
          applyList(await callRpc(ctx, "toolList", {
            query: query.trim() || undefined,
            group: group || undefined,
            enabled: onlyDisabled ? false : undefined,
            limit: 400,
          }, 120000));
        } catch (cause) {
          setError(String(cause?.message ?? cause));
          setState((previous) => ({ ...previous, loading: false }));
        } finally {
          setBusy("");
        }
      }, [ctx, query, group, onlyDisabled, applyList, setBusy, setError]);

      React.useEffect(() => {
        load();
      }, [load]);

      const run = React.useCallback(async (label, action) => {
        setBusy(label);
        setError("");
        setMessage("");
        try {
          const value = await action();
          setMessage(typeof value === "string" ? value : "已保存");
          await load();
          return value;
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        } finally {
          setBusy("");
        }
      }, [load, setBusy, setError, setMessage]);

      const toggle = (tool) => run(`tool-${tool.name}`, async () => {
        await callRpc(ctx, "toolSet", { tool: tool.name, enabled: !tool.enabled }, 120000);
        return `${tool.enabled ? "已禁用" : "已启用"} ${tool.name}`;
      });

      const bulk = (enabled) => run("toolBulk", async () => {
        if (!query.trim() && !group) throw new Error("批量操作需要先填搜索词或选择分组");
        const value = await callRpc(ctx, "toolBulk", {
          query: query.trim() || undefined,
          group: group || undefined,
          enabled,
        }, 300000);
        return `已${enabled ? "启用" : "禁用"} ${value.changed} 个工具`;
      });

      const reset = () => run("toolReset", async () => {
        await callRpc(ctx, "toolReset", {}, 60000);
        return "已全部启用";
      });

      const showSchema = async (tool) => {
        setBusy(`schema-${tool.name}`);
        setError("");
        try {
          setDetail(await callRpc(ctx, "toolSchema", { tool: tool.name }, 120000));
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        } finally {
          setBusy("");
        }
      };

      const disabled = busy !== "";

      return h("div", { style: styles.root },
        h("div", { style: styles.row },
          h("input", {
            style: { ...styles.input, width: "200px" },
            placeholder: "搜索工具名 / 描述",
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }),
          h("select", {
            style: { ...styles.input, width: "150px" },
            value: group,
            onChange: (event) => setGroup(event.target.value),
          },
            h("option", { value: "" }, "全部分组"),
            (state.groups ?? []).map((name) => h("option", { key: name, value: name }, name)),
          ),
          h("label", { style: { ...styles.hint, display: "flex", alignItems: "center", gap: "4px" } },
            h("input", { type: "checkbox", checked: onlyDisabled, onChange: (event) => setOnlyDisabled(event.target.checked) }),
            "只看已禁用",
          ),
          h("button", { type: "button", style: styles.button, disabled, onClick: () => bulk(true) }, "按条件启用"),
          h("button", { type: "button", style: styles.button, disabled, onClick: () => bulk(false) }, "按条件禁用"),
          h("button", { type: "button", style: styles.button, disabled, onClick: reset }, "全部启用"),
        ),
        h("div", { style: styles.row },
          h("span", { style: styles.hint }, `共 ${state.total} 个工具 · 启用 ${state.enabled} · 禁用 ${state.disabled}${state.version ? ` · REA ${state.version}` : ""}`),
        ),
        h("div", { style: styles.list }, (state.tools ?? []).map((tool) => h("div", {
          key: tool.name,
          style: styles.item,
        },
          h("span", { style: { ...styles.badge, ...(tool.enabled ? styles.badgeOk : styles.badgeBad), width: "34px", textAlign: "center" } }, tool.enabled ? "开" : "关"),
          h("span", { style: { width: "220px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: tool.name }, tool.name),
          h("span", { style: { ...styles.hint, width: "110px" } }, tool.group),
          h("span", { style: { ...styles.hint, width: "62px" } }, `${tool.propertyCount} 参数`),
          h("span", { style: { ...styles.hint, ...styles.mono, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: tool.description }, tool.description),
          h("button", { type: "button", style: styles.buttonTiny, disabled, onClick: () => showSchema(tool) }, "schema"),
          h("button", {
            type: "button",
            style: tool.enabled ? styles.buttonDanger : styles.buttonTiny,
            disabled,
            onClick: () => toggle(tool),
          }, tool.enabled ? "禁用" : "启用"),
        ))),
        state.loading ? h("div", { style: styles.hint }, "加载工具目录…") : null,
        detail ? h("div", { style: styles.card },
          h("div", { style: styles.row },
            h("strong", null, detail.name),
            h("span", { style: styles.badge }, detail.group),
            h("button", { type: "button", style: styles.buttonTiny, onClick: () => setDetail(null) }, "关闭"),
          ),
          h("div", { style: { ...styles.hint, fontSize: "11px" } }, String(detail.description ?? "").split("\n")[0]),
          h("div", { style: styles.log }, JSON.stringify(detail.inputSchema ?? {}, null, 2)),
        ) : null,
      );
    }

    /* ---------------------------------------------------------------- shell */

    function Panel({ ctx }) {
      const [tab, setTab] = React.useState("versions");
      const [busy, setBusy] = React.useState("");
      const [message, setMessage] = React.useState("");
      const [error, setError] = React.useState("");
      const [mcp, setMcp] = React.useState(null);

      React.useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const status = await callRpc(ctx, "mcpStatus", {}, 60000);
            if (alive) setMcp(status);
          } catch {
            /* the bar shows "读取服务状态…" until the host answers */
          }
        })();
        return () => {
          alive = false;
        };
      }, [ctx]);

      const tabs = [
        ["versions", "版本管理"],
        ["tools", "MCP 工具"],
        ["mirrors", "代理站点"],
      ];

      return h("div", { style: styles.root },
        h("div", { style: styles.title }, "REA 逆向分析管理器"),
        // Service control sits directly under the title, above the tabs: it is
        // global to the plugin, not part of any single tab.
        h(McpBar, { ctx, busy, setBusy, setError, setMessage, status: mcp, onStatus: setMcp }),
        h("div", { style: styles.row },
          tabs.map(([id, label]) => h("button", {
            key: id,
            type: "button",
            style: { ...styles.tab, ...(tab === id ? styles.tabActive : {}) },
            onClick: () => setTab(id),
          }, label)),
          busy ? h("span", { style: styles.hint }, "处理中…") : null,
        ),
        tab === "versions"
          ? h(VersionPanel, { ctx, busy, setBusy, setError, setMessage })
          : tab === "tools"
            ? h(ToolPanel, { ctx, busy, setBusy, setError, setMessage, mcp })
            : h(MirrorPanel, { ctx, busy, setBusy, setError, setMessage }),
        error ? h("div", { style: styles.error }, error) : null,
        message ? h("div", { style: styles.log }, message) : null,
      );
    }

    function apply(ctx) {
      ctx.effect(() => {
        try {
          return ctx.slots.inject("settings.section", () => ctx.slots.register({
            name: "settings.section",
            id: "dsh-rea-manager",
            order: 48,
            label: () => "REA 逆向分析",
          }, (props) => h(Panel, { ...props, ctx })));
        } catch (error) {
          try {
            console.warn("[dsh-rea-manager] settings.section 槽位不可用：", error);
          } catch {
            /* ignore */
          }
          return () => {};
        }
      }, "dsh-rea-manager: settings panel");
    }

    return { apply, inject: ["slots"], name: NAME };
  },
});
