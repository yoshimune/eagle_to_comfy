const fs = require("fs").promises;
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const DEFAULTS = Object.freeze({ baseUrl: "http://127.0.0.1:8188", timeoutSeconds: 30 });

function normalizeUrl(value) {
    let url;
    try {
        url = new URL(value.trim());
    } catch (error) {
        throw new Error("接続先に有効な HTTP(S) URL を入力してください。");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
        url.href.includes("?") || url.href.includes("#")) {
        throw new Error("接続先は HTTP(S) のみです。認証情報・query・fragment は指定できません。");
    }
    return url.href.replace(/\/+$/, "");
}

function validateSettings(value) {
    if (!value || typeof value.baseUrl !== "string") {
        throw new Error("基本接続先の設定が不正です。");
    }
    if (!["number", "string"].includes(typeof value.timeoutSeconds)) {
        throw new Error("タイムアウトの設定が不正です。");
    }
    const timeoutSeconds = Number(value.timeoutSeconds);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 ||
        timeoutSeconds * 1000 > 2147483647) {
        throw new Error("タイムアウトには 0 より大きい秒数（最大 2147483 秒）を指定してください。");
    }
    return { baseUrl: normalizeUrl(value.baseUrl), timeoutSeconds };
}

function effectiveSettings(settings, override) {
    return validateSettings({ ...settings, baseUrl: override.trim() || settings.baseUrl });
}

function createStore(filePath = path.join(
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
    "eagle-to-comfy", "settings.json",
)) {
    return {
        async load() {
            let text;
            try {
                text = await fs.readFile(filePath, "utf8");
            } catch (error) {
                if (error.code === "ENOENT") return { ...DEFAULTS };
                throw new Error(`設定を読み込めません: ${error.message}`);
            }
            try {
                return validateSettings(JSON.parse(text));
            } catch (error) {
                throw new Error(`保存済み設定が不正です。設定を修正して保存してください: ${error.message}`);
            }
        },
        async save(value) {
            const settings = validateSettings(value);
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            const temporary = `${filePath}.${crypto.randomBytes(8).toString("hex")}.tmp`;
            try {
                await fs.writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { flag: "wx" });
                await fs.rename(temporary, filePath);
            } finally {
                try {
                    await fs.unlink(temporary);
                } catch (error) {
                    if (error.code !== "ENOENT") throw error;
                }
            }
            return settings;
        },
    };
}

module.exports = { DEFAULTS, normalizeUrl, validateSettings, effectiveSettings, createStore };
