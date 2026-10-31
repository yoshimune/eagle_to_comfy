const assert = require("assert").strict;
const fs = require("fs").promises;
const os = require("os");
const path = require("path");
const http = require("http");
const { readMetadata } = require("..\\js\\png-metadata");
const settingsApi = require("..\\js\\settings");
const { listClients, restoreImage } = require("..\\js\\comfy-client");
const { createInspector } = require("..\\js\\inspector");
const { chunk, provenancePng } = require(".\\fixtures");

const tests = [];
const test = (name, run) => tests.push({ name, run });
let temporary;
const writePng = async (data, name = "画像.png") => {
    const filePath = path.join(temporary, name);
    await fs.writeFile(filePath, data);
    return filePath;
};
const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
async function withServer(handler, run) {
    const sockets = new Set();
    const server = http.createServer(handler);
    server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        await run({ baseUrl: `http://127.0.0.1:${server.address().port}`, timeoutSeconds: 2 });
    } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
    }
}

test("PNG: preserves Unicode, line breaks and literal HTML", async () => {
    assert.deepEqual(await readMetadata(await writePng(provenancePng())), {
        description: "日本語の説明\n<script>alert(1)</script>",
    });
});
test("PNG: ordinary and standard ComfyUI images are not provenance", async () => {
    const data = provenancePng({ ordinary: true, extraChunks: [
        chunk("tEXt", Buffer.from('prompt\0{"1":{}}')),
        chunk("tEXt", Buffer.from('workflow\0{"nodes":[]}')),
    ] });
    assert.equal(await readMetadata(await writePng(data)), null);
    assert.equal(await readMetadata(await writePng(Buffer.from("not a PNG"))), null);
});
test("PNG: rejects incomplete, duplicate and unknown provenance", async () => {
    for (const options of [
        { omitDescription: true }, { omitBundle: true }, { bundleVersion: 2 },
        { format: "comfyui-png-provenance/2" },
        { extraChunks: [chunk("tEXt", Buffer.from("ComfyProvenanceFormat\0comfyui-png-provenance/1"))] },
        { extraChunks: [chunk("cpRV", Buffer.from("invalid"))] },
    ]) {
        await assert.rejects(readMetadata(await writePng(provenancePng(options))));
    }
});
test("PNG: rejects truncation, bad lengths, bad UTF-8 and text CRC", async () => {
    const good = provenancePng();
    await assert.rejects(readMetadata(await writePng(good.subarray(0, good.length - 2))));
    const badLength = Buffer.from(good);
    badLength.writeUInt32BE(0xffffffff, 8);
    await assert.rejects(readMetadata(await writePng(badLength)), /長さ/);
    const badCrc = Buffer.from(good);
    badCrc[badCrc.indexOf(Buffer.from("Description")) + 16] ^= 1;
    await assert.rejects(readMetadata(await writePng(badCrc)), /CRC/);
    const invalidUtf8 = Buffer.concat([Buffer.from("Description\0"), Buffer.alloc(4), Buffer.from([255])]);
    await assert.rejects(readMetadata(await writePng(provenancePng({
        omitDescription: true, extraChunks: [chunk("iTXt", invalidUtf8)],
    }))), /encoded|encoding|UTF/i);
});
test("PNG: skips a sparse 256 MiB cpRV instead of allocating it", async () => {
    const data = provenancePng({ omitBundle: true });
    const iend = data.subarray(data.length - 12);
    const start = data.subarray(0, data.length - 12);
    const header = Buffer.alloc(8);
    const length = 256 * 1024 * 1024;
    header.writeUInt32BE(length);
    header.write("cpRV", 4);
    const filePath = path.join(temporary, "large.png");
    const file = await fs.open(filePath, "w");
    try {
        await file.write(start);
        await file.write(header);
        await file.write(Buffer.concat([Buffer.from("COMFY-PROVENANCE\0"), Buffer.from([0, 1])]));
        await file.write(Buffer.concat([Buffer.alloc(4), iend]), 0, 16, start.length + 8 + length);
    } finally {
        await file.close();
    }
    assert.equal((await readMetadata(filePath)).description, "日本語の説明\n<script>alert(1)</script>");
});
test("Settings: defaults, atomic persistence and override precedence", async () => {
    const store = settingsApi.createStore(path.join(temporary, "settings", "settings.json"));
    assert.deepEqual(await store.load(), { baseUrl: "http://127.0.0.1:8188", timeoutSeconds: 30 });
    const saved = await store.save({ baseUrl: "https://example.test/comfy///", timeoutSeconds: "12.5" });
    assert.deepEqual(await store.load(), saved);
    assert.equal(saved.baseUrl, "https://example.test/comfy");
    assert.equal(settingsApi.effectiveSettings(saved, " ").baseUrl, saved.baseUrl);
    assert.equal(settingsApi.effectiveSettings(saved, "http://localhost:9000/").baseUrl, "http://localhost:9000");
    assert.equal(settingsApi.effectiveSettings(saved, "http://localhost:9000").timeoutSeconds, 12.5);
    await store.save({ ...saved, timeoutSeconds: 7 });
    assert.equal((await store.load()).timeoutSeconds, 7);
});
test("Settings: rejects invalid URLs and timeouts without silent fallback", async () => {
    for (const url of ["file:///a", "not url", "https://name:secret@example.test",
        "http://a/?x=1", "http://a/#x", "http://a/?", "http://a/#"]) {
        assert.throws(() => settingsApi.normalizeUrl(url));
    }
    for (const timeoutSeconds of ["", "abc", 0, -1, Infinity, 2147484, true, null]) {
        assert.throws(() => settingsApi.validateSettings({ ...settingsApi.DEFAULTS, timeoutSeconds }));
    }
    const filePath = path.join(temporary, "corrupt-settings.json");
    await fs.writeFile(filePath, "broken");
    await assert.rejects(settingsApi.createStore(filePath).load(), /保存済み設定/);
});
test("API: fetches and validates clients with a base path", async () => {
    await withServer((req, res) => {
        assert.equal(req.url, "/comfy/provenance/clients");
        assert.equal(req.method, "GET");
        res.end(JSON.stringify({ clients: [{ client_id: "browser-1" }, { client_id: "browser-2" }] }));
    }, async (settings) => {
        assert.deepEqual(await listClients({ ...settings, baseUrl: `${settings.baseUrl}/comfy/` }),
            ["browser-1", "browser-2"]);
    });
    for (const response of ['{"clients":[]}', '{"clients":[{"client_id":""}]}',
        '{"clients":[{"client_id":"x"},{"client_id":"x"}]}', "not json", "{}"]) {
        await withServer((req, res) => res.end(response), async (settings) => {
            if (response === '{"clients":[]}') assert.deepEqual(await listClients(settings), []);
            else await assert.rejects(listClients(settings), (error) => error.kind === "response" && error.called);
        });
    }
});
test("API: sends unchanged PNG and explicit client_id as multipart", async () => {
    const png = provenancePng();
    const filePath = await writePng(png);
    let requests = 0;
    await withServer((req, res) => {
        requests++;
        assert.equal(req.url, "/provenance/restore");
        assert.equal(req.method, "POST");
        const parts = [];
        req.on("data", (data) => parts.push(data));
        req.on("end", () => {
            const body = Buffer.concat(parts);
            assert.equal(Number(req.headers["content-length"]), body.length);
            assert.match(req.headers["content-type"], /^multipart\/form-data; boundary=/);
            assert(body.includes(Buffer.from('name="client_id"\r\n\r\nbrowser-1')));
            assert(body.includes(Buffer.from('filename="画像.png"')));
            assert(body.includes(png));
            res.end('{"prompt":"must not be parsed","notification":{"status":"sent"}}');
        });
    }, async (settings) => {
        const states = [];
        const result = await restoreImage(settings, filePath, "browser-1", { onState: (value) => states.push(value) });
        assert.deepEqual(states, ["called"]);
        assert.deepEqual(result, { status: 200, text: "" });
    });
    assert.equal(requests, 1);
    assert.deepEqual(await fs.readFile(filePath), png);
});
test("API: GET and POST accept Eagle renderer URLs under Node 16", async () => {
    const originalURL = global.URL;
    const NodeURL = require("url").URL;
    class RendererURL {
        constructor(value) {
            const parsed = new NodeURL(value);
            for (const key of ["href", "protocol", "hostname", "port", "pathname",
                "search", "hash", "username", "password"]) {
                this[key] = parsed[key];
            }
        }
    }
    const filePath = await writePng(provenancePng());
    global.URL = RendererURL;
    try {
        await withServer((req, res) => {
            req.resume();
            req.on("end", () => {
                res.end(req.method === "GET" ? '{"clients":[{"client_id":"browser"}]}' : "{}");
            });
        }, async (settings) => {
            const connection = { ...settings, baseUrl: `${settings.baseUrl}/comfy` };
            assert.deepEqual(await listClients(connection), ["browser"]);
            assert.equal((await restoreImage(connection, filePath, "browser")).status, 200);
        });
    } finally {
        global.URL = originalURL;
    }
});
test("API: reports HTTP errors without following redirects or retrying", async () => {
    const filePath = await writePng(provenancePng());
    for (const status of [302, 400, 409, 413, 500]) {
        let count = 0;
        await withServer((req, res) => {
            count++;
            req.resume();
            req.on("end", () => {
                res.writeHead(status, { Location: "http://127.0.0.1:1/elsewhere" });
                res.end('{"error":"test failure","prompt":{"hidden":true}}');
            });
        }, async (settings) => {
            await assert.rejects(restoreImage(settings, filePath, "browser"), (error) =>
                error.kind === "http" && error.status === status && error.called && /test failure/.test(error.message));
        });
        assert.equal(count, 1);
    }
});
test("API: preflight failures do not call the restore endpoint", async () => {
    let count = 0;
    await withServer((req, res) => { count++; res.end(); }, async (settings) => {
        const png = await writePng(provenancePng());
        await assert.rejects(restoreImage(settings, png, ""), (error) => !error.called);
        await assert.rejects(restoreImage(settings, path.join(temporary, "missing.png"), "x"), (error) => !error.called);
        const bad = await writePng(Buffer.from("not a PNG"), "bad.png");
        await assert.rejects(restoreImage(settings, bad, "x"), (error) => !error.called);
    });
    assert.equal(count, 0);
});
test("API: enforces total request timeout on a trickling response", async () => {
    const png = await writePng(provenancePng());
    let count = 0;
    await withServer((req, res) => {
        count++;
        req.resume();
        res.writeHead(200);
        const timer = setInterval(() => res.write(" "), 10);
        res.on("close", () => clearInterval(timer));
    }, async (settings) => {
        await assert.rejects(restoreImage({ ...settings, timeoutSeconds: 0.08 }, png, "x"),
            (error) => error.kind === "timeout" && error.called && /処理された可能性/.test(error.message));
    });
    assert.equal(count, 1);
});
test("API: connection loss is explicit", async () => {
    await withServer((req) => req.socket.destroy(), async (settings) => {
        await assert.rejects(listClients(settings), (error) => error.kind === "network" && error.called);
    });
});

