const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

// restored 的配置入口：仍然直接在这里增加母钱包、修改初始额度。
const RPC_URL = process.env.RPC_URL || "https://surging-chirpy-disallow.ngrok-free.dev";
const CHECK_INTERVAL_MS = 3000;
const HEALTH_PORT = Number(process.env.HEALTH_PORT || 3000);
const FORCE_REFRESH_INITIAL = false; // true 会重置母钱包额度；用完必须改回 false。
const baseAddresses = [
    "0x4d835A51f3F85dfF9D31bd5445C66EfBf0B05DE6",
    "0x97C9496fd2f535D5e5bfC2C3F8c42C34429e0a07",
    "0x14bE06184c1EA8656e7330D1d15890f4a26D5151",
    "0x158A2cB942E78ff3C356545b7Cd1B8Ca3648B537",
    "0x32531bBd0A65421A8CBc91EC4Ed41f309463DF44",
    "0x97C9496fd2f535D5e5bfC2C3F8c42C34429e0a07",
    "0x37876CF918F6B3509a9CE4c0126842c9Da26Df20",
    "0xF5c740937bD502B18DF81460a4015898606a8911",
    "0xBC2998697f3716800C066Ac0FfA0261189cbe69F",
    "0x396371b158b3f84AB7e0F6fbA588B36dD0821036",
    "0x14668710D99104C3b94E5d561143F56C617478d4",
    "0x20D5CC79AAf9d5977a76c658415E819F18f5012E"
];
const TOKENS = {
    usdt: { addr: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, slots: [0, 2] },
    usdc: { addr: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, slots: [0, 9] },
    wbtc: { addr: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", decimals: 8, slots: [0] }
};
function initialBalances() {
    return {
        eth: ethers.parseEther("99999999").toString(),
        usdt: ethers.parseUnits("1000000000", 6).toString(),
        usdc: ethers.parseUnits("6767676767", 6).toString(),
        wbtc: ethers.parseUnits("67", 8).toString()
    };
}

// 短请求上限，整轮不重叠；数据错误绝不转成余额 0。
const request = new ethers.FetchRequest(RPC_URL);
request.timeout = 12000;
const provider = new ethers.JsonRpcProvider(request, new ethers.Network("mainnet", 1), {
    staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1
});
const DATA_DIR = process.env.DATA_DIR || __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });
const CACHE_FILE = path.join(DATA_DIR, "restored-ledger-cache.json");
const NODE_STATUS_FILE = process.env.NODE_STATUS_FILE;
const MAX_BLOCKS_PER_ROUND = 5;
const UPLOAD_INTERVAL_MS = 10000; // 有变化才上传；合并密集变化，最多约 360 次/小时。
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const tokenAddresses = new Set(Object.values(TOKENS).map(t => t.addr.toLowerCase()));
const abi = new ethers.Interface(["function balanceOf(address) view returns (uint256)"]);
const clone = value => JSON.parse(JSON.stringify(value));
let cache, ledgerStore, shuttingDown = false, watchInProgress = false;
let phase = "loading-ledger", lastCompleteAt = 0, localError = "";
let uploadTimer, uploadBusy = false, uploadError = "", conflict = false;
let uploadNotBefore = 0, uploadFailures = 0, lastUploadedAt = null;
let restoreToken = null, restoredWallets = new Set();

