function createInspector({ eagle, document, metadata, client, settingsApi, store,
    schedule = setInterval, unschedule = clearInterval }) {
    const element = (id) => document.getElementById(id);
    const state = {
        settings: null, item: null, key: null, generation: 0, connection: 0,
        ids: [], loadingClients: false, busy: false, checking: false,
        stopped: false, target: false, savingSettings: false,
    };
    const showError = (error) => {
        element("error").textContent = error.message;
        element("error").hidden = false;
        element("panel").hidden = false;
        console.error("Eagle to ComfyUI:", error.kind || "plugin", error.status || "");
    };
    const clearError = () => {
        element("error").textContent = "";
        element("error").hidden = true;
    };
    const updateButtons = () => {
        const selected = element("clients").value;
        element("build").disabled = !state.target || !state.settings || state.busy ||
            state.loadingClients || !selected || !state.ids.includes(selected);
        element("refresh").disabled = !state.settings || state.busy || state.loadingClients;
        element("clients").disabled = state.busy || state.loadingClients || state.ids.length < 2;
        element("override").disabled = state.busy;
        element("reset-url").disabled = state.busy;
        element("base-url").disabled = state.busy;
        element("timeout").disabled = state.busy;
        element("save-settings").disabled = state.busy || state.savingSettings;
    };
    const getSettings = () => {
        if (!state.settings) throw new Error("プラグイン設定を修正して保存してください。");
        return settingsApi.effectiveSettings(state.settings, element("override").value);
    };
    const renderClients = (ids, previous = "") => {
        const select = element("clients");
        select.replaceChildren();
        const add = (value, text) => {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = text;
            select.appendChild(option);
        };
        if (ids.length !== 1) add("", ids.length ? "反映先を選択してください" : "登録済み接続なし");
        for (const id of ids) add(id, id);
        select.value = ids.length === 1 ? ids[0] : (ids.includes(previous) ? previous : "");
        state.ids = ids;
        updateButtons();
    };
    const invalidateConnection = () => {
        state.connection++;
        state.loadingClients = false;
        renderClients([]);
        element("clients-status").textContent = "接続一覧 GET: 未呼び出し";
        element("restore-status").textContent = "復元 API: 未呼び出し";
    };
    const current = (generation, connection) =>
        !state.stopped && generation === state.generation && connection === state.connection;

    async function refreshClients() {
        if (!state.target || !state.settings || state.busy) return;
        const generation = state.generation;
        const connection = ++state.connection;
        const previous = element("clients").value;
        state.loadingClients = true;
        updateButtons();
        try {
            const settings = getSettings();
            element("effective-url").textContent = `使用する接続先: ${settings.baseUrl}`;
            element("clients-status").textContent = "接続一覧 GET: 呼び出し中";
            const ids = await client.listClients(settings);
            if (!current(generation, connection)) return;
            state.loadingClients = false;
            renderClients(ids, previous);
            element("clients-status").textContent = ids.length ?
                `接続一覧 GET: HTTP 成功、${ids.length} 接続` :
                "接続一覧 GET: HTTP 成功、0 接続。ComfyUI ブラウザーを開き、拡張を読み込んでください。";
        } catch (error) {
            if (!current(generation, connection)) return;
            state.loadingClients = false;
            renderClients([]);
            element("clients-status").textContent = `接続一覧 GET: ${error.called ? "呼び出し後のエラー" : "未呼び出し"} — ${error.message}`;
            showError(error);
        } finally {
            if (current(generation, connection)) updateButtons();
        }
    }

    async function changeConnection() {
        invalidateConnection();
        clearError();
        try {
            element("effective-url").textContent = `使用する接続先: ${getSettings().baseUrl}`;
            await refreshClients();
        } catch (error) {
            element("effective-url").textContent = "接続先が無効です。復元 API は未呼び出しです。";
            showError(error);
        }
    }

    async function checkSelection(force = false) {
        if (state.stopped || state.checking) return;
        state.checking = true;
        let generation = state.generation;
        try {
            const selected = await eagle.item.getSelected();
            state.checking = false;
            if (state.stopped) return;
            const item = selected.length === 1 && String(selected[0].ext).toLowerCase() === "png" ?
                selected[0] : null;
            const key = item ? `${item.id}\0${item.filePath}` : "";
            if (!force && key === state.key) return;
            const changed = key !== state.key;
            state.key = key;
            state.item = item;
            state.target = false;
            generation = ++state.generation;
            invalidateConnection();
            clearError();
            element("panel").hidden = true;
            element("workflow").hidden = true;
            element("description").textContent = "";
            if (changed) element("override").value = "";
            updateButtons();
            if (!item) return;
            const result = await metadata.readMetadata(item.filePath);
            if (state.stopped || generation !== state.generation) return;
            if (!result) return;
            state.target = true;
            element("description").textContent = result.description;
            element("panel").hidden = false;
            element("workflow").hidden = false;
            if (!state.settings) {
                showError(new Error("設定を読み込めませんでした。プラグイン設定を修正して保存してください。"));
                element("settings").open = true;
            } else {
                element("effective-url").textContent = `使用する接続先: ${getSettings().baseUrl}`;
                await refreshClients();
            }
        } catch (error) {
            if (!state.stopped && generation === state.generation) showError(error);
        } finally {
            state.checking = false;
            if (!state.stopped) updateButtons();
        }
    }

    async function build() {
        if (element("build").disabled || state.busy) return;
        const item = state.item;
        const generation = state.generation;
        const connection = state.connection;
        const chosen = element("clients").value;
        let called = false;
        state.busy = true;
        clearError();
        updateButtons();
        element("restore-status").textContent = "復元 API: 未呼び出し（画像・反映先を確認中）";
        try {
            const settings = getSettings();
            try {
                const result = await metadata.readMetadata(item.filePath);
                if (!result) throw new Error("選択画像の provenance メタデータが失われています。");
            } catch (error) {
                if (current(generation, connection)) {
                    state.target = false;
                    element("workflow").hidden = true;
                }
                throw error;
            }
            if (current(generation, connection)) {
                element("clients-status").textContent = "接続一覧 GET: 呼び出し中（実行前確認）";
            }
            let ids;
            try {
                ids = await client.listClients(settings);
            } catch (error) {
                if (current(generation, connection)) {
                    renderClients([]);
                    element("clients-status").textContent = `接続一覧 GET: エラー — ${error.message}`;
                }
                throw error;
            }
            if (!current(generation, connection)) return;
            element("clients-status").textContent = `接続一覧 GET: HTTP 成功、${ids.length} 接続（実行前確認）`;
            if (!ids.includes(chosen)) {
                renderClients(ids);
                // A reconnect must not silently retarget an already chosen browser.
                element("clients").value = "";
                throw new Error("選択したブラウザーが切断・再接続されました。接続一覧を更新して選び直してください。");
            }
            const selected = await eagle.item.getSelected();
            if (!current(generation, connection) || selected.length !== 1 ||
                selected[0].id !== item.id || selected[0].filePath !== item.filePath) {
                if (current(generation, connection)) {
                    element("restore-status").textContent = "復元 API: 未呼び出し（選択画像が変更されました）";
                }
                return;
            }
            const response = await client.restoreImage(settings, item.filePath, chosen, {
                onState() {
                    called = true;
                    if (current(generation, connection)) {
                        element("restore-status").textContent = "復元 API: 呼び出し開始・送信中（サーバー受信は未確認）";
                    }
                },
            });
            if (current(generation, connection)) {
                element("restore-status").textContent = `復元 API: HTTP ${response.status} 成功。画面上の構築完了は未確認です。`;
            }
        } catch (error) {
            if (current(generation, connection)) {
                const label = !called ? "未呼び出し" :
                    error.kind === "timeout" ? "タイムアウト" :
                    error.kind === "http" ? "HTTP エラー" :
                    "呼び出し後のエラー";
                element("restore-status").textContent = `復元 API: ${label} — ${error.message}`;
                showError(error);
            }
        } finally {
            state.busy = false;
            if (!state.stopped) {
                updateButtons();
                if (generation !== state.generation && state.target) await refreshClients();
            }
        }
    }

    element("clients").addEventListener("change", updateButtons);
    element("refresh").addEventListener("click", () => { clearError(); return refreshClients(); });
    element("override").addEventListener("input", () => {
        invalidateConnection();
        element("effective-url").textContent = "接続先変更中。「接続一覧を更新」で適用してください。";
    });
    element("override").addEventListener("change", changeConnection);
    element("reset-url").addEventListener("click", () => {
        element("override").value = "";
        return changeConnection();
    });
    element("build").addEventListener("click", build);
    element("settings-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        if (state.busy || state.savingSettings) return;
        state.savingSettings = true;
        updateButtons();
        try {
            const saved = await store.save({
                baseUrl: element("base-url").value,
                timeoutSeconds: element("timeout").value,
            });
            state.settings = saved;
            element("base-url").value = saved.baseUrl;
            element("timeout").value = saved.timeoutSeconds;
            element("settings-status").textContent = "設定を保存しました。";
            clearError();
            if (!state.busy) await changeConnection();
        } catch (error) {
            element("settings-status").textContent = `設定を保存できません: ${error.message}`;
            showError(error);
        } finally {
            state.savingSettings = false;
            updateButtons();
        }
    });

    let interval;
    return {
        async start() {
            try {
                state.settings = await store.load();
            } catch (error) {
                element("settings-status").textContent = error.message;
                element("settings").open = true;
                console.error("Eagle to ComfyUI: settings load failed");
            }
            const initial = state.settings || settingsApi.DEFAULTS;
            element("base-url").value = initial.baseUrl;
            element("timeout").value = initial.timeoutSeconds;
            document.body.dataset.theme = await eagle.app.theme;
            eagle.onThemeChanged((theme) => { document.body.dataset.theme = theme; });
            if (eagle.onPluginShow) eagle.onPluginShow(() => checkSelection(true));
            if (eagle.onLibraryChanged) eagle.onLibraryChanged(() => {
                state.key = null;
                state.generation++;
                element("override").value = "";
                element("panel").hidden = true;
                return checkSelection(true);
            });
            // Eagle does not document a selection-change event for inspector plugins.
            interval = schedule(checkSelection, 500);
            await checkSelection();
        },
        checkSelection,
        refreshClients,
        build,
        stop() {
            state.stopped = true;
            state.generation++;
            if (interval !== undefined) unschedule(interval);
        },
    };
}

if (typeof module !== "undefined") module.exports = { createInspector };

if (typeof eagle !== "undefined") {
    eagle.onPluginCreate(async (plugin) => {
        const path = require("path");
        const load = (name) => require(path.join(plugin.path, "js", name));
        const settingsApi = load("settings.js");
        const inspector = createInspector({
            eagle, document, settingsApi, store: settingsApi.createStore(),
            metadata: load("png-metadata.js"), client: load("comfy-client.js"),
        });
        window.addEventListener("unload", () => inspector.stop());
        try {
            await inspector.start();
        } catch (error) {
            document.getElementById("panel").hidden = false;
            document.getElementById("error").hidden = false;
            document.getElementById("error").textContent = `プラグインを開始できません: ${error.message}`;
            console.error("Eagle to ComfyUI: initialization failed");
        }
    });
}
