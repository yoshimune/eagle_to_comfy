const fs = require("fs").promises;
const { TextDecoder } = require("util");

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAGIC = Buffer.from("COMFY-PROVENANCE\0", "ascii");
const FORMAT = "comfyui-png-provenance/1";
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });
const crcTable = Array.from({ length: 256 }, (_, value) => {
    for (let bit = 0; bit < 8; bit++) {
        value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    return value >>> 0;
});

function crc32(data) {
    let crc = 0xffffffff;
    for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

async function readAt(file, position, length) {
    const result = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
        const { bytesRead } = await file.read(result, offset, length - offset, position + offset);
        if (!bytesRead) throw new Error("PNG が途中で切れています。");
        offset += bytesRead;
    }
    return result;
}

function readDescription(data) {
    const keywordEnd = data.indexOf(0);
    let offset = keywordEnd + 1;
    if (offset + 2 > data.length || data[offset] !== 0 || data[offset + 1] !== 0) {
        throw new Error("Description は非圧縮 iTXt である必要があります。");
    }
    offset += 2;
    for (let field = 0; field < 2; field++) {
        const end = data.indexOf(0, offset);
        if (end < 0) throw new Error("Description の iTXt ヘッダーが不正です。");
        offset = end + 1;
    }
    return decoder.decode(data.subarray(offset));
}

async function readMetadata(filePath) {
    const file = await fs.open(filePath, "r");
    try {
        const { size } = await file.stat();
        if (size < 8 || !(await readAt(file, 0, 8)).equals(SIGNATURE)) return null;
        let position = 8;
        let format;
        let description;
        let hasBundle = false;
        let ended = false;
        let first = true;
        let identificationError;
        while (position < size) {
            const header = await readAt(file, position, 8);
            const length = header.readUInt32BE(0);
            const type = header.toString("ascii", 4, 8);
            if (length > 0x7fffffff || position + length + 12 > size) {
                throw new Error("PNG チャンクの長さが不正です。");
            }
            if (first && (type !== "IHDR" || length !== 13)) {
                throw new Error("PNG の IHDR が不正です。");
            }
            first = false;
            if (type === "cpRV") {
                if (hasBundle) throw new Error("cpRV チャンクが重複しています。");
                hasBundle = true;
                if (length < MAGIC.length + 2) {
                    identificationError = new Error("provenance ヘッダーが途中で切れています。");
                } else {
                    const bundleHeader = await readAt(file, position + 8, MAGIC.length + 2);
                    if (!bundleHeader.subarray(0, MAGIC.length).equals(MAGIC) ||
                        bundleHeader.readUInt16BE(MAGIC.length) !== 1) {
                        identificationError = new Error("provenance のヘッダーまたは版が未対応です。");
                    }
                }
            }
            if (["tEXt", "iTXt", "zTXt"].includes(type)) {
                const prefix = await readAt(file, position + 8, Math.min(length, 80));
                const end = prefix.indexOf(0);
                const keyword = end < 0 ? "" : prefix.toString("latin1", 0, end);
                if (["ComfyProvenanceFormat", "Description"].includes(keyword)) {
                    if (length > MAX_TEXT_BYTES) {
                        throw new Error("表示用メタデータが上限の 4 MiB を超えています。");
                    }
                    const data = await readAt(file, position + 8, length);
                    const storedCrc = await readAt(file, position + 8 + length, 4);
                    if (crc32(Buffer.concat([header.subarray(4), data])) !== storedCrc.readUInt32BE(0)) {
                        throw new Error(`${keyword} の CRC が不正です。`);
                    }
                    if (keyword === "ComfyProvenanceFormat") {
                        if (format !== undefined) throw new Error("形式識別情報が重複しています。");
                        if (type !== "tEXt") throw new Error("形式識別情報は tEXt である必要があります。");
                        format = data.toString("latin1", end + 1);
                    } else {
                        if (description !== undefined) throw new Error("Description が重複しています。");
                        if (type !== "iTXt") {
                            identificationError = new Error("Description は iTXt である必要があります。");
                        } else {
                            description = readDescription(data);
                        }
                    }
                }
            }
            position += length + 12;
            if (type === "IEND") {
                if (length || position !== size) throw new Error("PNG の終端が不正です。");
                ended = true;
                break;
            }
        }
        if (!ended) throw new Error("PNG の IEND がありません。");
        if (!hasBundle && format === undefined) return null;
        if (identificationError) throw identificationError;
        if (!hasBundle || format !== FORMAT) throw new Error("未対応または不完全な provenance 形式です。");
        if (description === undefined || !description.trim()) throw new Error("Description がありません。");
        return { description };
    } finally {
        await file.close();
    }
}

module.exports = { readMetadata, crc32 };
