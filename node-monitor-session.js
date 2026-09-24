const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const http = require("http");
const net = require("net");
const crypto = require("crypto");

// ─── 配置区域：保留原版直接修改钱包与额度的方式 ───
const RPC_URL = process.env.RPC_URL || "https://surging-chirpy-disallow.ngrok-free.dev";
const CHECK_INTERVAL_MS = 3000;
const AUDIT_INTERVAL_MS = 30000;
const HEALTH_PORT = Number(process.env.HEALTH_PORT || 3000);
// Render 使用这个轻量入口：账本恢复期间暂停外部RPC，完成后原样转发。
const PUBLIC_RPC_PORT = Number(process.env.PUBLIC_RPC_PORT || 0);

// true：明确建立全新 Session；正常使用必须保持 false。
const FORCE_NEW_SESSION = false;

// 手动恢复上一套数据时，把日志中的 [SessionExport] base64 内容粘贴到这里。
// 如果不恢复旧数据，保持空字符串。
const MANUAL_SESSION_IMPORT_BASE64 = "";

// 保留原版开关：true 仅重设母钱包额度，保留已有子钱包；用完改回false。
const FORCE_REFRESH_INITIAL = false;

// 每次发生已确认转账后，在 Render 私有日志输出可手动备份的 Session。
const LOG_SESSION_EXPORT_ON_TRANSFER = true;

const networkConfig = new ethers.Network("mainnet", 1);
const provider = new ethers.JsonRpcProvider(RPC_URL, networkConfig, {
    staticNetwork: true,
    batchMaxCount: 1,
    cacheTimeout: -1
});

// 11个母钱包完整保留。新增母钱包仍然直接添加到这里。
const baseAddresses = [
    "0x4d835A51f3F85dfF9D31bd5445C66EfBf0B05DE6",
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
].map((address) => ethers.getAddress(address));

const TOKENS = {
    usdt: {
        addr: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        decimals: 6,
        slots: [0, 2]
    },
    usdc: {
        addr: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        decimals: 6,
        slots: [0, 9]
    },
    wbtc: {
        addr: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
        decimals: 8,
        slots: [0]
    }
};

const INITIAL_BALANCES = {
    eth: ethers.parseEther("99999999"),
    usdt: ethers.parseUnits("1000000000", 6),
    usdc: ethers.parseUnits("6767676767", 6),
    wbtc: ethers.parseUnits("67", 8)
};

const DATA_DIR = process.env.DATA_DIR || __dirname;
const SESSION_FILE = path.join(DATA_DIR, "session-state.json");
const SESSION_EXPORT_FILE = path.join(DATA_DIR, "session-export.base64.txt");
const WALLET_FILE = path.join(DATA_DIR, "known_wallets.json");
const BALANCE_FILE = path.join(DATA_DIR, "lastKnownBalances.json");
const ANVIL_GENERATION_FILE = process.env.ANVIL_GENERATION_FILE
    || path.join(DATA_DIR, "anvil-generation");
const READY_FILE = process.env.SESSION_READY_FILE
    || path.join(DATA_DIR, "session-ready");
fs.mkdirSync(DATA_DIR, { recursive: true });

const SESSION_VERSION = 2;
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const minABI = ["function balanceOf(address) view returns (uint256)"];
const tokenContracts = Object.fromEntries(
    Object.entries(TOKENS).map(([symbol, config]) => [
        symbol,
        new ethers.Contract(config.addr, minABI, provider)
    ])
);
const tokenAddresses = new Set(
    Object.values(TOKENS).map((token) => token.addr.toLowerCase())
);

let session = null;
let sessionSource = "new";
let watchInProgress = false;
let shuttingDown = false;
let lastAuditAt = 0;
let lastCheckpointSaveAt = 0;
const mismatchTracker = new Map();
const publicSockets = new Set();
let rpcReady = false;

function normalizeAddress(address) {
    return ethers.getAddress(address);
}

function emptyBalances() {
    return { eth: 0n, usdt: 0n, usdc: 0n, wbtc: 0n };
}

function initialBalances() {
    return {
        eth: INITIAL_BALANCES.eth,
        usdt: INITIAL_BALANCES.usdt,
        usdc: INITIAL_BALANCES.usdc,
        wbtc: INITIAL_BALANCES.wbtc
    };
}