function atomicWrite(file, content) {
    const fd = fs.openSync(file + ".tmp", "w", 0o600);
    try { fs.writeFileSync(fd, content, "utf8"); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(file + ".tmp", file);
}
function persist() { atomicWrite(CACHE_FILE, JSON.stringify(cache)); }
function fingerprint(ledger) {
    const entries = Object.keys(ledger.wallets).sort().map(address => [
        address, ...["eth", "usdt", "usdc", "wbtc"].map(s => ledger.wallets[address][s]),
        ledger.nonces[address] ?? null
    ]);
    return crypto.createHash("sha256").update(JSON.stringify([ledger.sessionId, entries])).digest("hex");
}
function parseLedger(raw, id) {
    if (!raw || raw.version !== 2 || !raw.wallets || Array.isArray(raw.wallets) ||
        !Object.keys(raw.wallets).length) throw new Error("账本必须是包含钱包的 version=2 JSON");
    if (raw.ledgerId && raw.ledgerId !== id) throw new Error("账本 ledgerId 与 LEDGER_ID 不一致");
    const wallets = {}, nonces = {};
    for (const [address, values] of Object.entries(raw.wallets)) {
        const a = ethers.getAddress(address);
        if (wallets[a]) throw new Error("账本中存在重复钱包地址");
        wallets[a] = {};
        for (const s of ["eth", "usdt", "usdc", "wbtc"]) {
            const v = values?.[s];
            if (typeof v !== "string" || !/^\d+$/.test(v) || BigInt(v) > ethers.MaxUint256) {
                throw new Error("账本余额无效：" + a + " " + s);
            }
            wallets[a][s] = BigInt(v).toString();
        }
    }
    for (const [address, n] of Object.entries(raw.nonces || {})) {
        if (!Number.isSafeInteger(n) || n < 0) throw new Error("账本 nonce 无效");
        const a = ethers.getAddress(address);
        if (wallets[a]) nonces[a] = n;
    }
    if (!Number.isSafeInteger(raw.revision || 0) || (raw.revision || 0) < 0) throw new Error("账本 revision 无效");
    return {
        version: 2, engine: "restored-independent-v2", ledgerId: id,
        sessionId: String(raw.sessionId || crypto.randomUUID()),
        createdAt: raw.createdAt || new Date().toISOString(), updatedAt: raw.updatedAt,
        revision: raw.revision || 0, wallets, nonces
    };
}
function exportLedger(label) {
    const encoded = Buffer.from(JSON.stringify(cache.ledger)).toString("base64");
    atomicWrite(path.join(DATA_DIR, "session-export.base64.txt"), encoded + "\n");
    // 兼容原 restored 的人工查看文件；恢复的完整依据是 CACHE_FILE 和远程账本。
    atomicWrite(path.join(DATA_DIR, "lastKnownBalances.json"), JSON.stringify(cache.ledger.wallets));
    atomicWrite(path.join(DATA_DIR, "known_wallets.json"), JSON.stringify(Object.keys(cache.ledger.wallets)));
    console.log(`[SessionExport] ${label} revision=${cache.ledger.revision} base64=${encoded}`);
}

// 独立仓库模块：单个上传任务、单个最新快照，没有不断增长的待上传队列。
class GitHubLedger {
    constructor() {
        this.repo = (process.env.LEDGER_GITHUB_REPO || "").trim();
        this.branch = (process.env.LEDGER_GITHUB_BRANCH || "main").trim();
        this.id = (process.env.LEDGER_ID || "").trim();
        this.token = (process.env.LEDGER_GITHUB_TOKEN || "").trim();
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(this.repo) || !this.token ||
            !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(this.id) || !this.branch) {
            throw new Error("请核对 LEDGER_GITHUB_REPO/TOKEN/BRANCH 和 LEDGER_ID");
        }
        // 只接受独立仓库，避免一次上传导致源码服务重新部署。
        const source = (process.env.RENDER_GIT_REPO || "").replace(/\.git$/, "").replace(/\/$/, "");
        if (source && source.toLowerCase() === `https://github.com/${this.repo}`.toLowerCase()) {
            throw new Error("LEDGER_GITHUB_REPO 必须指向独立账本仓库，不能指向 Render 源码仓库");
        }
        this.url = `https://api.github.com/repos/${this.repo}/contents/memory-data/${this.id}.json`;
        this.scope = `${this.repo.toLowerCase()}@${this.branch}/${this.id}`;
    }
    async request(method, body, url = this.url) {
        const response = await fetch(url, {
            method, headers: {
                Accept: "application/vnd.github+json", Authorization: `Bearer ${this.token}`,
                "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json"
            },
            body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(12000)
        });
        if (method === "GET" && response.status === 404) return null;
        if (!response.ok) {
            const error = new Error(`GitHub ${method} HTTP ${response.status}`);
            error.status = response.status;
            const after = Number(response.headers.get("retry-after") || 0) * 1000;
            const reset = response.headers.get("x-ratelimit-remaining") === "0"
                ? Number(response.headers.get("x-ratelimit-reset")) * 1000 - Date.now() : 0;
            error.retryMs = Math.max(60000, after || 0, reset || 0);
            await response.body?.cancel();
            throw error;
        }
        return response.json();
    }
    async read() {
        const data = await this.request("GET", undefined, `${this.url}?ref=${encodeURIComponent(this.branch)}`);
        if (!data) return null;
        if (data.type !== "file" || !data.sha || data.encoding !== "base64" || data.size > 900000) {
            throw new Error("远程账本格式或大小不受支持（上限 900 KB）");
        }
        const json = Buffer.from(data.content.replace(/\s/g, ""), "base64").toString("utf8");
        return { sha: data.sha, json, raw: JSON.parse(json) };
    }
    async write(flight) {
        const data = await this.request("PUT", {
            message: `ledger ${this.id} revision ${flight.revision}`,
            branch: this.branch, content: Buffer.from(flight.json).toString("base64"),
            ...(flight.baseSha ? { sha: flight.baseSha } : {})
        });
        if (!data?.content?.sha) throw new Error("GitHub 未返回文件 SHA，提交是否完成待核对");
        return data.content.sha;
    }
}
function queueUpload(delay = 0) {
    if (shuttingDown || !cache || uploadTimer || uploadBusy || conflict) return;
    if (!cache.flight && fingerprint(cache.ledger) === cache.uploadedFingerprint) return;
    uploadTimer = setTimeout(() => {
        uploadTimer = null;
        void uploadLatest();
    }, Math.max(delay, uploadNotBefore - Date.now(), 0));
}
function acknowledge(sha, flight) {
    cache.baseSha = sha;
    cache.uploadedFingerprint = flight.fingerprint;
    cache.uploadedRevision = flight.revision;
    cache.flight = null;
    uploadFailures = 0;
    uploadError = "";
    lastUploadedAt = new Date().toISOString();
    cache.lastUploadedAt = lastUploadedAt;
    persist();
    console.log(`[Ledger] SAVED id=${ledgerStore.id} revision=${flight.revision}`);
    // 输出已确认上传的快照，不能把上传期间新产生的本地变动冒充为已上传。
    console.log(`[SessionExport] remote=saved revision=${flight.revision} base64=${Buffer.from(flight.json).toString("base64")}`);
}
async function uploadLatest() {
    if (uploadBusy || conflict || !cache) return;
    uploadBusy = true;
    let retryMs = UPLOAD_INTERVAL_MS;
    try {
        // 上次请求可能已提交，但响应丢失；重试前先核对同一份快照。
        if (cache.flight) {
            const actual = await ledgerStore.read();
            if (actual?.json === cache.flight.json) {
                acknowledge(actual.sha, cache.flight);
                return;
            }
            if ((actual?.sha || null) !== cache.flight.baseSha) {
                conflict = true;
                throw new Error("远程账本被其他实例或人工更改；已暂停上传，保留本地记忆。核对后重启读取远程版本");
            }
            // 即使 GET 暂时仍是旧 SHA，先重试同一份请求。
            // 之前超时的 PUT 可能还在服务器上完成；不能丢掉它的确切内容。
        }
        if (!cache.flight) {
            const fp = fingerprint(cache.ledger);
            if (fp === cache.uploadedFingerprint) return;
            const json = JSON.stringify(cache.ledger);
            if (Buffer.byteLength(json) > 900000) throw new Error("账本超过 900 KB，保留本地，无法上传");
            cache.flight = { json, fingerprint: fp, revision: cache.ledger.revision, baseSha: cache.baseSha };
            persist(); // 在发送请求前记下确切内容，JS 单独重启后也能识别丢失响应。
        }
        const flight = cache.flight;
        acknowledge(await ledgerStore.write(flight), flight);
    } catch (e) {
        uploadFailures++;
        retryMs = Math.max(Math.min(300000, 10000 * 2 ** Math.min(uploadFailures, 5)), e.retryMs || 0);
        uploadError = e.message;
        console.error(`[Ledger] ${conflict ? "CONFLICT" : "PENDING"}: ${e.message}; 本地轮询继续`);
    } finally {
        uploadNotBefore = Date.now() + retryMs;
        uploadBusy = false;
        queueUpload(retryMs);
    }
}

