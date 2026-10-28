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
      root: { display: "flex", flexDirection: "column", gap: "14px", fontSize: "12px" },
      row: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
      // Header block: title + one-line subtitle, separated from the body.
      header: {
        display: "flex",
        flexDirection: "column",
        gap: "2px",
        paddingBottom: "10px",
        borderBottom: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))",
      },
      title: { fontSize: "14px", fontWeight: 600, lineHeight: "20px" },
      subtitle: { fontSize: "11px", color: "var(--dsw-alias-label-secondary, #888)" },
      // Tab strip: underline style instead of boxed tabs, so it reads as a
      // section switcher rather than a row of buttons.
      tabStrip: {
        display: "flex",
        alignItems: "center",
        gap: "18px",
        borderBottom: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))",
      },
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
        height: "32px",
        padding: "0 2px",
        border: "none",
        borderBottom: "2px solid transparent",
        borderRadius: 0,
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
        fontSize: "12px",
        opacity: 0.6,
        marginBottom: "-1px",
      },
      tabActive: {
        opacity: 1,
        fontWeight: 600,
        borderBottom: "2px solid #2563eb",
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
      // Rows carry two independent highlight states: the running version
      // (itemActive, always visible) and the row under the cursor / the row
      // the user picked (hover / selected), which drive the version dropdown.
      itemHover: { background: "rgba(128,128,128,.12)" },
      itemSelected: { background: "rgba(37,99,235,.2)", boxShadow: "inset 2px 0 0 #2563eb" },
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
      badgeBusy: { color: "#2563eb" },
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
      // Service card: a status/action row, then a dashed-separated parameter
      // row. Two rows instead of one long wrapping strip.
      bar: {
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        padding: "10px 12px",
        borderRadius: "10px",
        border: "1px solid var(--dsw-alias-border-l2, #d9d9d9)",
        background: "var(--dsw-alias-bg-layer-2, rgba(128,128,128,.06))",
      },
      barTop: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
      barFields: {
        display: "flex",
        alignItems: "flex-end",
        gap: "16px",
        flexWrap: "wrap",
        paddingTop: "10px",
        borderTop: "1px dashed var(--dsw-alias-border-l2, rgba(128,128,128,.35))",
      },
      // One editable service parameter: label above, control below.
      field: {
        display: "flex",
        flexDirection: "column",
        gap: "3px",
        fontSize: "11px",
      },
      dividerV: {
        width: "1px",
        alignSelf: "stretch",
        background: "var(--dsw-alias-border-l2, #d9d9d9)",
        opacity: 0.6,
      },
      inputNarrow: {
        width: "68px",
        height: "26px",
        padding: "0 8px",
        borderRadius: "6px",
        border: "1px solid var(--dsw-alias-border-l2, #d9d9d9)",
        background: "var(--dsw-alias-bg-layer-1, #fff)",
        color: "inherit",
        fontSize: "12px",
      },
      // List shell with a sticky header row and aligned columns.
      listBox: { display: "flex", flexDirection: "column", gap: "0" },
      listHead: {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "6px 10px",
        fontSize: "11px",
        color: "var(--dsw-alias-label-secondary, #888)",
        borderBottom: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))",
      },
      colVersion: { width: "64px", fontVariantNumeric: "tabular-nums" },
      colDate: { width: "92px", fontVariantNumeric: "tabular-nums" },
      colSrc: { width: "80px" },
      colKind: { width: "40px", textAlign: "center" },
      colName: { width: "200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      colGroup: { width: "112px" },
      colParams: { width: "64px" },
      actions: { display: "flex", gap: "6px", justifyContent: "flex-end", minWidth: "124px" },
      // Summary strip: label + value pairs, wrapping on narrow widths.
      summary: { display: "flex", alignItems: "center", gap: "18px", flexWrap: "wrap" },
      summaryItem: { display: "inline-flex", alignItems: "baseline", gap: "6px" },
      toolbar: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
    };

    /* ------------------------------------------------------------ versions */

    function VersionPanel({ ctx, setBusy, setError, setMessage, busy }) {
      const [state, setState] = React.useState({ loading: true, versions: [], active: "", latest: "" });
      const [selected, setSelected] = React.useState("");
      const [hovered, setHovered] = React.useState("");
      // version -> "installing" | "done" | "failed", rendered inside the row.
      const [rowStatus, setRowStatus] = React.useState({});

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

      const install = (entry) => run(`install-${entry.version}`, async () => {
        setRowStatus((current) => ({ ...current, [entry.version]: "installing" }));
        try {
          const value = await callRpc(ctx, "install", { version: entry.version, activate: false }, 1800000);
          setRowStatus((current) => ({ ...current, [entry.version]: "done" }));
          return `已安装 REA ${value.version}（${value.channel}），尚未启用`;
        } catch (cause) {
          setRowStatus((current) => ({ ...current, [entry.version]: "failed" }));
          throw cause;
        }
      });
      const rollback = () => run("rollback", async () => {
        const value = await callRpc(ctx, "rollback", { version: selected }, 1800000);
        return `已回退到 ${value.version}（${value.channel}）${value.session?.tools ? `，MCP ${value.session.tools} 个工具` : ""}`;
      });
      const activate = () => run("activate", async () => {
        const value = await callRpc(ctx, "activate", { version: selected }, 120000);
        return `已启用 ${value.active?.version ?? selected}`;
      });

      const remove = (entry) => run(`remove-${entry.version}`, async () => {
        const value = await callRpc(ctx, "remove", { version: entry.version }, 120000);
        const mb = ((value.removed?.freedBytes ?? 0) / 1048576).toFixed(1);
        return `已删除 REA ${entry.version}，释放 ${mb} MB`;
      });

      const disabled = busy !== "" || state.loading;
      const rows = state.versions ?? [];
      // Per-row outcome, so an install can show 安装中 / 已安装 / 安装失败 in place.
      const statusOf = (version) => rowStatus[version] ?? "";
      const selectedInstalled = rows.find((entry) => entry.version === selected)?.installed === true;

      return h("div", { style: styles.root },
        // Summary strip: what is running now, and what the newest release is.
        h("div", { style: styles.summary },
          h("span", { style: styles.summaryItem },
            h("span", { style: styles.hint }, "当前版本"),
            h("strong", null, state.active || "未安装"),
          ),
          state.node
            ? h("span", { style: styles.summaryItem },
              h("span", { style: styles.hint }, "Node"),
              h("span", null, `${state.node.version}${state.node.satisfiesReaEngines ? "" : "（超出 engines）"}`))
            : null,
          state.latest
            ? h("span", { style: styles.summaryItem },
              h("span", { style: styles.hint }, "最新"),
              h("span", null, state.latest))
            : null,
          selected
            ? h("span", { style: styles.summaryItem },
              h("span", { style: styles.hint }, "选中"),
              h("span", null, selected))
            : h("span", { style: { ...styles.hint, fontSize: "11px" } }, "点一行选中版本"),
        ),
        h("div", { style: styles.toolbar },
          h("button", { type: "button", style: styles.button, disabled, onClick: rollback }, busy === "rollback" ? "回退中…" : "回退到选中版本"),
          h("button", {
            type: "button",
            style: styles.button,
            disabled: disabled || !selectedInstalled || selected === state.active,
            onClick: activate,
          }, busy === "activate" ? "启用中…" : "启用选中的版本"),
          h("span", { style: { flex: 1 } }),
          h("button", { type: "button", style: styles.button, disabled, onClick: () => refresh(true) }, busy === "refresh" ? "刷新中…" : "刷新版本列表"),
        ),
        h("div", { style: styles.listBox },
          h("div", { style: styles.listHead },
            h("span", { style: styles.colVersion }, "版本"),
            h("span", { style: styles.colDate }, "发布"),
            h("span", { style: styles.colSrc }, "来源"),
            h("span", { style: { flex: 1 } }, "状态"),
            h("span", { style: { ...styles.actions, minWidth: "124px" } }, "操作"),
          ),
          h("div", { style: styles.list }, rows.map((entry) => {
            const isActive = entry.version === state.active;
            const rowState = statusOf(entry.version);
            const rowBusy = busy === `install-${entry.version}` || busy === `remove-${entry.version}`;
            return h("div", {
              key: entry.version,
              style: {
                ...styles.item,
                ...(isActive ? styles.itemActive : {}),
                ...(entry.version === selected ? styles.itemSelected : {}),
                ...(hovered === entry.version ? styles.itemHover : {}),
              },
              onClick: () => setSelected(entry.version),
              onMouseEnter: () => setHovered(entry.version),
              onMouseLeave: () => setHovered((current) => (current === entry.version ? "" : current)),
            },
              h("span", { style: styles.colVersion }, entry.version),
              h("span", { style: { ...styles.hint, ...styles.colDate } }, entry.date ? entry.date.slice(0, 10) : "—"),
              h("span", { style: { ...styles.hint, ...styles.colSrc } }, (entry.sources ?? []).join("+")),
              h("span", { style: { flex: 1, display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" } },
                isActive ? h("span", { style: styles.badge }, "当前") : null,
                entry.installed ? h("span", { style: styles.badge }, "已安装") : null,
                entry.deprecated ? h("span", { style: styles.badge }, "已弃用") : null,
                rowState === "installing"
                  ? h("span", { style: { ...styles.badge, ...styles.badgeBusy } }, "安装中…")
                  : rowState === "failed"
                    ? h("span", { style: { ...styles.badge, ...styles.badgeBad } }, "安装失败")
                    : null,
              ),
              // Mutually exclusive per row: not installed → 安装; installed and
              // not the running one → 启用 + 删除; the running one → nothing.
              h("span", { style: styles.actions },
                !entry.installed
                  ? h("button", {
                    type: "button",
                    style: styles.buttonPrimary,
                    disabled: disabled || rowState === "installing",
                    onClick: (event) => {
                      event.stopPropagation();
                      install(entry);
                    },
                  }, rowState === "installing" ? "安装中…" : "安装")
                  : isActive
                    ? null
                    : [
                      h("button", {
                        key: "use",
                        type: "button",
                        style: styles.buttonTiny,
                        disabled,
                        onClick: (event) => {
                          event.stopPropagation();
                          setSelected(entry.version);
                          run("activate", async () => {
                            const value = await callRpc(ctx, "activate", { version: entry.version }, 120000);
                            return `已启用 ${value.active?.version ?? entry.version}`;
                          });
                        },
                      }, "启用"),
                      h("button", {
                        key: "del",
                        type: "button",
                        style: styles.buttonDanger,
                        disabled: rowBusy,
                        onClick: (event) => {
                          event.stopPropagation();
                          remove(entry);
                        },
                      }, busy === `remove-${entry.version}` ? "删除中…" : "删除"),
                    ],
              ),
            );
          })),
        ),
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
      const [hovered, setHovered] = React.useState("");

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
        h("div", { style: styles.listBox },
          h("div", { style: styles.listHead },
            h("span", { style: styles.colKind }, "类型"),
            h("span", { style: { width: "150px" } }, "站点 id"),
            h("span", { style: { width: "52px" } }, "来源"),
            h("span", { style: { flex: 1 } }, "地址"),
            h("span", { style: { width: "120px" } }, "连通性"),
            h("span", { style: styles.actions }, "操作"),
          ),
          h("div", { style: styles.list }, visible.map((mirror) => {
            const last = mirror.last;
            const stateText = last ? (last.ok ? `可用 ${last.ms}ms` : `失败 ${String(last.reason ?? "").slice(0, 48)}`) : "未测试";
            return h("div", {
              key: mirror.id,
              style: { ...styles.item, ...(hovered === mirror.id ? styles.itemHover : {}) },
              onMouseEnter: () => setHovered(mirror.id),
              onMouseLeave: () => setHovered((current) => (current === mirror.id ? "" : current)),
            },
              h("span", { style: { ...styles.badge, ...styles.colKind } }, mirror.kind),
              h("span", { style: { width: "150px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: mirror.id }, mirror.id),
              h("span", { style: { width: "52px" } },
                mirror.origin === "custom"
                  ? h("span", { style: styles.badge }, "自定义")
                  : mirror.origin === "modified" ? h("span", { style: styles.badge }, "已改") : null),
              h("span", { style: { ...styles.hint, ...styles.mono, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: mirror.url }, mirror.url),
              h("span", { style: { width: "120px" } },
                h("span", { style: { ...styles.badge, ...(last ? (last.ok ? styles.badgeOk : styles.badgeBad) : {}) } }, stateText)),
              h("span", { style: styles.actions },
                h("button", { type: "button", style: styles.buttonTiny, disabled: disabled || testing === mirror.id, onClick: () => testOne(mirror.id) }, testing === mirror.id ? "测试中…" : "测试"),
                h("button", { type: "button", style: styles.buttonDanger, disabled, onClick: () => mutate("mirrorRemove", "mirrorRemove", { id: mirror.id }) }, "移除"),
              ),
            );
          })),
        ),
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
    // the tool list. Every parameter below is editable in place.
    function McpBar({ ctx, busy, setBusy, setError, setMessage, status, onStatus }) {
      const running = status?.running === true;
      const disabled = busy !== "";
      const [draft, setDraft] = React.useState({});

      // Keep the inputs in sync with the host whenever it reports new values.
      React.useEffect(() => {
        if (!status) return;
        setDraft({
          startup: String(Math.round((status.startupTimeoutMs ?? 60000) / 1000)),
          tool: String(Math.round((status.toolTimeoutMs ?? 180000) / 1000)),
        });
      }, [status?.startupTimeoutMs, status?.toolTimeoutMs]);

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

      const patch = async (label, payload) => {
        setBusy(`cfg-${label}`);
        setError("");
        setMessage("");
        try {
          const next = await callRpc(ctx, "mcpConfig", payload, 60000);
          onStatus?.(next);
          setMessage(`已保存：${label}`);
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        } finally {
          setBusy("");
        }
      };

      // Timeouts are edited in seconds; the host stores milliseconds.
      const commitTimeout = (field) => {
        const seconds = Number(draft[field]);
        if (!Number.isFinite(seconds) || seconds <= 0) {
          setError("超时必须为正整数秒");
          return;
        }
        patch(field === "startup" ? "启动超时" : "调用超时",
          field === "startup"
            ? { startupTimeoutMs: Math.round(seconds * 1000) }
            : { toolTimeoutMs: Math.round(seconds * 1000) });
      };

      return h("div", { style: styles.bar },
        // Row 1: service identity, live state, and the three lifecycle actions.
        h("div", { style: styles.barTop },
          h("span", { style: styles.title }, "REA 服务"),
          h("span", { style: { ...styles.badge, ...(running ? styles.badgeOk : styles.badgeBad) } },
            running ? `运行中 · ${status.tools} 工具` : "已停止"),
          h("span", { style: { flex: 1 } }),
          h("button", { type: "button", style: styles.buttonPrimary, disabled: disabled || running, onClick: () => act("start") },
            busy === "mcp-start" ? "启动中…" : "启动"),
          h("button", { type: "button", style: styles.button, disabled: disabled || !running, onClick: () => act("restart") },
            busy === "mcp-restart" ? "重启中…" : "重启"),
          h("button", { type: "button", style: styles.buttonDanger, disabled: disabled || !running, onClick: () => act("stop") },
            busy === "mcp-stop" ? "停止中…" : "停止"),
        ),
        // Row 2: one control per parameter, each saved on its own.
        h("div", { style: styles.barFields },
          h("label", { style: styles.field },
            h("span", { style: styles.hint }, "允许自动启动"),
            h("input", {
              type: "checkbox",
              checked: status?.enabled !== false,
              disabled,
              onChange: (event) => patch("允许自动启动", { enabled: event.target.checked }),
            }),
          ),
          h("label", { style: styles.field },
            h("span", { style: styles.hint }, "崩溃自动重连"),
            h("input", {
              type: "checkbox",
              checked: status?.autoReconnect !== false,
              disabled,
              onChange: (event) => patch("崩溃自动重连", { autoReconnect: event.target.checked }),
            }),
          ),
          h("label", { style: styles.field },
            h("span", { style: styles.hint }, "启动超时（秒）"),
            h("input", {
              type: "number",
              min: 5,
              max: 600,
              style: styles.inputNarrow,
              value: draft.startup ?? "",
              disabled,
              onChange: (event) => setDraft((current) => ({ ...current, startup: event.target.value })),
              onBlur: () => commitTimeout("startup"),
              onKeyDown: (event) => {
                if (event.key === "Enter") commitTimeout("startup");
              },
            }),
          ),
          h("label", { style: styles.field },
            h("span", { style: styles.hint }, "调用超时（秒）"),
            h("input", {
              type: "number",
              min: 5,
              max: 3600,
              style: styles.inputNarrow,
              value: draft.tool ?? "",
              disabled,
              onChange: (event) => setDraft((current) => ({ ...current, tool: event.target.value })),
              onBlur: () => commitTimeout("tool"),
              onKeyDown: (event) => {
                if (event.key === "Enter") commitTimeout("tool");
              },
            }),
          ),
          status && status.autoStart === false
            ? h("span", { style: { ...styles.hint, fontSize: "11px" } }, "惰性启动已关闭")
            : null,
        ),
      );
    }

    /* ------------------------------------------------------------ mcp tools */

    function ToolPanel({ ctx, setBusy, setError, setMessage, busy, mcp }) {
      const [state, setState] = React.useState({ loading: true, tools: [], total: 0, enabled: 0, disabled: 0, groups: [] });
      const [query, setQuery] = React.useState("");
      const [group, setGroup] = React.useState("");
      const [onlyDisabled, setOnlyDisabled] = React.useState(false);
      const [detail, setDetail] = React.useState(null);
      const [hovered, setHovered] = React.useState("");

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
        h("div", { style: styles.listBox },
          h("div", { style: styles.listHead },
            h("span", { style: { ...styles.colKind, width: "34px" } }, "状态"),
            h("span", { style: styles.colName }, "工具"),
            h("span", { style: styles.colGroup }, "分组"),
            h("span", { style: styles.colParams }, "参数"),
            h("span", { style: { flex: 1 } }, "说明"),
            h("span", { style: styles.actions }, "操作"),
          ),
          h("div", { style: styles.list }, (state.tools ?? []).map((tool) => h("div", {
            key: tool.name,
            style: {
              ...styles.item,
              ...(detail?.name === tool.name ? styles.itemSelected : {}),
              ...(hovered === tool.name ? styles.itemHover : {}),
            },
            onMouseEnter: () => setHovered(tool.name),
            onMouseLeave: () => setHovered((current) => (current === tool.name ? "" : current)),
          },
            h("span", { style: { ...styles.badge, ...(tool.enabled ? styles.badgeOk : styles.badgeBad), width: "34px", textAlign: "center" } }, tool.enabled ? "开" : "关"),
            h("span", { style: styles.colName, title: tool.name }, tool.name),
            h("span", { style: { ...styles.hint, ...styles.colGroup } }, tool.group),
            h("span", { style: { ...styles.hint, ...styles.colParams } }, `${tool.propertyCount} 参数`),
            h("span", { style: { ...styles.hint, ...styles.mono, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: tool.description }, tool.description),
            h("span", { style: styles.actions },
              h("button", { type: "button", style: styles.buttonTiny, disabled, onClick: () => showSchema(tool) }, "schema"),
              h("button", {
                type: "button",
                style: tool.enabled ? styles.buttonDanger : styles.buttonTiny,
                disabled,
                onClick: () => toggle(tool),
              }, tool.enabled ? "禁用" : "启用"),
            ),
          ))),
        ),
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
        // Header: what this panel is, and where its files live.
        h("div", { style: styles.header },
          h("span", { style: styles.title }, "REA 逆向分析管理器"),
          h("span", { style: styles.subtitle }, "版本安装与回退 · MCP 工具目录 · 代理站点"),
        ),
        // Service control is global to the plugin, so it sits above the tabs.
        h(McpBar, { ctx, busy, setBusy, setError, setMessage, status: mcp, onStatus: setMcp }),
        h("div", { style: styles.tabStrip },
          tabs.map(([id, label]) => h("button", {
            key: id,
            type: "button",
            style: { ...styles.tab, ...(tab === id ? styles.tabActive : {}) },
            onClick: () => setTab(id),
          }, label)),
          h("span", { style: { flex: 1 } }),
          busy ? h("span", { style: { ...styles.hint, fontSize: "11px" } }, "处理中…") : null,
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
