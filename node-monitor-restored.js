const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const http = require("http");

// ─── 🔑 配置區域（保留原版直接修改方式） ───
// 本地 Terminal 未设置 RPC_URL 时，继续使用原来的 ngrok 地址；
// Render 容器会自动设置为 http://127.0.0.1:8545。
const RPC_URL = process.env.RPC_URL || "https://surging-chirpy-disallow.ngrok-free.dev";
const CHECK_INTERVAL_MS = 3000;
const HEALTH_PORT = Number(process.env.HEALTH_PORT || 3000);

// 如果修改了下方初始额度，请改为 true 运行一次，刷新后再改回 false。
const FORCE_REFRESH_INITIAL = false;

// 保留原版静态 Ethereum Mainnet 配置和禁止 RPC 批处理。
const networkConfig = new ethers.Network("mainnet", 1);
const provider = new ethers.JsonRpcProvider(RPC_URL, networkConfig, {
    staticNetwork: true,
    batchMaxCount: 1
});

// 保留原版钱包添加方法：需要新增钱包时，继续直接添加到这里。
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
];


// 完整保留原版代币、精度与 Storage Slot。
const TOKENS = {
    usdt: { addr: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, slots: [0, 2] },
    usdc: { addr: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, slots: [0, 9] },
    wbtc: { addr: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", decimals: 8, slots: [0] }
};

const minABI = ["function balanceOf(address) view returns (uint256)"];

// ─── 仅新增记忆层：保留 restored 的单轮循环与直连结构 ───
const crypto = require("crypto");
const DATA_DIR = process.env.DATA_DIR || __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });
const MEMORY_FILE = path.join(DATA_DIR, "session-state.json");
const GENERATION_FILE = path.join(DATA_DIR, "anvil-generation");
const FORCE_NEW_SESSION = false;
const MANUAL_SESSION_IMPORT_BASE64 = ""; // 也可使用 Render 的 SESSION_IMPORT_BASE64
const MAX_BLOCKS_PER_ROUND = 20; // 只补扫未记账区块；积压时分轮处理
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const ZERO = ethers.ZeroAddress;
const tokenByAddress = new Map(Object.entries(TOKENS).map(([s,t]) => [t.addr.toLowerCase(),s]));
const contracts = Object.fromEntries(Object.entries(TOKENS).map(([s,t]) =>
    [s, new ethers.Contract(t.addr, minABI, provider)]));
let memory, watchInProgress = false, shuttingDown = false;
let restoreGeneration, restoredWallets = new Set();

function initialBalances() {
    return {
        eth: ethers.parseEther("99999999").toString(),
        usdt: ethers.parseUnits("1000000000", 6).toString(),
        usdc: ethers.parseUnits("6767676767", 6).toString(),
        wbtc: ethers.parseUnits("67", 8).toString()
    };
}
function generation() {
    try { return fs.readFileSync(GENERATION_FILE,"utf8").trim(); }
    catch (e) { if (e.code === "ENOENT") return null; throw e; }
}
function sameGeneration(expected) {
    if (shuttingDown || generation() !== expected) throw new Error("节点换代，保留记忆并等待下一轮");
}
const headNumber = async () => Number(BigInt(await provider.send("eth_blockNumber", [])));
const clone = value => JSON.parse(JSON.stringify(value));
const sameBalances = (a,b) => ["eth","usdt","usdc","wbtc"].every(s => a[s] === b[s]);

