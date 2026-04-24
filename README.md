# SMS-Bot (Solana Meme Coin Sniper)

Paper trading 优先。实盘（live）尚未启用。

## 启动步骤

```bash
# 1. 安装
npm install

# 2. 填 smart money 钱包 (config/smart_wallets.json)
#    从 GMGN.ai / kolscan.io 复制 15-20 个 top traders 地址

# 3. 确认 .env 配置正确 (已预填 Helius key 和 bot 地址)

# 4. 启动 paper 模式
npm run dev
```

## 目录结构

```
src/
  config.ts              读取 .env 和 strategy.json
  types.ts               共享类型
  logger.ts              pino
  db.ts                  SQLite (active_positions / trades / filter_rejects)
  listeners/
    smart-money.ts       Helius logsSubscribe + 每个 wallet 一个订阅
    pumpfun.ts           pump.fun program logs
  signals/aggregator.ts  双路信号融合 + 仓位大小
  filters/safety.ts      Rugcheck
  positions/manager.ts   并发数, 日亏熔断, 重复持仓检查
  execution/
    jupiter.ts           Jupiter v6 quote
    paper.ts             模拟买卖, 写入 SQLite
  monitor/position-monitor.ts  3 秒轮询 + 五档规则
  index.ts               orchestrator
config/
  strategy.json          所有策略参数
  smart_wallets.json     钱包列表
data/
  sms-bot.sqlite         运行时生成
```

## 策略参数

所有可调参数在 `config/strategy.json`，无需重启写代码。主要参数：

| 分组 | 参数 | 默认 | 说明 |
|------|------|------|------|
| positions | maxConcurrent | 8 | 最大并行持仓 |
| positions | dailyLossLimitSol | 6 | 日亏熔断 |
| signals.smartMoney | minUniqueWallets | 2 | 几个钱包同买触发 |
| signals.pumpfun | observeSeconds | 45 | 新币观察期 |
| filter | rugcheckMinScore | 70 | 最低安全分 |
| takeProfit | tier1 | +50% 卖 30% | 第一档 |
| takeProfit | tier2 | +100% 卖 40% | 第二档 |
| takeProfit | trailingDrawdownPercent | 25 | 追踪止盈回撤 |
| stopLoss | hardStopPercent | -40 | 硬止损 |
| stopLoss | timeStopMinutes | 5 | 时间止损 |

## 数据复盘

```sql
-- 胜率 + 平均盈亏 (按信号源)
SELECT signal_source, COUNT(*) AS n,
       SUM(CASE WHEN realized_pnl_sol > 0 THEN 1 ELSE 0 END) * 1.0 / COUNT(*) AS win_rate,
       AVG(realized_pnl_percent) AS avg_pnl_pct
FROM trades GROUP BY signal_source;

-- 退出原因分布
SELECT exit_reason, COUNT(*), AVG(realized_pnl_percent)
FROM trades GROUP BY exit_reason;

-- 时间止损触发率 (应 < 40%)
SELECT 1.0 * SUM(exit_reason='time_stop') / COUNT(*) AS time_stop_rate FROM trades;

-- Triggering wallet 贡献排名 (需 JSON 解析)
SELECT json_each.value AS wallet,
       SUM(realized_pnl_sol) AS pnl
FROM trades, json_each(trades.triggering_wallets)
GROUP BY wallet ORDER BY pnl DESC;
```

## Paper → Live 迁移 checklist

- [ ] Paper 累计 ≥ 50 笔, 时间止损率 < 40%, 总 PnL 为正
- [ ] 实现 `src/execution/live.ts` (Jupiter swap + Jito bundle)
- [ ] 创建 bot 独立钱包 (`solana-keygen new`), 私钥文件 chmod 600
- [ ] `BOT_WALLET_KEYPAIR_PATH` 指向 keypair.json, 钱包充值 3.3 SOL (500 USDC)
- [ ] 观察 50 笔真实交易后再放大到 33 SOL

## 风险提醒

- 新币死亡率 > 99%, 预期时间止损触发率较高
- Smart wallet 列表质量决定信号质量, **周度复盘必做**
- 单日亏损 > 6 SOL 自动熔断, 当日停止买入
