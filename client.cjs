// dsh-rea client half: settings section for version selection, update, rollback.
//
// The panel talks to the host half through the plugin RPC route
// `/api/plugin-rpc/dsh-rea` and exposes exactly the operations the host tools
// expose, so the GUI and the model drive the same code paths.
window.__ModuleLoader__.load({
  id: "dsh-rea",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;

    const NAME = "dsh-rea";
    const RPC_METHOD = "plugin-rpc/dsh-rea";

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
      list: {
        maxHeight: "260px",
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
      error: { color: "#dc2626", whiteSpace: "pre-wrap" },
      ok: { color: "#16a34a", whiteSpace: "pre-wrap" },
      log: {
        maxHeight: "160px",
        overflow: "auto",
        padding: "6px 8px",
        borderRadius: "8px",
        background: "var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08))",
        whiteSpace: "pre-wrap",
        fontFamily: "ui-monospace, monospace",
      },
    };

    function Panel({ ctx }) {
      const [state, setState] = React.useState({ loading: true, versions: [], active: "", latest: "" });
      const [selected, setSelected] = React.useState("");
      const [busy, setBusy] = React.useState("");
      const [message, setMessage] = React.useState("");
      const [error, setError] = React.useState("");

      const refresh = React.useCallback(async (force) => {
        setBusy(force ? "refresh" : "load");
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
      }, [ctx]);

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
      }, [refresh]);

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

      const probe = () => run("mirrors", async () => {
        const results = await callRpc(ctx, "mirrors", {}, 600000);
        const ok = results.filter((entry) => entry.ok).length;
        const lines = results
          .slice()
          .sort((left, right) => Number(right.ok) - Number(left.ok) || left.ms - right.ms)
          .slice(0, 12)
          .map((entry) => `${entry.ok ? "OK  " : "FAIL"} ${String(entry.ms).padStart(6, " ")}ms ${entry.kind}/${entry.id}`);
        return `镜像探测：${ok}/${results.length} 可达\n${lines.join("\n")}`;
      });

      const disabled = busy !== "" || state.loading;
      const rows = state.versions ?? [];

      return h("div", { style: styles.root },
        h("div", { style: styles.title }, "REA 逆向分析引擎"),
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
          h("button", { type: "button", style: styles.button, disabled, onClick: probe }, busy === "mirrors" ? "探测中…" : "探测镜像"),
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
        error ? h("div", { style: styles.error }, error) : null,
        message ? h("div", { style: styles.log }, message) : null,
      );
    }

    function apply(ctx) {
      ctx.effect(() => {
        try {
          return ctx.slots.inject("settings.section", () => ctx.slots.register({
            name: "settings.section",
            id: "dsh-rea",
            order: 48,
            label: () => "REA 逆向分析",
          }, (props) => h(Panel, { ...props, ctx })));
        } catch (error) {
          try {
            console.warn("[dsh-rea] settings.section 槽位不可用：", error);
          } catch {
            /* ignore */
          }
          return () => {};
        }
      }, "dsh-rea: settings panel");
    }

    return { apply, inject: ["slots"], name: NAME };
  },
});
