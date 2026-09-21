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

// 默认仍保存在 JS 同目录；Render 会通过 DATA_DIR 指向容器数据目录。
const DATA_DIR = process.env.DATA_DIR || __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });
const WALLET_FILE = path.join(DATA_DIR, "known_wallets.json");
const BALANCE_FILE = path.join(DATA_DIR, "lastKnownBalances.json");

let savedWallets = [];
if (fs.existsSync(WALLET_FILE)) {
    try {
        const parsed = JSON.parse(fs.readFileSync(WALLET_FILE, "utf8"));
        if (Array.isArray(parsed)) savedWallets = parsed;
    } catch (e) {
        console.error("[State] known_wallets.json 读取失败，将保留基础钱包:", e.message || e);
    }
}
const monitoredWallets = new Set([...baseAddresses, ...savedWallets]);

// 完整保留原版代币、精度与 Storage Slot。
const TOKENS = {
    usdt: { addr: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, slots: [0, 2] },
    usdc: { addr: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, slots: [0, 9] },
    wbtc: { addr: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", decimals: 8, slots: [0] }
};

const minABI = ["function balanceOf(address) view returns (uint256)"];
let lastKnownBalances = {};
let watchInProgress = false;
let shuttingDown = false;

function saveStateToDisk() {
    const currentSavedList = Array.from(monitoredWallets).filter(
        (addr) => !baseAddresses.includes(addr)
    );
    fs.writeFileSync(WALLET_FILE, JSON.stringify(currentSavedList, null, 2), "utf8");

    const diskBalances = {};
    for (const addr of Object.keys(lastKnownBalances)) {
        const balance = lastKnownBalances[addr];
        diskBalances[addr] = {
            eth: balance.eth.toString(),
            usdt: balance.usdt.toString(),
            usdc: balance.usdc.toString(),
            wbtc: balance.wbtc.toString()
        };
    }
    fs.writeFileSync(BALANCE_FILE, JSON.stringify(diskBalances, null, 2), "utf8");
}

async function smartInitialize() {
    console.log("🔄 [智慧探針] 正在加載硬核影子帳本...");

    // 1. 完整保留原版本地余额记忆读取逻辑。
    if (fs.existsSync(BALANCE_FILE) && !FORCE_REFRESH_INITIAL) {
        try {
            const parsed = JSON.parse(fs.readFileSync(BALANCE_FILE, "utf8"));
            for (const addr of Object.keys(parsed)) {
                lastKnownBalances[addr] = {
                    eth: BigInt(parsed[addr].eth || "0"),
                    usdt: BigInt(parsed[addr].usdt || "0"),
                    usdc: BigInt(parsed[addr].usdc || "0"),
                    wbtc: BigInt(parsed[addr].wbtc || "0")
                };
            }
            console.log("💾 [讀取成功] 已加載本地歷史記憶。");
        } catch (e) {
            console.error("[State] lastKnownBalances.json 读取失败:", e.message || e);
        }
    }

    // 2. 完整保留原版基础钱包预设余额与强制刷新开关。
    for (const addr of baseAddresses) {
        if (!lastKnownBalances[addr] || FORCE_REFRESH_INITIAL) {
            lastKnownBalances[addr] = {
                eth: ethers.parseEther("99999999"),
                usdt: ethers.parseUnits("1000000000", 6),
                usdc: ethers.parseUnits("6767676767", 6),
                wbtc: ethers.parseUnits("67", 8)
            };
        }
    }

    saveStateToDisk();
    console.log(`[Config] RPC=${RPC_URL}，基础钱包=${baseAddresses.length}，全部监控钱包=${monitoredWallets.size}`);
    console.log("🟢 [探針完畢] 影子帳本全域鎖定。ETH 與代幣資產已綁定防護。");
}

async function watchAndProtect() {
    // 唯一的性能保护：上一轮没结束时不重叠启动；不减少钱包、不延长3秒间隔。
    if (watchInProgress || shuttingDown) return;
    watchInProgress = true;

    try {
        let hasNewWallet = false;
        let stateChanged = false;

        // 📡 1. 完整保留原版：每轮扫描最近5个区块并自动发现 from/to。
        try {
            const latestBlock = await provider.getBlockNumber();
            const startBlock = Math.max(0, latestBlock - 4);
            for (let i = startBlock; i <= latestBlock; i++) {
                const block = await provider.getBlock(i, true);
                if (!block || !block.prefetchedTransactions) continue;

                for (const tx of block.prefetchedTransactions) {
                    for (const candidate of [tx.from, tx.to]) {
                        if (!candidate) continue;
                        try {
                            const formatted = ethers.getAddress(candidate);
                            if (!monitoredWallets.has(formatted)) {
                                monitoredWallets.add(formatted);
                                hasNewWallet = true;
                                console.log(`[Wallet] 自动发现并加入: ${formatted}`);
                            }
                        } catch (e) {
                            console.error(`[Wallet] 跳过无效交易地址 ${candidate}:`, e.message || e);
                        }
                    }
                }
            }
        } catch (e) {
            console.error("[Radar] 最近5个区块扫描失败，本轮继续保护已有钱包:", e.message || e);
        }

        // 🛡️ 2. 完整保留原版：每轮检查全部钱包，不分批、不裁剪。
        const walletList = Array.from(monitoredWallets);
        for (const addr of walletList) {
            if (!lastKnownBalances[addr]) {
                lastKnownBalances[addr] = { eth: 0n, usdt: 0n, usdc: 0n, wbtc: 0n };
            }

            try {
                let nodeEth = await provider.getBalance(addr).catch(() => 0n);
                if (nodeEth > 0n) {
                    if (nodeEth !== lastKnownBalances[addr].eth) {
                        lastKnownBalances[addr].eth = nodeEth;
                        stateChanged = true;
                    }
                } else {
                    const targetEth = lastKnownBalances[addr].eth;
                    if (targetEth > 0n) {
                        await provider.send("anvil_setBalance", [addr, ethers.toQuantity(targetEth)]);
                    }
                }

                for (const [symbol, config] of Object.entries(TOKENS)) {
                    const nodeContract = new ethers.Contract(config.addr, minABI, provider);
                    const nodeBal = await nodeContract.balanceOf(addr).catch(() => 0n);

                    if (nodeBal > 0n) {
                        if (nodeBal !== lastKnownBalances[addr][symbol]) {
                            lastKnownBalances[addr][symbol] = nodeBal;
                            stateChanged = true;
                        }
                    } else {
                        const targetRecover = lastKnownBalances[addr][symbol];
                        if (targetRecover > 0n) {
                            await setErc20Balance(
                                provider,
                                config.addr,
                                addr,
                                targetRecover,
                                config.slots
                            );
                        }
                    }
                }
            } catch (err) {
                // 一个钱包失败只跳过该钱包，不中止其余钱包。
                console.error(`[Protect] 钱包 ${addr} 本轮失败:`, err.message || err);
            }
        }

        if (hasNewWallet || stateChanged) {
            saveStateToDisk();
            // 完整保留原版 Anvil 状态导出调用。
            try {
                await provider.send("anvil_dumpState", []);
            } catch (e) {
                console.error("[State] anvil_dumpState 失败:", e.message || e);
            }
        }
    } finally {
        watchInProgress = false;
    }
}

async function setErc20Balance(rpcProvider, tokenAddress, userAddress, amount, slots) {
    const paddedUser = ethers.zeroPadValue(userAddress, 32);
    const amountHex = ethers.zeroPadValue(ethers.toBeHex(amount), 32);
    for (const slotIndex of slots) {
        const balanceSlot = ethers.zeroPadValue(ethers.toBeHex(slotIndex), 32);
        const slot = ethers.keccak256(ethers.concat([paddedUser, balanceSlot]));
        await rpcProvider.send("anvil_setStorageAt", [tokenAddress, slot, amountHex]);
    }
}

function startHealthServer() {
    const server = http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("OK");
    });
    server.listen(HEALTH_PORT, "0.0.0.0", () => {
        console.log(`[Health] JS保护器端口 ${HEALTH_PORT} 已启动`);
    });
    return server;
}

async function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Shutdown] 收到 ${signal}，正在保存钱包与余额记忆...`);
    try {
        saveStateToDisk();
        await provider.send("anvil_dumpState", []).catch(() => {});
    } catch (e) {
        console.error("[Shutdown] 保存失败:", e.message || e);
    }
    process.exit(0);
}

async function run() {
    startHealthServer();
    await smartInitialize();
    console.log(`[${new Date().toLocaleTimeString()}] 🚀 小貓5版原功能恢复版已启动，守護中...`);

    // 等待本轮真正完成后再计时3秒，彻底避免 setInterval 重叠。
    const loop = async () => {
        try {
            await watchAndProtect();
        } catch (e) {
            console.error("[Loop] 未处理错误:", e.message || e);
        }
        if (!shuttingDown) setTimeout(loop, CHECK_INTERVAL_MS);
    };
    loop();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

run().catch((e) => {
    console.error("[Fatal] JS保护器启动失败:", e);
    process.exit(1);
});