function parseMemory(raw) {
    if (!raw || Number(raw.version) !== 2 || !raw.wallets ||
        Array.isArray(raw.wallets) || !Object.keys(raw.wallets).length) throw new Error("记忆格式不正确，拒绝清空重建");
    const wallets = {}, nonces = {};
    for (const [address,values] of Object.entries(raw.wallets)) {
        const addr = ethers.getAddress(address);
        wallets[addr] = {};
        for (const s of ["eth","usdt","usdc","wbtc"]) {
            if (typeof values?.[s] !== "string" || !/^\d+$/.test(values[s])) throw new Error("记忆余额字段缺失或无效");
            wallets[addr][s] = BigInt(values[s]).toString();
        }
    }
    for (const [addr,n] of Object.entries(raw.nonces || {})) {
        if (!Number.isSafeInteger(n) || n < 0) throw new Error("记忆交易序号无效");
        nonces[ethers.getAddress(addr)] = n;
    }
    const cursor = raw.lastProcessedBlock;
    if (cursor != null && (!Number.isSafeInteger(cursor) || cursor < 0)) throw new Error("记忆扫描位置无效");
    return { version:2, sessionId:String(raw.sessionId || crypto.randomUUID()),
        createdAt:raw.createdAt || new Date().toISOString(), updatedAt:raw.updatedAt,
        revision:Number(raw.revision) || 0, wallets, nonces,
        anvilGeneration:raw.anvilGeneration || null, lastProcessedBlock:cursor ?? null,
        lastProcessedBlockHash:raw.lastProcessedBlockHash || null,
        restoreRequired:!!raw.restoreRequired,
        pendingBaseAddresses:(raw.pendingBaseAddresses || []).map(a => ethers.getAddress(a))
    };
}
function atomicWrite(file,text) {
    fs.writeFileSync(file+".tmp",text,"utf8");
    fs.renameSync(file+".tmp",file);
}
function saveMemory(next, reason) {
    const saved = clone(next);
    saved.updatedAt = new Date().toISOString();
    saved.revision = (memory?.revision || saved.revision || 0) + 1;
    // 旧的有效账本作为备份；主文件写入成功后才替换内存对象。
    if (memory && fs.existsSync(MEMORY_FILE)) atomicWrite(MEMORY_FILE+".bak",JSON.stringify(memory));
    atomicWrite(MEMORY_FILE,JSON.stringify(saved));
    memory = saved;
    if (reason) {
        const encoded = Buffer.from(JSON.stringify(memory)).toString("base64");
        try {
            atomicWrite(path.join(DATA_DIR,"session-export.base64.txt"),encoded+"\n");
            atomicWrite(path.join(DATA_DIR,"lastKnownBalances.json"),JSON.stringify(memory.wallets));
            atomicWrite(path.join(DATA_DIR,"known_wallets.json"),JSON.stringify(
                Object.keys(memory.wallets).filter(a => !baseAddresses.some(b => b.toLowerCase()===a.toLowerCase()))));
        } catch (e) { console.error("[Memory] 权威文件已保存；辅助导出失败:",e.message); }
        console.log("[SessionExport] reason="+reason+" revision="+memory.revision+" base64="+encoded);
    }
}
function smartInitialize() {
    let raw, source;
    if (!FORCE_NEW_SESSION && (fs.existsSync(MEMORY_FILE) || fs.existsSync(MEMORY_FILE+".bak"))) {
        try { raw = parseMemory(JSON.parse(fs.readFileSync(MEMORY_FILE,"utf8"))); source="local"; }
        catch (e) {
            raw = parseMemory(JSON.parse(fs.readFileSync(MEMORY_FILE+".bak","utf8")));
            source="local-backup";
            console.error("[Memory] 使用上次有效备份，请核对最新转账");
        }
    } else {
        const imported = (process.env.SESSION_IMPORT_BASE64 || MANUAL_SESSION_IMPORT_BASE64).trim();
        if (!FORCE_NEW_SESSION && imported) {
            raw = parseMemory(JSON.parse(Buffer.from(imported,"base64").toString("utf8")));
            source="manual-import";
            raw.restoreRequired=true;
        } else {
            raw={ version:2,sessionId:crypto.randomUUID(),createdAt:new Date().toISOString(),revision:0,
                wallets:{},nonces:{},lastProcessedBlock:null,lastProcessedBlockHash:null,
                anvilGeneration:null,restoreRequired:true,pendingBaseAddresses:[] };
            source="new";
            // 兼容 restored 已经保存的余额文件；读取失败不悄悄重置初始余额。
            const legacy=path.join(DATA_DIR,"lastKnownBalances.json");
            if (!FORCE_NEW_SESSION && fs.existsSync(legacy)) {
                raw.wallets=JSON.parse(fs.readFileSync(legacy,"utf8"));
                raw=parseMemory(raw); source="restored-file";
            }
        }
    }
    for (const original of baseAddresses) {
        const address=ethers.getAddress(original);
        if (!raw.wallets[address] || FORCE_REFRESH_INITIAL) {
            raw.wallets[address]=initialBalances();
            raw.pendingBaseAddresses=Array.from(new Set([...raw.pendingBaseAddresses,address]));
        }
    }
    saveMemory(parseMemory(raw),source);
    console.log("[Memory] 来源="+source+"；钱包="+Object.keys(memory.wallets).length+
        "。恢复期间请勿转账，等待 READY。");
}