async function smartInitialize() {
    const store = new GitHubLedger();
    const remote = await store.read();
    let local;
    if (fs.existsSync(CACHE_FILE)) {
        local = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
        if (local.scope !== store.scope) local = null;
        else local.ledger = parseLedger(local.ledger, store.id);
    }
    let selected;
    if (remote) {
        const parsed = parseLedger(remote.raw, store.id);
        if (local && (local.baseSha === remote.sha || local.flight?.json === remote.json)) {
            selected = local; // JS 单独重启：保留同一容器内尚未上传的更新。
            if (local.flight?.json === remote.json) {
                selected.uploadedFingerprint = local.flight.fingerprint;
                selected.uploadedRevision = local.flight.revision;
                selected.flight = null;
            }
            selected.baseSha = remote.sha;
        } else {
            selected = { ledger: parsed, baseSha: remote.sha, uploadedFingerprint: fingerprint(parsed),
                uploadedRevision: parsed.revision, cursor: null, nodeToken: null, restore: true };
            if (local) console.log("[Ledger] 远程版本已变化，按仓库版本恢复；旧本地副本留在备份文件");
        }
    } else if (local && local.baseSha === null) {
        selected = local;
    } else {
        if (local?.baseSha) throw new Error("已使用过的远程账本现在不可见，拒绝重新初始化");
        // 确認分支可访问；404 不能一律解释为“首次空账本”。
        const branch = await store.request("GET", undefined,
            `https://api.github.com/repos/${store.repo}/branches/${encodeURIComponent(store.branch)}`);
        if (!branch) throw new Error("账本仓库或分支不可访问，请核对地址、权限和 main 分支");
        const imported = (process.env.SESSION_IMPORT_BASE64 || "").trim();
        let raw;
        if (imported) raw = JSON.parse(Buffer.from(imported, "base64").toString("utf8"));
        else if (process.env.LEDGER_CREATE_NEW === store.id) {
            raw = { version: 2, wallets: Object.fromEntries(baseAddresses.map(a => [a, initialBalances()])), nonces: {} };
        } else throw new Error("账本不存在；需 SESSION_IMPORT_BASE64 或明确设置 LEDGER_CREATE_NEW=LEDGER_ID");
        selected = { ledger: parseLedger(raw, store.id), baseSha: null, uploadedFingerprint: null,
            uploadedRevision: null, cursor: null, nodeToken: null, restore: true };
    }
    selected.scope = store.scope;
    selected.flight ||= null;
    selected.pendingWallets ||= [];
    let added = false;
    for (const original of baseAddresses) {
        const address = ethers.getAddress(original);
        if (!selected.ledger.wallets[address] || FORCE_REFRESH_INITIAL) {
            selected.ledger.wallets[address] = initialBalances();
            selected.pendingWallets = [...new Set([...selected.pendingWallets, address])];
            added = true;
        }
    }
    if (added) selected.ledger.revision++;
    if (local) atomicWrite(CACHE_FILE + ".previous", JSON.stringify(local));
    ledgerStore = store;
    cache = selected;
    lastUploadedAt = cache.lastUploadedAt || null;
    persist();
    phase = "waiting-node";
    console.log(`[Ledger] LOADED id=${store.id} wallets=${Object.keys(cache.ledger.wallets).length} source=${remote ? "github" : "explicit-create/import"}`);
    queueUpload();
}