function serializeBalances(balance) {
    return {
        eth: BigInt(balance.eth || 0n).toString(),
        usdt: BigInt(balance.usdt || 0n).toString(),
        usdc: BigInt(balance.usdc || 0n).toString(),
        wbtc: BigInt(balance.wbtc || 0n).toString()
    };
}

function parseBalances(balance) {
    return {
        eth: BigInt(balance?.eth || "0"),
        usdt: BigInt(balance?.usdt || "0"),
        usdc: BigInt(balance?.usdc || "0"),
        wbtc: BigInt(balance?.wbtc || "0")
    };
}

function balancesEqual(left, right) {
    return left.eth === right.eth
        && left.usdt === right.usdt
        && left.usdc === right.usdc
        && left.wbtc === right.wbtc;
}

function balanceFingerprint(balance) {
    return `${balance.eth}:${balance.usdt}:${balance.usdc}:${balance.wbtc}`;
}

function sessionForDisk() {
    const wallets = {};
    for (const [address, balance] of Object.entries(session.wallets)) {
        wallets[address] = serializeBalances(balance);
    }
    return {
        version: SESSION_VERSION,
        sessionId: session.sessionId,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        revision: session.revision,
        lastProcessedBlock: session.lastProcessedBlock,
        lastProcessedBlockHash: session.lastProcessedBlockHash,
        anvilGeneration: session.anvilGeneration,
        restoreRequired: !!session.restoreRequired,
        pendingBaseAddresses: session.pendingBaseAddresses || [],
        nonces: session.nonces || {},
        wallets
    };
}