async function setErc20Balance(rpcProvider, tokenAddress, userAddress, amount, slots) {
    const paddedUser = ethers.zeroPadValue(userAddress,32);
    const amountHex = ethers.zeroPadValue(ethers.toBeHex(BigInt(amount)),32);
    for (const slotIndex of slots) {
        const balanceSlot = ethers.zeroPadValue(ethers.toBeHex(slotIndex),32);
        const slot = ethers.keccak256(ethers.concat([paddedUser,balanceSlot]));
        await rpcProvider.send("anvil_setStorageAt",[tokenAddress,slot,amountHex]);
    }
}
async function applyWallet(address, balances, expected, withNonce=false) {
    sameGeneration(expected);
    await provider.send("anvil_setBalance",[address,ethers.toQuantity(BigInt(balances.eth))]);
    for (const [s,t] of Object.entries(TOKENS)) {
        sameGeneration(expected);
        await setErc20Balance(provider,t.addr,address,balances[s],t.slots);
    }
    if (withNonce && memory.nonces[address] !== undefined) {
        sameGeneration(expected);
        await provider.send("anvil_setNonce",[address,ethers.toQuantity(memory.nonces[address])]);
    }
    sameGeneration(expected);
}
async function readBalances(address,block) {
    const result={eth:(await provider.getBalance(address,block)).toString()};
    for (const s of Object.keys(TOKENS)) result[s]=(await contracts[s].balanceOf.staticCall(address,{blockTag:block})).toString();
    return result; // 请求失败直接抛错，不把错误转成0
}
async function blockAt(number,full=false) {
    const block=await provider.getBlock(number,full);
    if (!block?.hash) throw new Error("无法读取确认区块 "+number);
    return block;
}
async function restoreMemory(expected) {
    if (restoreGeneration !== expected) { restoredWallets.clear(); restoreGeneration=expected; }
    if (!memory.restoreRequired) saveMemory({...memory,restoreRequired:true});
    for (const [address,balances] of Object.entries(memory.wallets)) {
        if (restoredWallets.has(address)) continue;
        await applyWallet(address,balances,expected,true);
        const verified=await readBalances(address,"latest");
        sameGeneration(expected);
        if (!sameBalances(balances,verified)) throw new Error("恢复余额不一致："+address);
        const nonce=await provider.getTransactionCount(address);
        if (memory.nonces[address] !== undefined && nonce !== memory.nonces[address]) throw new Error("恢复交易序号不一致");
        memory.nonces[address]=nonce;
        restoredWallets.add(address);
        console.log("[Memory] 恢复进度 "+restoredWallets.size+"/"+Object.keys(memory.wallets).length);
    }
    const number=await headNumber(), block=await blockAt(number);
    sameGeneration(expected);
    saveMemory({...memory,anvilGeneration:expected,lastProcessedBlock:number,lastProcessedBlockHash:block.hash,
        restoreRequired:false,pendingBaseAddresses:[]},"restore-complete");
    restoredWallets.clear();
    console.log("[Memory] READY：本次记忆已恢复，可进行分叉测试转账");
}
function walletAddress(address) {
    if (!address) return null;
    const a=ethers.getAddress(address);
    return a===ZERO || tokenByAddress.has(a.toLowerCase()) ? null : a;
}
async function recordBlocks(head,expected) {
    if (memory.lastProcessedBlock >= head) return true;
    const end=Math.min(head,memory.lastProcessedBlock+MAX_BLOCKS_PER_ROUND);
    const next=clone(memory), known=new Set(Object.keys(next.wallets)), touched=new Set();
    const add=a => { if (a) { known.add(a); touched.add(a); } };
    let finalHash;
    for (let n=memory.lastProcessedBlock+1;n<=end;n++) {
        const block=await blockAt(n,true); finalHash=block.hash;
        // 只有需要收据的实际交易才查询；不再每轮调用三次eth_getLogs。
        for (const tx of block.prefetchedTransactions) {
            const from=walletAddress(tx.from), to=walletAddress(tx.to);
            if (!known.has(from) && !known.has(to) && !tokenByAddress.has((tx.to||"").toLowerCase())) continue;
            const receipt=await provider.getTransactionReceipt(tx.hash);
            if (!receipt || receipt.blockHash !== block.hash) throw new Error("交易收据尚未确认，保留扫描位置");
            if (known.has(from)) touched.add(from); // 失败交易也会消耗ETH并增加nonce
            if (receipt.status !== 1) continue;
            if (tx.value>0n && (known.has(from)||known.has(to))) { add(from);add(to); }
            for (const log of receipt.logs) {
                if (!tokenByAddress.has(log.address.toLowerCase()) || log.topics[0]!==TRANSFER_TOPIC ||
                    log.topics.length!==3) continue;
                const sender=walletAddress("0x"+log.topics[1].slice(-40));
                const recipient=walletAddress("0x"+log.topics[2].slice(-40));
                if (known.has(sender)||known.has(recipient)) { add(sender);add(recipient); }
            }
        }
    }
    for (const address of touched) {
        next.wallets[address]=await readBalances(address,end);
        next.nonces[address]=await provider.getTransactionCount(address,end);
    }
    // 整批读取成功、节点没有换代才提交；中途失败不推进游标也不记零。
    sameGeneration(expected);
    if ((await blockAt(end)).hash !== finalHash) throw new Error("扫描期间区块变化，下一轮重读");
    sameGeneration(expected);
    next.lastProcessedBlock=end; next.lastProcessedBlockHash=finalHash;
    saveMemory(next,touched.size ? "confirmed-transfer" : undefined);
    return end===head;
}
async function initializeAddedWallets(expected) {
    for (const address of [...memory.pendingBaseAddresses]) {
        const balances=FORCE_REFRESH_INITIAL && baseAddresses.some(a=>ethers.getAddress(a)===address)
            ? initialBalances() : memory.wallets[address];
        await applyWallet(address,balances,expected);
        const nonce=await provider.getTransactionCount(address);
        sameGeneration(expected);
        const next=clone(memory);
        next.wallets[address]=balances;
        next.nonces[address]=nonce;
        next.pendingBaseAddresses=next.pendingBaseAddresses.filter(a=>a!==address);
        saveMemory(next,"added-base-wallet");
    }
}
async function auditMemory(expected) {
    // 保留 restored 每轮检查全部钱包；不再直接学习任何非零旧快照。
    for (const [address,balance] of Object.entries(memory.wallets)) {
        const block=memory.lastProcessedBlock;
        try {
            const seen=await readBalances(address,block);
            if (sameBalances(balance,seen)) continue;
            // 有新块或待确认交易时先让下轮补记交易，不用旧记忆覆盖进行中的转账。
            if (await headNumber() !== block) return;
            const confirmed=await provider.getTransactionCount(address,"latest");
            const pending=await provider.getTransactionCount(address,"pending");
            if (pending!==confirmed) continue;
            sameGeneration(expected);
            if (await headNumber() !== block) return;
            await applyWallet(address,balance,expected);
            console.log("[Memory] 已按本次记忆恢复异常余额："+address);
        } catch (e) {
            console.error("[Protect] 本钱包读取/恢复失败，不修改记忆:",e.message);
            sameGeneration(expected);
        }
    }
}
async function watchAndProtect() {
    if (watchInProgress || shuttingDown) return;
    watchInProgress=true;
    try {
        const expected=generation(), head=await headNumber();
        const nodeChanged=memory.anvilGeneration!==expected ||
            memory.lastProcessedBlock===null || head<memory.lastProcessedBlock;
        const hashChanged=!nodeChanged && memory.lastProcessedBlockHash &&
            (await blockAt(memory.lastProcessedBlock)).hash!==memory.lastProcessedBlockHash;
        if (memory.restoreRequired || nodeChanged || hashChanged) {
            await restoreMemory(expected);
            return;
        }
        if (!await recordBlocks(head,expected)) return; // 积压时先补扫，不并发审计
        await initializeAddedWallets(expected);
        await auditMemory(expected);
    } catch (e) {
        console.error("[Memory] 本轮未完成，保留记忆；3秒后继续:",e.message);
    } finally { watchInProgress=false; }
}

// 以下仍采用 restored 的简单健康端口和单轮循环；不加公共RPC代理或心跳看门狗。
function startHealthServer() {
    const server=http.createServer((req,res)=>{
        res.writeHead(200,{"Content-Type":"text/plain"});res.end("OK");
    });
    server.listen(HEALTH_PORT,"0.0.0.0",()=>console.log("[Health] JS保护器端口 "+HEALTH_PORT+" 已启动"));
}
async function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown=true;
    console.log("[Shutdown] 收到 "+signal+"，保存本次记忆");
    try { if (memory) saveMemory(memory,"shutdown"); }
    catch (e) { console.error("[Memory] 保存失败:",e.message); }
    process.exit(0);
}
async function run() {
    startHealthServer();
    smartInitialize();
    const loop=async()=>{
        await watchAndProtect();
        if (!shuttingDown) setTimeout(loop,CHECK_INTERVAL_MS);
    };
    loop();
}
process.on("SIGTERM",()=>gracefulShutdown("SIGTERM"));
process.on("SIGINT",()=>gracefulShutdown("SIGINT"));
run().catch(e=>{console.error("[Fatal] 记忆文件/配置错误，拒绝自动清空:",e);process.exit(1);});