function nodeToken() {
    if (!NODE_STATUS_FILE) return "terminal";
    try {
        const match = /^ready (\S+)$/.exec(fs.readFileSync(NODE_STATUS_FILE, "utf8").trim());
        return match ? match[1] : null;
    } catch (e) { if (e.code === "ENOENT") return null; throw e; }
}
function guard(token) {
    if (shuttingDown || !token || nodeToken() !== token) throw new Error("节点正在恢复，保留记忆等待下轮");
}
async function rpc(token, method, params) {
    guard(token);
    const value = await provider.send(method, params);
    guard(token);
    return value;
}
async function headNumber(token) { return Number(BigInt(await rpc(token, "eth_blockNumber", []))); }
async function blockAt(token, number, full = false) {
    const block = await rpc(token, "eth_getBlockByNumber", [ethers.toQuantity(number), full]);
    if (!block?.hash) throw new Error("区块暂不可读：" + number);
    return block;
}
async function readBalances(token, address, block) {
    const tag = typeof block === "number" ? ethers.toQuantity(block) : block;
    const balances = { eth: BigInt(await rpc(token, "eth_getBalance", [address, tag])).toString() };
    for (const [s, t] of Object.entries(TOKENS)) {
        const result = await rpc(token, "eth_call", [{ to: t.addr, data: abi.encodeFunctionData("balanceOf", [address]) }, tag]);
        balances[s] = abi.decodeFunctionResult("balanceOf", result)[0].toString();
    }
    return balances;
}
async function readNonce(token, address, block = "latest") {
    const n = Number(BigInt(await rpc(token, "eth_getTransactionCount", [address,
        typeof block === "number" ? ethers.toQuantity(block) : block])));
    if (!Number.isSafeInteger(n)) throw new Error("nonce 超出安全整数范围");
    return n;
}
async function setErc20Balance(token, address, config, amount) {
    for (const slotIndex of config.slots) {
        const slot = ethers.keccak256(ethers.concat([
            ethers.zeroPadValue(address, 32), ethers.zeroPadValue(ethers.toBeHex(slotIndex), 32)
        ]));
        await rpc(token, "anvil_setStorageAt", [config.addr, slot,
            ethers.zeroPadValue(ethers.toBeHex(BigInt(amount)), 32)]);
    }
}
async function restoreWallet(token, address) {
    const values = cache.ledger.wallets[address];
    await rpc(token, "anvil_setBalance", [address, ethers.toQuantity(BigInt(values.eth))]);
    for (const [symbol, config] of Object.entries(TOKENS)) await setErc20Balance(token, address, config, values[symbol]);
    if (cache.ledger.nonces[address] !== undefined) {
        await rpc(token, "anvil_setNonce", [address, ethers.toQuantity(cache.ledger.nonces[address])]);
    }
    const seen = await readBalances(token, address, "latest");
    if (JSON.stringify(seen) !== JSON.stringify(values)) throw new Error("恢复核对未通过：" + address);
    const nonce = await readNonce(token, address);
    if (cache.ledger.nonces[address] !== undefined && nonce !== cache.ledger.nonces[address]) {
        throw new Error("恢复 nonce 核对未通过：" + address);
    }
    return nonce;
}
async function restoreMemory(token) {
    phase = "restoring";
    if (restoreToken !== token) { restoredWallets.clear(); restoreToken = token; }
    if (!cache.restore) { cache.restore = true; persist(); }
    // 每步只处理一个钱包，失败只重试该钱包；上传任务与此循环无依赖。
    const address = Object.keys(cache.ledger.wallets).find(a => !restoredWallets.has(a));
    if (address) {
        const nonce = await restoreWallet(token, address);
        if (cache.ledger.nonces[address] !== nonce) {
            cache.ledger.nonces[address] = nonce;
            cache.ledger.revision++;
            cache.ledger.updatedAt = new Date().toISOString();
        }
        restoredWallets.add(address);
        persist();
        console.log(`[Memory] Restored ${restoredWallets.size}/${Object.keys(cache.ledger.wallets).length}`);
        return false;
    }
    // 将开发 RPC 写入落实到一个新区块，避免拿写入前的历史快照再次读取。
    await rpc(token, "evm_mine", []);
    const head = await headNumber(token), block = await blockAt(token, head);
    guard(token);
    cache.nodeToken = token;
    cache.cursor = { number: head, hash: block.hash };
    cache.restore = false;
    cache.pendingWallets = [];
    persist();
    queueUpload();
    restoredWallets.clear();
    phase = "ready";
    lastCompleteAt = Date.now();
    console.log("[Memory] READY：账本余额恢复完成；SAVED 才表示仓库已保存对应版本");
    return true;
}
function addressOrNull(value) {
    if (!value) return null;
    const a = ethers.getAddress(value);
    return a === ethers.ZeroAddress || tokenAddresses.has(a.toLowerCase()) ? null : a;
}