class Element {
    constructor() {
        this.value = "";
        this.textContent = "";
        this.hidden = false;
        this.disabled = false;
        this.children = [];
        this.listeners = {};
    }
    replaceChildren() { this.children = []; this.value = ""; }
    appendChild(child) { this.children.push(child); }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    async fire(name) { return this.listeners[name]({ preventDefault() {} }); }
}
function uiHarness({ ids = ["browser-1"], read, api = {}, initialSettings } = {}) {
    const elements = new Map();
    const element = (id) => {
        if (!elements.has(id)) elements.set(id, new Element());
        return elements.get(id);
    };
    const item = { id: "image-1", filePath: "C:\\images\\one.png", ext: "png" };
    let selection = [item];
    let stored = initialSettings || { ...settingsApi.DEFAULTS };
    const calls = [];
    const callbacks = {};
    const inspector = createInspector({
        eagle: {
            item: { getSelected: async () => selection },
            app: { theme: Promise.resolve("DARK") },
            onThemeChanged: (fn) => { callbacks.theme = fn; },
            onPluginShow: (fn) => { callbacks.show = fn; },
            onLibraryChanged: (fn) => { callbacks.library = fn; },
        },
        document: { getElementById: element, createElement: () => new Element(), body: { dataset: {} } },
        settingsApi,
        store: {
            load: async () => stored,
            save: async (value) => { stored = settingsApi.validateSettings(value); return stored; },
        },
        metadata: { readMetadata: read || (async () => ({ description: "<b>日本語</b>\nnext" })) },
        client: {
            listClients: api.listClients || (async () => ids),
            restoreImage: api.restoreImage || (async (...args) => {
                calls.push(args);
                args[3].onState();
                return { status: 200 };
            }),
        },
        schedule: () => 1,
        unschedule: () => {},
    });
    return { inspector, element, calls, callbacks, item, setSelection: (next) => { selection = next; } };
}
test("Inspector: conditional display and ephemeral URL reset", async () => {
    const ui = uiHarness({ read: async (file) => file.endsWith("ordinary.png") ? null :
        { description: "<b>日本語</b>\nnext" } });
    await ui.inspector.start();
    assert.equal(ui.element("panel").hidden, false);
    assert.equal(ui.element("description").textContent, "<b>日本語</b>\nnext");
    assert.equal(ui.element("build").disabled, false);
    ui.element("override").value = "http://localhost:9999";
    await ui.element("override").fire("change");
    await ui.inspector.build();
    assert.equal(ui.calls[0][0].baseUrl, "http://localhost:9999");
    assert.equal(ui.calls[0][0].timeoutSeconds, 30);
    assert.match(ui.element("restore-status").textContent, /HTTP 200.*未確認/);
    ui.setSelection([{ ...ui.item, id: "image-2", filePath: "C:\\images\\ordinary.png" }]);
    await ui.inspector.checkSelection();
    assert.equal(ui.element("override").value, "");
    assert.equal(ui.element("panel").hidden, true);
    ui.setSelection([ui.item, ui.item]);
    await ui.inspector.checkSelection();
    assert.equal(ui.element("workflow").hidden, true);
    ui.inspector.stop();
});
test("Inspector: requires explicit choice for multiple clients and never sends with zero", async () => {
    for (const ids of [[], ["a", "b"]]) {
        const ui = uiHarness({ ids });
        await ui.inspector.start();
        assert.equal(ui.element("build").disabled, true);
        await ui.inspector.build();
        assert.equal(ui.calls.length, 0);
        if (ids.length) {
            ui.element("clients").value = "b";
            await ui.element("clients").fire("change");
            await ui.inspector.build();
            assert.equal(ui.calls[0][2], "b");
        }
        ui.inspector.stop();
    }
});
test("Inspector: disappeared client does not silently select its replacement", async () => {
    let count = 0;
    const ui = uiHarness({ api: { listClients: async () => ++count === 1 ? ["old"] : ["new"] } });
    await ui.inspector.start();
    await ui.inspector.build();
    assert.equal(ui.calls.length, 0);
    assert.equal(ui.element("build").disabled, true);
    assert.match(ui.element("restore-status").textContent, /未呼び出し.*選び直し/);
    ui.inspector.stop();
});
test("Inspector: stale client responses cannot overwrite a new connection", async () => {
    const wait = deferred();
    let count = 0;
    const ui = uiHarness({ api: { listClients: async () => ++count === 1 ? ["first"] :
        count === 2 ? wait.promise : ["latest"] } });
    await ui.inspector.start();
    const old = ui.inspector.refreshClients();
    ui.element("override").value = "http://localhost:9000";
    await ui.element("override").fire("change");
    wait.resolve(["outdated"]);
    await old;
    assert.equal(ui.element("clients").value, "latest");
    ui.inspector.stop();
});
test("Inspector: duplicate clicks blocked and old POST status does not leak to next image", async () => {
    const pending = deferred();
    let count = 0;
    const ui = uiHarness({ api: { restoreImage: async (settings, file, id, options) => {
        count++;
        options.onState();
        return pending.promise;
    } } });
    await ui.inspector.start();
    const build = ui.inspector.build();
    await new Promise((resolve) => setImmediate(resolve));
    await ui.inspector.build();
    assert.equal(count, 1);
    assert.equal(ui.element("save-settings").disabled, true);
    ui.element("timeout").value = "99";
    await ui.element("settings-form").fire("submit");
    ui.setSelection([{ ...ui.item, id: "other", filePath: "C:\\images\\other.png" }]);
    await ui.inspector.checkSelection();
    pending.resolve({ status: 200 });
    await build;
    assert.equal(ui.element("restore-status").textContent, "復元 API: 未呼び出し");
    assert.equal(ui.element("build").disabled, false);
    assert.equal(ui.element("timeout").disabled, false);
    ui.inspector.stop();
});
test("Inspector: stale metadata failures cannot appear on a newly selected image", async () => {
    const wait = deferred();
    let count = 0;
    const ui = uiHarness({ read: async () => ++count === 1 ? wait.promise : { description: "latest" } });
    const start = ui.inspector.start();
    await new Promise((resolve) => setImmediate(resolve));
    ui.setSelection([{ ...ui.item, id: "new", filePath: "C:\\images\\new.png" }]);
    await ui.inspector.checkSelection();
    wait.reject(new Error("outdated parse failure"));
    await start;
    assert.equal(ui.element("description").textContent, "latest");
    assert.equal(ui.element("error").hidden, true);
    ui.inspector.stop();
});
test("Inspector: selection changed during preflight prevents POST", async () => {
    const wait = deferred();
    let count = 0;
    const ui = uiHarness({ api: { listClients: async () => ++count === 1 ? ["browser-1"] : wait.promise } });
    await ui.inspector.start();
    const build = ui.inspector.build();
    await new Promise((resolve) => setImmediate(resolve));
    ui.setSelection([]);
    wait.resolve(["browser-1"]);
    await build;
    assert.equal(ui.calls.length, 0);
    assert.match(ui.element("restore-status").textContent, /未呼び出し.*変更/);
    ui.inspector.stop();
});
test("Inspector: failed preflight GET is not reported as a restore POST call", async () => {
    let count = 0;
    const ui = uiHarness({ api: { listClients: async () => {
        if (++count === 1) return ["browser-1"];
        const error = new Error("HTTP 404");
        error.kind = "http";
        error.status = 404;
        error.called = true;
        throw error;
    } } });
    await ui.inspector.start();
    await ui.inspector.build();
    assert.equal(ui.calls.length, 0);
    assert.match(ui.element("restore-status").textContent, /未呼び出し/);
    assert.match(ui.element("clients-status").textContent, /GET: エラー.*404/);
    assert.equal(ui.element("build").disabled, true);
    ui.inspector.stop();
});
test("Inspector: metadata lost before sending hides the workflow controls", async () => {
    let count = 0;
    const ui = uiHarness({ read: async () => ++count === 1 ? { description: "initial" } : null });
    await ui.inspector.start();
    await ui.inspector.build();
    assert.equal(ui.calls.length, 0);
    assert.equal(ui.element("workflow").hidden, true);
    assert.equal(ui.element("build").disabled, true);
    assert.match(ui.element("restore-status").textContent, /未呼び出し/);
    ui.inspector.stop();
});
test("Inspector: explicit POST timeout and HTTP errors, never a completion claim", async () => {
    for (const kind of ["timeout", "http"]) {
        const ui = uiHarness({ api: { restoreImage: async (settings, file, id, options) => {
            options.onState();
            const error = new Error(kind === "timeout" ? "処理された可能性があります" : "HTTP 409");
            error.kind = kind;
            error.called = true;
            throw error;
        } } });
        await ui.inspector.start();
        await ui.inspector.build();
        assert.match(ui.element("restore-status").textContent, kind === "timeout" ? /タイムアウト/ : /HTTP エラー/);
        assert.equal(ui.element("error").hidden, false);
        assert.equal(ui.element("build").disabled, false);
        ui.inspector.stop();
    }
});
test("Inspector: saves timeout setting and uses it for restore", async () => {
    const ui = uiHarness();
    await ui.inspector.start();
    ui.element("base-url").value = "http://localhost:8189";
    ui.element("timeout").value = "45";
    await ui.element("settings-form").fire("submit");
    await ui.inspector.build();
    assert.equal(ui.calls[0][0].timeoutSeconds, 45);
    assert.equal(ui.calls[0][0].baseUrl, "http://localhost:8189");
    ui.inspector.stop();
});

(async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), "eagle-to-comfy-test-"));
    let failed = 0;
    try {
        for (const { name, run } of tests) {
            try {
                await run();
                console.log(`PASS ${name}`);
            } catch (error) {
                failed++;
                console.error(`FAIL ${name}\n${error.stack}`);
            }
        }
    } finally {
        const entries = await fs.readdir(temporary, { withFileTypes: true });
        for (const entry of entries) {
            const resolved = path.join(temporary, entry.name);
            if (entry.isDirectory()) {
                for (const filename of await fs.readdir(resolved)) await fs.unlink(path.join(resolved, filename));
                await fs.rmdir(resolved);
            } else {
                await fs.unlink(resolved);
            }
        }
        await fs.rmdir(temporary);
    }
    console.log(`${tests.length - failed}/${tests.length} passed`);
    if (failed) process.exitCode = 1;
})();