function atomicWrite(filePath, contents) {
    const tempPath = `${filePath}.tmp`;
    const fd = fs.openSync(tempPath, "w");
    try {
        fs.writeFileSync(fd, contents, "utf8");
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    if (fs.existsSync(filePath)) fs.copyFileSync(filePath, `${filePath}.bak`);
    fs.renameSync(tempPath, filePath);
}

function writeCompatibilityFiles() {
    const baseSet = new Set(baseAddresses.map((address) => address.toLowerCase()));
    const childWallets = Object.keys(session.wallets).filter(
        (address) => !baseSet.has(address.toLowerCase())
    );
    atomicWrite(WALLET_FILE, JSON.stringify(childWallets, null, 2));

    const balances = {};
    for (const [address, balance] of Object.entries(session.wallets)) {
        balances[address] = serializeBalances(balance);
    }
    atomicWrite(BALANCE_FILE, JSON.stringify(balances, null, 2));
}

function saveSession({ exportToLog = false, reason = "state" } = {}) {
    session.updatedAt = new Date().toISOString();
    session.revision += 1;
    const diskState = sessionForDisk();
    const json = JSON.stringify(diskState, null, 2);
    atomicWrite(SESSION_FILE, json);
    lastCheckpointSaveAt = Date.now();

    const encoded = Buffer.from(JSON.stringify(diskState), "utf8").toString("base64");
    // 唯一权威文件先落盘，兼容文件或备份导出失败不能改变账本。
    try {
        writeCompatibilityFiles();
        atomicWrite(SESSION_EXPORT_FILE, `${encoded}\n`);
    } catch (error) {
        console.error("[Export] 账本已保存，辅助导出失败:", error.message || error);
    }
    if (exportToLog && LOG_SESSION_EXPORT_ON_TRANSFER) {
        console.log(`[SessionExport] reason=${reason} revision=${session.revision} base64=${encoded}`);
    }
}

function validateAndParseSession(raw) {
    if (!raw || typeof raw !== "object" || !raw.wallets || typeof raw.wallets !== "object"
        || Array.isArray(raw.wallets) || Object.keys(raw.wallets).length === 0) {
        throw new Error("Session 格式无效：缺少 wallets");
    }
    if (raw.version !== undefined && Number(raw.version) !== SESSION_VERSION) {
        throw new Error(`Session版本不兼容：需要${SESSION_VERSION}，实际${raw.version}`);
    }

    const wallets = {};
    for (const [rawAddress, rawBalance] of Object.entries(raw.wallets)) {
        const address = normalizeAddress(rawAddress);
        for (const symbol of ["eth", "usdt", "usdc", "wbtc"]) {
            if (!rawBalance || typeof rawBalance[symbol] !== "string"
                || !/^\d+$/.test(rawBalance[symbol])
                || BigInt(rawBalance[symbol]) > ethers.MaxUint256) {
                throw new Error(`Session余额字段无效: ${address}/${symbol}`);
            }
        }
        wallets[address] = parseBalances(rawBalance);
    }

    const nonces = {};
    for (const [address, nonce] of Object.entries(raw.nonces || {})) {
        if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error("Session nonce无效");
        nonces[normalizeAddress(address)] = nonce;
    }
    return {
        version: SESSION_VERSION,
        sessionId: String(raw.sessionId || crypto.randomUUID()),
        createdAt: String(raw.createdAt || new Date().toISOString()),
        updatedAt: String(raw.updatedAt || new Date().toISOString()),
        revision: Number(raw.revision || 0),
        lastProcessedBlock: Number.isInteger(raw.lastProcessedBlock)
            ? raw.lastProcessedBlock
            : null,
        lastProcessedBlockHash: raw.lastProcessedBlockHash || null,
        anvilGeneration: raw.anvilGeneration || null,
        restoreRequired: !!raw.restoreRequired,
        pendingBaseAddresses: (raw.pendingBaseAddresses || []).map(normalizeAddress),
        nonces,
        wallets
    };
}

function createNewSession() {
    const wallets = {};
    for (const address of baseAddresses) wallets[address] = initialBalances();
    const now = new Date().toISOString();
    return {
        version: SESSION_VERSION,
        sessionId: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
        revision: 0,
        lastProcessedBlock: null,
        lastProcessedBlockHash: null,
        anvilGeneration: null,
        nonces: {},
        wallets
    };
}

function getManualImportBase64() {
    return process.env.SESSION_IMPORT_BASE64 || MANUAL_SESSION_IMPORT_BASE64;
}

function loadSession() {
    if (!FORCE_NEW_SESSION && fs.existsSync(SESSION_FILE)) {
        try {
            sessionSource = "local";
            return validateAndParseSession(JSON.parse(fs.readFileSync(SESSION_FILE, "utf8")));
        } catch (error) {
            const backupFile = `${SESSION_FILE}.bak`;
            if (fs.existsSync(backupFile)) {
                try {
                    console.error("[Session] 主文件损坏，正在读取上一份原子备份");
                    sessionSource = "local-backup";
                    return validateAndParseSession(JSON.parse(fs.readFileSync(backupFile, "utf8")));
                } catch (backupError) {
                    throw new Error(`Session主文件与备份均损坏，拒绝自动新建: ${backupError.message || backupError}`);
                }
            }
            // 已存在的Session损坏时必须停止，绝不能静默回到初始余额。
            throw new Error(`本地Session读取失败，拒绝自动新建: ${error.message || error}`);
        }
    }

    const importBase64 = getManualImportBase64().trim();
    if (!FORCE_NEW_SESSION && importBase64) {
        try {
            const decoded = Buffer.from(importBase64, "base64").toString("utf8");
            sessionSource = "manual-import";
            return validateAndParseSession(JSON.parse(decoded));
        } catch (error) {
            throw new Error(`手动Session导入失败: ${error.message || error}`);
        }
    }

    sessionSource = "new";
    return createNewSession();
}

function readAnvilGeneration() {
    try {
        return fs.readFileSync(ANVIL_GENERATION_FILE, "utf8").trim() || null;
    } catch (error) {
        return null;
    }
}

function setReady(ready) {
    rpcReady = false;
    if (!ready) {
        for (const socket of publicSockets) socket.destroy();
        publicSockets.clear();
    }
    try {
        if (ready) {
            atomicWrite(READY_FILE, `${session?.sessionId || "unknown"}\n`);
        } else if (fs.existsSync(READY_FILE)) {
            fs.unlinkSync(READY_FILE);
        }
        rpcReady = ready;
    } catch (error) {
        console.error("[Ready] 就绪标记更新失败:", error.message || error);
        throw error;
    }
}

async function waitForRpc() {
    let waitMs = 1000;
    while (!shuttingDown) {
        try {
            await provider.getBlockNumber();
            return;
        } catch (error) {
            console.error(`[RPC] Anvil尚未就绪，${waitMs}ms后重试:`, error.message || error);
            await new Promise((resolve) => setTimeout(resolve, waitMs));
            waitMs = Math.min(waitMs * 2, 10000);
        }
    }
}

async function setErc20Balance(tokenAddress, userAddress, amount, slots) {
    const paddedUser = ethers.zeroPadValue(userAddress, 32);
    const amountHex = ethers.zeroPadValue(ethers.toBeHex(amount), 32);
    for (const slotIndex of slots) {
        const balanceSlot = ethers.zeroPadValue(ethers.toBeHex(slotIndex), 32);
        const slot = ethers.keccak256(ethers.concat([paddedUser, balanceSlot]));
        await provider.send("anvil_setStorageAt", [tokenAddress, slot, amountHex]);
    }
}

async function applyWalletToNode(address, balance) {
    await provider.send("anvil_setBalance", [address, ethers.toQuantity(balance.eth)]);
    for (const [symbol, config] of Object.entries(TOKENS)) {
        await setErc20Balance(config.addr, address, balance[symbol], config.slots);
    }
}

async function restoreSessionToNode(reason) {
    console.log(`[Session] ${reason}：本次账本优先，正在恢复 ${Object.keys(session.wallets).length} 个钱包...`);
    for (const [address, balance] of Object.entries(session.wallets)) {
        // 任一钱包恢复失败，整套账本保持未就绪，稍后重试。
        await applyWalletToNode(address, balance);
        session.nonces ||= {};
        if (session.nonces[address] !== undefined) {
            await provider.send("anvil_setNonce", [address, ethers.toQuantity(session.nonces[address])]);
        }
        const nonce = await provider.getTransactionCount(address);
        if (session.nonces[address] !== undefined && nonce !== session.nonces[address]) {
            throw new Error(`钱包 ${address} nonce恢复校验不一致`);
        }
        session.nonces[address] = nonce;
        if (!balancesEqual(balance, await getWalletBalances(address))) {
            throw new Error(`钱包 ${address} 恢复校验不一致`);
        }
    }
    mismatchTracker.clear();
}

async function getWalletBalances(address, blockTag = "latest") {
    const [eth, usdt, usdc, wbtc] = await Promise.all([
        provider.getBalance(address, blockTag),
        tokenContracts.usdt.balanceOf.staticCall(address, { blockTag }),
        tokenContracts.usdc.balanceOf.staticCall(address, { blockTag }),
        tokenContracts.wbtc.balanceOf.staticCall(address, { blockTag })
    ]);
    return { eth, usdt, usdc, wbtc };
}

async function getBlockHash(blockNumber) {
    const block = await provider.getBlock(blockNumber, false);
    return block?.hash || null;
}

async function setCheckpoint(blockNumber) {
    const hash = await getBlockHash(blockNumber);
    if (!hash) throw new Error(`无法确认区块 ${blockNumber}`);
    session.lastProcessedBlock = blockNumber;
    session.lastProcessedBlockHash = hash;
}

async function resetNodeGeneration(reason, generation = readAnvilGeneration()) {
    setReady(false);
    session.restoreRequired = true;
    saveSession();
    await restoreSessionToNode(reason);
    const latestBlock = await provider.getBlockNumber();
    await setCheckpoint(latestBlock);
    const currentGeneration = readAnvilGeneration();
    if (generation && currentGeneration && generation !== currentGeneration) {
        throw new Error("恢复期间Anvil再次换代，保持未就绪并重试");
    }
    session.anvilGeneration = currentGeneration || generation;
    session.restoreRequired = false;
    session.pendingBaseAddresses = [];
    saveSession({ exportToLog: true, reason: "node-reset-recovery" });
    setReady(true);
}

async function verifyNodeContinuity(latestBlock) {
    const generation = readAnvilGeneration();
    if (session.restoreRequired) {
        await resetNodeGeneration("继续尚未完成的Session恢复", generation);
        return false;
    }
    if (session.anvilGeneration && generation && generation !== session.anvilGeneration) {
        await resetNodeGeneration("检测到Anvil重新启动", generation);
        return false;
    }

    if (session.lastProcessedBlock === null) return true;
    if (latestBlock < session.lastProcessedBlock) {
        await resetNodeGeneration("检测到区块高度回退", generation);
        return false;
    }

    if (session.lastProcessedBlockHash) {
        const currentHash = await getBlockHash(session.lastProcessedBlock);
        if (!currentHash || currentHash !== session.lastProcessedBlockHash) {
            await resetNodeGeneration("检测到区块链快照变化", generation);
            return false;
        }
    }
    return true;
}

function transactionList(block) {
    if (Array.isArray(block?.prefetchedTransactions)) return block.prefetchedTransactions;
    return [];
}

function addAffected(affected, known, address, reason, allowNew) {
    if (!address || address.toLowerCase() === ethers.ZeroAddress.toLowerCase()) return null;
    let normalized;
    try {
        normalized = normalizeAddress(address);
    } catch (error) {
        console.error(`[Ledger] 跳过无效地址 ${address}:`, error.message || error);
        return null;
    }
    if (!known.has(normalized.toLowerCase()) && !allowNew) return null;
    known.add(normalized.toLowerCase());
    if (!affected.has(normalized)) affected.set(normalized, new Set());
    affected.get(normalized).add(reason);
    return normalized;
}

async function collectTransfers(fromBlock, toBlock, affected, known) {
    // 先取得日志，但按区块/交易的真实顺序与ETH一起处理。
    // 这样母钱包转代币给A、A立即转ETH给B也不会漏掉B。
    const logsByTransaction = new Map();
    for (const [symbol, config] of Object.entries(TOKENS)) {
        const logs = await provider.getLogs({
            address: config.addr, topics: [TRANSFER_TOPIC], fromBlock, toBlock
        });
        for (const log of logs) {
            if (log.removed) throw new Error("遇到已移除的交易日志，下轮重试");
            const list = logsByTransaction.get(log.transactionHash) || [];
            list.push({ symbol, log });
            logsByTransaction.set(log.transactionHash, list);
        }
    }

    for (let blockNumber = fromBlock; blockNumber <= toBlock; blockNumber++) {
        const block = await provider.getBlock(blockNumber, true);
        if (!block) throw new Error(`无法读取区块 ${blockNumber}`);

        let transactions = transactionList(block);
        if (transactions.length === 0 && Array.isArray(block.transactions) && block.transactions.length > 0) {
            transactions = await Promise.all(
                block.transactions.map((hash) => provider.getTransaction(hash))
            );
            if (transactions.some((tx) => !tx)) throw new Error(`区块 ${blockNumber} 的交易数据不完整`);
        }

        for (const tx of transactions) {
            const value = BigInt(tx.value || 0n);
            const fromKnown = tx.from && known.has(tx.from.toLowerCase());
            const toKnown = tx.to && known.has(tx.to.toLowerCase());
            const tokenLogs = logsByTransaction.get(tx.hash) || [];
            if (!fromKnown && !toKnown && tokenLogs.length === 0) continue;

            const receipt = await provider.getTransactionReceipt(tx.hash);
            if (!receipt) throw new Error(`交易回执尚不可用: ${tx.hash}`);
            if (receipt.blockHash !== block.hash) throw new Error("交易回执与区块不一致，下轮重试");
            const successful = Number(receipt.status) === 1;

            // 只有成功且有原生ETH价值的交易，才允许扩展新的子钱包。
            if (successful && value > 0n && (fromKnown || toKnown)) {
                if (tx.from) addAffected(affected, known, tx.from, "eth-sender", true);
                if (tx.to && !tokenAddresses.has(tx.to.toLowerCase())) {
                    addAffected(affected, known, tx.to, "eth-recipient", true);
                }
            }

            if (successful) {
                tokenLogs.sort((a, b) => a.log.index - b.log.index);
                for (const { symbol, log } of tokenLogs) {
                    if (log.blockHash !== block.hash) throw new Error("代币日志与区块不一致，下轮重试");
                    if (!log.topics || log.topics.length !== 3) continue;
                    if (BigInt(log.data || "0x0") === 0n) continue;
                    const from = `0x${log.topics[1].slice(-40)}`;
                    const to = `0x${log.topics[2].slice(-40)}`;
                    if (!known.has(from.toLowerCase()) && !known.has(to.toLowerCase())) continue;
                    addAffected(affected, known, from, `${symbol}-sender`, true);
                    addAffected(affected, known, to, `${symbol}-recipient`, true);
                }
            }

            // 即使交易失败，已知发送者仍需记录实际Gas支出。
            if (tx.from && known.has(tx.from.toLowerCase())) {
                addAffected(affected, known, tx.from, "eth-sender-gas", false);
            }
        }
    }
}

async function processNewBlocks(latestBlock) {
    if (session.lastProcessedBlock === null) {
        await setCheckpoint(latestBlock);
        saveSession();
        return { affected: new Set(), changed: false };
    }

    const fromBlock = session.lastProcessedBlock + 1;
    if (fromBlock > latestBlock) return { affected: new Set(), changed: false };

    const startGeneration = readAnvilGeneration();
    const expectedHash = await getBlockHash(latestBlock);
    if (!expectedHash) throw new Error(`无法确认区块 ${latestBlock}`);
    const affected = new Map();
    const known = new Set(Object.keys(session.wallets).map((address) => address.toLowerCase()));
    const CHUNK_SIZE = 100;
    for (let chunkStart = fromBlock; chunkStart <= latestBlock; chunkStart += CHUNK_SIZE) {
        const chunkEnd = Math.min(latestBlock, chunkStart + CHUNK_SIZE - 1);
        await collectTransfers(chunkStart, chunkEnd, affected, known);
    }

    // 整批成功后才提交，任何RPC失败都不会推进游标或保存半套账本。
    const draftWallets = Object.fromEntries(
        Object.entries(session.wallets).map(([address, balance]) => [address, { ...balance }])
    );
    const draftNonces = { ...session.nonces };
    let changed = false;
    for (const [address, reasons] of affected.entries()) {
        const nodeBalance = await getWalletBalances(address, latestBlock);
        draftNonces[address] = await provider.getTransactionCount(address, latestBlock);
        const previous = draftWallets[address];
        if (!previous || !balancesEqual(previous, nodeBalance)) {
            draftWallets[address] = nodeBalance;
            changed = true;
            console.log(`[Ledger] 已确认 ${address} 的新余额（${Array.from(reasons).join(",")}，允许为0）`);
        }
    }

    const checkpointHash = await getBlockHash(latestBlock);
    if (checkpointHash !== expectedHash || readAnvilGeneration() !== startGeneration) {
        throw new Error("扫描期间节点发生变化，丢弃本轮未提交数据");
    }
    const previousState = { ...session };
    session.wallets = draftWallets;
    session.nonces = draftNonces;
    session.lastProcessedBlock = latestBlock;
    session.lastProcessedBlockHash = checkpointHash;
    for (const address of affected.keys()) mismatchTracker.delete(address);

    try {
        if (affected.size > 0 || Date.now() - lastCheckpointSaveAt >= 30000) {
            saveSession({ exportToLog: affected.size > 0, reason: "confirmed-transfer" });
        }
    } catch (error) {
        session = previousState;
        throw error;
    }
    return { affected: new Set(affected.keys()), changed };
}

async function auditAndProtect(affectedThisCycle) {
    if (Date.now() - lastAuditAt < AUDIT_INTERVAL_MS) return;
    lastAuditAt = Date.now();

    const snapshotBlock = session.lastProcessedBlock;
    if (snapshotBlock === null) return;

    for (const [address, remembered] of Object.entries(session.wallets)) {
        if (affectedThisCycle.has(address)) {
            mismatchTracker.delete(address);
            continue;
        }

        try {
            const nodeBalance = await getWalletBalances(address, snapshotBlock);
            if (balancesEqual(remembered, nodeBalance)) {
                mismatchTracker.delete(address);
                continue;
            }

            const fingerprint = balanceFingerprint(nodeBalance);
            const previousMismatch = mismatchTracker.get(address);
            const count = previousMismatch?.fingerprint === fingerprint
                ? previousMismatch.count + 1
                : 1;
            mismatchTracker.set(address, { fingerprint, count });

            if (count < 2) {
                console.log(`[Protect] ${address} 与Session不一致，等待下一轮交易扫描确认`);
                continue;
            }

            // 连续两次不一致且没有确认转账，Session记忆优先。
            setReady(false);
            const pending = await provider.getBlock("pending", false);
            if (!pending || pending.transactions.length > 0
                || await provider.getBlockNumber() !== snapshotBlock
                || await getBlockHash(snapshotBlock) !== session.lastProcessedBlockHash
                || readAnvilGeneration() !== session.anvilGeneration) {
                // 审计期间有新块/待处理转账，先让下轮补扫，不能拿旧余额覆盖它。
                return;
            }
            try {
                await applyWalletToNode(address, remembered);
                if (!balancesEqual(remembered, await getWalletBalances(address))) {
                    throw new Error("回灌后校验不一致");
                }
            } catch (error) {
                session.restoreRequired = true;
                saveSession();
                throw error;
            }
            mismatchTracker.delete(address);
            console.log(`[Protect] ${address} 无确认转账，已恢复本次Session余额`);
        } catch (error) {
            if (session.restoreRequired) throw error;
            // 读取失败绝不当作0，也绝不覆盖Session。
            console.error(`[Protect] ${address} 审计失败，本次不修改任何余额:`, error.message || error);
        }
    }
}

async function initializeSession() {
    console.log("🔄 [Session] 正在建立本次运行权威账本...");
    setReady(false);
    session = loadSession();
    const pendingBase = new Set(session.pendingBaseAddresses || []);
    for (const address of baseAddresses) {
        if (!session.wallets[address] || FORCE_REFRESH_INITIAL) {
            session.wallets[address] = initialBalances();
            pendingBase.add(address);
        }
    }
    session.pendingBaseAddresses = Array.from(pendingBase);
    await waitForRpc();

    const generation = readAnvilGeneration();
    const latestBlock = await provider.getBlockNumber();
    let canContinueLocalNode = sessionSource.startsWith("local")
        && !session.restoreRequired
        && session.anvilGeneration
        && generation
        && session.anvilGeneration === generation
        && session.lastProcessedBlock !== null
        && latestBlock >= session.lastProcessedBlock;

    if (canContinueLocalNode && session.lastProcessedBlockHash) {
        const currentHash = await getBlockHash(session.lastProcessedBlock);
        canContinueLocalNode = currentHash === session.lastProcessedBlockHash;
    }

    // 新Session、手动导入或Anvil已经换代：先把账本写回节点，绝不学习旧快照。
    if (!canContinueLocalNode) {
        const reason = sessionSource === "new"
            ? "全新Session初始化"
            : sessionSource === "manual-import"
                ? "手动导入旧Session"
                : "JS恢复时检测到Anvil已换代";
        await resetNodeGeneration(reason, generation);
    } else {
        // JS重启前后发生的交易先补扫，避免恢复旧游标时覆盖已发生的转账。
        await processNewBlocks(latestBlock);
        saveSession();
        for (const address of session.pendingBaseAddresses) {
            if (FORCE_REFRESH_INITIAL && baseAddresses.includes(address)) {
                session.wallets[address] = initialBalances();
            }
            await applyWalletToNode(address, session.wallets[address]);
            session.nonces[address] = await provider.getTransactionCount(address);
            if (!balancesEqual(session.wallets[address], await getWalletBalances(address))) {
                throw new Error(`新增母钱包 ${address} 初始化校验失败`);
            }
        }
        session.pendingBaseAddresses = [];
    }

    session.anvilGeneration = readAnvilGeneration() || generation;
    saveSession({
        exportToLog: !sessionSource.startsWith("local"),
        reason: sessionSource === "new" ? "new-session" : "session-resume"
    });
    console.log(`[Session] ID=${session.sessionId} 来源=${sessionSource} 钱包=${Object.keys(session.wallets).length}`);
    console.log("🟢 [Session] 本次账本已锁定；节点切换或旧快照不能覆盖它。");
    setReady(true);
}

async function watchAndProtect() {
    if (watchInProgress || shuttingDown) return;
    watchInProgress = true;
    try {
        const latestBlock = await provider.getBlockNumber();
        const continuous = await verifyNodeContinuity(latestBlock);
        if (!continuous) return;

        const result = await processNewBlocks(latestBlock);
        await auditAndProtect(result.affected);
        if (!rpcReady && !shuttingDown) setReady(true);
    } catch (error) {
        setReady(false);
        console.error("[Loop] 本轮失败；Session保持不变:", error.message || error);
    } finally {
        watchInProgress = false;
    }
}

function startHealthServer() {
    const server = http.createServer((req, res) => {
        if (req.url === "/session-info") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                sessionId: session?.sessionId || null,
                revision: session?.revision || 0,
                wallets: session ? Object.keys(session.wallets).length : 0,
                lastProcessedBlock: session?.lastProcessedBlock ?? null
            }));
            return;
        }
        const ready = publicRpcReady();
        res.writeHead(ready ? 200 : 503, { "Content-Type": "text/plain" });
        res.end(ready ? "OK" : "RECOVERING");
    });
    server.listen(HEALTH_PORT, "0.0.0.0", () => {
        console.log(`[Health] Session保护器端口 ${HEALTH_PORT} 已启动`);
    });
    return server;
}