async function watchAndProtect() {
    if (watchInProgress || shuttingDown || !cache) return CHECK_INTERVAL_MS;
    watchInProgress = true;
    try {
        const token = nodeToken();
        if (!token) { phase = "waiting-node"; return CHECK_INTERVAL_MS; }
        const head = await headNumber(token);
        let changedNode = cache.nodeToken !== token || !cache.cursor || head < cache.cursor.number;
        if (!changedNode) changedNode = (await blockAt(token, cache.cursor.number)).hash !== cache.cursor.hash;
        if (changedNode || cache.restore) {
            if (changedNode && !cache.restore) { cache.restore = true; restoredWallets.clear(); }
            return await restoreMemory(token) ? CHECK_INTERVAL_MS : 100;
        }
        if (cache.pendingWallets.length) {
            // 只初始化新加/明确要求重置的母钱包；下一次扫描会读回真实结果。
            await restoreWallet(token, cache.pendingWallets[0]);
            await rpc(token, "evm_mine", []);
            cache.pendingWallets.shift();
            persist();
            return 100;
        }
        // 保留原来的五块规模，但只向前补扫，不重复扫最近五块或跳过积压。
        const end = Math.min(head, cache.cursor.number + MAX_BLOCKS_PER_ROUND);
        const next = clone(cache.ledger), touched = new Set();
        let endHash = cache.cursor.hash;
        const discover = value => {
            const a = addressOrNull(value);
            if (a) {
                touched.add(a);
                if (!next.wallets[a]) next.wallets[a] = { eth: "0", usdt: "0", usdc: "0", wbtc: "0" };
            }
        };
        for (let number = cache.cursor.number + 1; number <= end; number++) {
            const block = await blockAt(token, number, true);
            endHash = block.hash;
            for (const tx of block.transactions) {
                const receipt = await rpc(token, "eth_getTransactionReceipt", [tx.hash]);
                if (!receipt || receipt.blockHash !== block.hash) throw new Error("交易收据未就绪，稍后补扫");
                discover(tx.from); // 失败交易同样会扣燃料、推进 nonce。
                if (BigInt(receipt.status) !== 1n) continue;
                discover(tx.to);
                for (const log of receipt.logs) {
                    if (!tokenAddresses.has(log.address.toLowerCase()) || log.topics[0] !== TRANSFER_TOPIC || log.topics.length !== 3) continue;
                    discover("0x" + log.topics[1].slice(-40));
                    discover("0x" + log.topics[2].slice(-40));
                }
            }
        }
        // 原 restored 的全部钱包检查保留；使用同一个已确认区块获得一致快照。
        // 某钱包读失败则不提交这一批；不会用部分母/子余额覆盖完整账本。
        for (const address of Object.keys(next.wallets)) {
            next.wallets[address] = await readBalances(token, address, end);
            if (touched.has(address) || next.nonces[address] === undefined) next.nonces[address] = await readNonce(token, address, end);
        }
        if ((await blockAt(token, end)).hash !== endHash) throw new Error("读取期间区块变化，保留上一份完整账本");
        guard(token);
        const hasChanges = fingerprint(next) !== fingerprint(cache.ledger);
        if (hasChanges) {
            next.revision++;
            next.updatedAt = new Date().toISOString();
        }
        const previous = cache;
        cache = { ...cache, ledger: next, cursor: { number: end, hash: endHash } };
        try { persist(); } catch (e) { cache = previous; throw e; }
        if (hasChanges) {
            console.log(`[Memory] LOCAL revision=${next.revision} wallets=${Object.keys(next.wallets).length}; 等待仓库 SAVED`);
            try { exportLedger("remote=pending"); } catch (e) { console.error("[Export]", e.message); }
            queueUpload();
        }
        phase = "ready";
        localError = "";
        lastCompleteAt = Date.now();
        return end < head ? 100 : CHECK_INTERVAL_MS;
    } catch (e) {
        localError = e.message;
        phase = "retrying";
        console.error("[Memory] 保留上一份完整记忆，下轮重试:", e.message);
        return CHECK_INTERVAL_MS;
    } finally { watchInProgress = false; }
}

