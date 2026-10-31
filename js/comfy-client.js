const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { validateSettings } = require("./settings");

const MAX_RESPONSE_BYTES = 1024 * 1024;

class RequestError extends Error {
    constructor(message, { kind, status, called } = {}) {
        super(message);
        this.kind = kind;
        this.status = status;
        this.called = Boolean(called);
    }
}

function request(settings, route, { method = "GET", upload, onState = () => {} } = {}) {
    const validated = validateSettings(settings);
    const url = new URL(`${validated.baseUrl}${route}`);
    return new Promise((resolve, reject) => {
        let source;
        let response;
        let requestObject;
        let settled = false;
        let called = false;
        let timer;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (source) source.destroy();
            if (error) {
                if (response) response.destroy();
                if (requestObject) requestObject.destroy();
                reject(error);
            } else {
                if (requestObject && !requestObject.writableFinished) requestObject.destroy();
                resolve(value);
            }
        };
        const fail = (message, kind = "network", status) => {
            finish(new RequestError(message, { kind, status, called }));
        };
        const headers = {};
        if (upload) {
            headers["Content-Type"] = `multipart/form-data; boundary=${upload.boundary}`;
            headers["Content-Length"] = upload.prefix.length + upload.size + upload.suffix.length;
        }
        try {
            // Eagle's renderer URL is not recognized as a Node.js URL in Node 16.
            requestObject = (url.protocol === "https:" ? https : http).request(url.href, {
                method, headers,
            }, (incoming) => {
                response = incoming;
                const status = incoming.statusCode;
                const success = status >= 200 && status < 300;
                const chunks = [];
                let length = 0;
                incoming.on("data", (chunk) => {
                    if (method === "POST" && success) return;
                    length += chunk.length;
                    if (length > MAX_RESPONSE_BYTES) {
                        fail("API 応答が上限の 1 MiB を超えています。", "response", status);
                    } else {
                        chunks.push(chunk);
                    }
                });
                incoming.on("aborted", () => fail(
                    "API 応答中に接続が切れました。サーバー側で処理された可能性があります。",
                ));
                incoming.on("error", (error) => fail(`API 応答を受信できません: ${error.message}`));
                incoming.on("end", () => {
                    if (settled) return;
                    if (!success) {
                        const text = Buffer.concat(chunks).toString("utf8");
                        let detail = "";
                        try {
                            const body = JSON.parse(text);
                            if (typeof body.error === "string") detail = `: ${body.error}`;
                        } catch (error) {
                            if (!(error instanceof SyntaxError)) {
                                fail(`エラー応答を解析できません: ${error.message}`, "response", status);
                                return;
                            }
                        }
                        fail(`HTTP ${status}${detail}`, "http", status);
                        return;
                    }
                    finish(null, { status, text: Buffer.concat(chunks).toString("utf8") });
                });
            });
            requestObject.on("error", (error) => fail(
                `通信エラー: ${error.message}。呼び出し開始後はサーバー側で処理された可能性があります。`,
            ));
            timer = setTimeout(() => fail(
                `タイムアウト（${validated.timeoutSeconds} 秒）。サーバー側で処理された可能性があります。自動再試行はしません。`,
                "timeout",
            ), validated.timeoutSeconds * 1000);
            called = true;
            onState("called");
            if (upload) {
                source = fs.createReadStream(upload.filePath, { fd: upload.fd, autoClose: false, start: 0 });
                source.on("error", (error) => fail(`画像を読み込めません: ${error.message}`, "file"));
                requestObject.write(upload.prefix);
                source.pipe(requestObject, { end: false });
                source.on("end", () => {
                    if (!settled) requestObject.end(upload.suffix);
                });
            } else {
                requestObject.end();
            }
        } catch (error) {
            fail(`API 呼び出しを開始できません: ${error.message}`, "request");
        }
    });
}

async function listClients(settings, options) {
    const result = await request(settings, "/provenance/clients", options);
    let data;
    try {
        data = JSON.parse(result.text);
    } catch (error) {
        throw new RequestError("接続一覧の JSON が不正です。", {
            kind: "response", status: result.status, called: true,
        });
    }
    if (!data || !Array.isArray(data.clients) || data.clients.some((client) =>
        !client || typeof client.client_id !== "string" || !client.client_id.trim())) {
        throw new RequestError("接続一覧の応答形式が不正です。", {
            kind: "response", status: result.status, called: true,
        });
    }
    const ids = data.clients.map((client) => client.client_id);
    if (new Set(ids).size !== ids.length) {
        throw new RequestError("接続一覧に client_id の重複があります。", {
            kind: "response", status: result.status, called: true,
        });
    }
    return ids;
}

async function restoreImage(settings, filePath, clientId, options = {}) {
    validateSettings(settings);
    if (typeof clientId !== "string" || !clientId.trim() || /[\r\n]/.test(clientId)) {
        throw new RequestError("反映先ブラウザーを選択してください。", { kind: "validation" });
    }
    let file;
    try {
        file = await fs.promises.open(filePath, "r");
    } catch (error) {
        throw new RequestError(`送信画像を開けません: ${error.message}`, { kind: "file" });
    }
    try {
        const stat = await file.stat();
        if (!stat.isFile()) throw new RequestError("送信対象がファイルではありません。", { kind: "file" });
        const signature = Buffer.alloc(8);
        const { bytesRead } = await file.read(signature, 0, 8, 0);
        if (bytesRead !== 8 || !signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
            throw new RequestError("送信対象が PNG ではありません。", { kind: "file" });
        }
        const boundary = `eagle-comfy-${crypto.randomBytes(24).toString("hex")}`;
        const filename = path.basename(filePath).replace(/["\r\n\\]/g, "_");
        const prefix = Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="client_id"\r\n\r\n${clientId}\r\n` +
            `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\n` +
            "Content-Type: image/png\r\n\r\n",
        );
        const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
        return await request(settings, "/provenance/restore", {
            ...options, method: "POST",
            upload: { boundary, prefix, suffix, size: stat.size, filePath, fd: file },
        });
    } finally {
        await file.close();
    }
}

module.exports = { RequestError, listClients, restoreImage };
