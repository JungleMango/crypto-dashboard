# Signal backtest

Replays the dashboard's signals (Trend, Adaptive Trend, OI / Price, Order Flow) over Binance USD-M
futures history and measures what price did after each signal flipped. It runs the same code as the
dashboard (`../indicators.js`), so the results describe exactly what you see on screen, measured on
closed candles.

Needs Node 18+ and no `npm install`.

```sh
node backtest/backtest.mjs                                    # 6 default symbols, 1h, last 180 days
node backtest/backtest.mjs --symbols BTC,ETH,SOL --tf 4h --days 365
node backtest/backtest.mjs --trend-preset fast --adaptive-preset smooth
```

Data comes from Binance's public archive (data.binance.vision). It keeps open-interest history for
years, unlike the live API's ~30 days. Downloads are cached in `backtest/.cache/`.

## Output: `backtest/results/<tf>/`

| file | contents |
|---|---|
| `summary.csv` | per signal value: number of flips, average return after 1/4/12/24 candles, win rate, edge vs. the baseline, how long the signal lasted |
| `events.csv` | one row per flip: the indicator inputs (consensus, conviction, ribbon spread, OI change, order-flow pressure, funding, top-trader and taker long/short ratios, relative volume) and what happened next |
| `bars.csv` | the same readings for every candle, for tuning thresholds or testing combinations |

- **win**: the share of flips where price then moved the way the signal pointed.
- **edge**: the signal's direction-adjusted return minus the average return of every candle (the
  baseline). A signal that only says "up" in a bull market has a high win rate but no edge.
- Treat any row with fewer than ~30 flips as noise.

## Live log from the dashboard

**Export signal log** in the dashboard downloads the flips it saw while the page was open, with the
same columns as `events.csv`. Outcomes are filled in 24 candles later. The log is stored in that
browser only, so export it regularly.
