const zlib = require("zlib");
const { crc32 } = require("..\\js\\png-metadata");

function chunk(type, data = Buffer.alloc(0)) {
    const name = Buffer.from(type, "ascii");
    const header = Buffer.alloc(8);
    header.writeUInt32BE(data.length);
    name.copy(header, 4);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([header, data, crc]);
}

function storedZip(name, data) {
    const filename = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + filename.length, 12);
    end.writeUInt32LE(local.length + filename.length + data.length, 16);
    return Buffer.concat([local, filename, data, central, filename, end]);
}

function provenancePng({ description = "日本語の説明\n<script>alert(1)</script>", format =
    "comfyui-png-provenance/1", bundleVersion = 1, omitDescription = false,
    omitBundle = false, ordinary = false, extraChunks = [] } = {}) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const chunks = [chunk("IHDR", ihdr)];
    if (!ordinary) {
        chunks.push(chunk("tEXt", Buffer.from(`ComfyProvenanceFormat\0${format}`)));
        if (!omitDescription) {
            chunks.push(chunk("iTXt", Buffer.concat([
                Buffer.from("Description\0"), Buffer.alloc(4), Buffer.from(description),
            ])));
        }
    }
    chunks.push(chunk("IDAT", zlib.deflateSync(Buffer.from([0, 0, 0, 0, 255]))));
    if (!ordinary && !omitBundle) {
        const version = Buffer.alloc(2);
        version.writeUInt16BE(bundleVersion);
        const manifest = {
            format: "comfyui-png-provenance", version: 1,
            graph_scope: "connected-upstream-including-lazy-branches",
            graph: { "1": { class_type: "SaveImageWithProvenance", inputs: {} } },
            workflow_scope: "not-provided", workflow: null,
            output: { node_id: "1", runtime_node_id: "1", batch_index: 0, batch_size: 1, width: 1, height: 1 },
            assets: [],
        };
        chunks.push(chunk("cpRV", Buffer.concat([
            Buffer.from("COMFY-PROVENANCE\0"), version,
            storedZip("manifest.json", Buffer.from(JSON.stringify(manifest))),
        ])));
    }
    chunks.push(...extraChunks, chunk("IEND"));
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks]);
}

module.exports = { chunk, provenancePng };