// 从原 JS 健康服务扩展：存活和钱包就绪分开显示，不给交易增加代理层。
function startHealthServer() {
    http.createServer((req, res) => {
        let token;
        try { token = nodeToken(); } catch { token = null; }
        const ready = phase === "ready" && cache?.nodeToken === token &&
            Date.now() - lastCompleteAt < 30000 && !shuttingDown;
        const isReadyPath = req.url?.split("?")[0] === "/ready";
        res.writeHead(shuttingDown || (isReadyPath && !ready) ? 503 : 200, {
            "Content-Type": "application/json", "Cache-Control": "no-store"
        });
        // 不公开钱包地址、余额、令牌或导出账本。
        res.end(JSON.stringify({ alive: !shuttingDown, ready, phase,
            ledger: conflict ? "conflict" : uploadError ? "retrying" :
                cache && fingerprint(cache.ledger) === cache.uploadedFingerprint ? "saved" : "pending",
            localRevision: cache?.ledger.revision ?? null, savedRevision: cache?.uploadedRevision ?? null,
            lastUploadedAt }));
    }).listen(HEALTH_PORT, "0.0.0.0", () => console.log(`[Health] ${HEALTH_PORT} /health=存活 /ready=记忆与节点就绪`));
}
async function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    clearTimeout(uploadTimer);
    console.log(`[Shutdown] ${signal}; 保存本地，尝试完成最后一次仓库上传`);
    const deadline = setTimeout(() => process.exit(0), 12000);
    try {
        if (cache) {
            persist();
            while (uploadBusy) await new Promise(r => setTimeout(r, 100));
            const delay = Math.max(0, uploadNotBefore - Date.now());
            if (delay <= 10000) {
                if (delay) await new Promise(r => setTimeout(r, delay));
                await uploadLatest();
            } else console.log("[Shutdown] 仍处于仓库重试冷却期；本次只保存本地快照");
        }
    } catch (e) { console.error("[Shutdown] 未完成上传:", e.message); }
    clearTimeout(deadline);
    process.exit(0);
}
async function run() {
    startHealthServer();
    const initialize = async () => {
        if (shuttingDown) return;
        try { await smartInitialize(); }
        catch (e) {
            localError = e.message;
            phase = "loading-ledger";
            console.error("[Ledger] 等待账本，节点进程继续运行:", e.message);
            setTimeout(initialize, Math.max(30000, e.retryMs || 0));
            return;
        }
        const loop = async () => {
            const delay = await watchAndProtect();
            if (!shuttingDown) setTimeout(loop, delay);
        };
        void loop();
    };
    await initialize();
}
process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
run().catch(e => { console.error("[Fatal]", e.message); process.exit(1); });