function publicRpcReady() {
    return rpcReady && !shuttingDown && !session?.restoreRequired
        && fs.existsSync(READY_FILE)
        && (!session?.anvilGeneration || readAnvilGeneration() === session.anvilGeneration);
}

function startPublicRpcServer() {
    if (!PUBLIC_RPC_PORT) return;
    const upstream = new URL(RPC_URL);
    if (upstream.protocol !== "http:") throw new Error("公共RPC转发入口仅连接容器内部HTTP节点");
    const refuse = (res) => {
        res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "3" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null,
            error: { code: -32000, message: "Session recovering; retry shortly" } }));
    };
    const server = http.createServer((req, res) => {
        if (!publicRpcReady()) return refuse(res);
        const forwarded = http.request({
            hostname: upstream.hostname, port: upstream.port || 80,
            method: req.method, path: req.url,
            headers: { ...req.headers, host: upstream.host }
        }, (reply) => {
            res.writeHead(reply.statusCode, reply.headers);
            reply.pipe(res);
        });
        forwarded.on("error", () => {
            if (!res.headersSent) res.writeHead(502);
            res.end("Anvil temporarily unavailable");
        });
        req.on("aborted", () => forwarded.destroy());
        res.on("close", () => forwarded.destroy());
        req.pipe(forwarded);
    });
    // 保留原来的WebSocket RPC能力；恢复期间会关闭旧连接，供钱包重连。
    server.on("upgrade", (req, socket, head) => {
        if (!publicRpcReady()) {
            socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
            return;
        }
        const upstreamSocket = net.connect(Number(upstream.port || 80), upstream.hostname, () => {
            const headers = [];
            for (let i = 0; i < req.rawHeaders.length; i += 2) {
                headers.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
            }
            upstreamSocket.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers.join("\r\n")}\r\n\r\n`);
            if (head.length) upstreamSocket.write(head);
            socket.pipe(upstreamSocket).pipe(socket);
        });
        upstreamSocket.on("error", () => socket.destroy());
        upstreamSocket.on("close", () => socket.destroy());
        socket.on("error", () => upstreamSocket.destroy());
        socket.on("close", () => upstreamSocket.destroy());
    });
    server.on("connection", (socket) => {
        publicSockets.add(socket);
        socket.on("close", () => publicSockets.delete(socket));
    });
    server.listen(PUBLIC_RPC_PORT, "0.0.0.0", () => {
        console.log(`[RPC] 钱包入口 ${PUBLIC_RPC_PORT}：Session就绪后转发至Anvil`);
    });
}

async function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    setReady(false);
    console.log(`[Shutdown] 收到 ${signal}，正在保存Session...`);
    try {
        // 等待已经在处理的批次提交；不在保存过程中并发改写账本。
        const deadline = Date.now() + 10000;
        while (watchInProgress && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (session) saveSession({ exportToLog: true, reason: "shutdown" });
        // --state负责Anvil退出快照；不再生成并丢弃一整份dumpState，避免内存峰值。
    } catch (error) {
        console.error("[Shutdown] 保存失败:", error.message || error);
    }
    process.exit(0);
}

async function run() {
    setReady(false);
    startHealthServer();
    startPublicRpcServer();
    await initializeSession();
    console.log(`[${new Date().toLocaleTimeString()}] 🚀 小貓Session账本版已启动，守護中...`);

    const loop = async () => {
        await watchAndProtect();
        if (!shuttingDown) setTimeout(loop, CHECK_INTERVAL_MS);
    };
    loop();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

run().catch((error) => {
    console.error("[Fatal] Session保护器启动失败:", error);
    process.exit(1);
});
