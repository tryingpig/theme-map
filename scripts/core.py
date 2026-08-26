#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""테마 맵 공용 코어 — 수집·지표 계산 (테마 무관).

지표 규칙은 사용자가 준 증권사 화면을 역산해 그대로 맞췄다.
2026-08-26 종가 기준으로 16종목 현재가 + 7종목 지표가 소수 둘째 자리까지 일치함을 확인했다:

  · %1일·%5일   = 거래일 1일/5일 전 종가 대비
  · %1개월·%1년 = **캘린더** 1개월/1년 전 날짜 이하 마지막 거래일 대비 (거래일 21/252로는 재현 불가)
  · 고점대비     = 최근 1년(52주) **장중 최고가(High)** 대비 — 종가 고점이 아니다
  · 가격         = 조정 없는 Close. Yahoo의 Close는 액면분할이 이미 반영되고 배당은 미반영이라
                   국내 HTS 수익률과 같다. Adj Close를 쓰면 배당이 섞여 어긋난다(한전KPS 1년 -4.70 → -1.41).

PERIOD_MODE를 "trading"으로 바꾸면 거래일(21/252) 기준으로도 계산된다(원본 화면과는 값이 달라진다).
"""

import time

import pandas as pd
import yfinance as yf

PERIOD_MODE = "calendar"   # "calendar" = 원본 화면과 동일 / "trading" = 거래일 21·252일
TRADING_1M = 21            # PERIOD_MODE="trading"일 때만 사용
TRADING_1Y = 252
HISTORY_PERIOD = "max"     # 사상 최고가를 잡으려면 전체 기간이 필요하다
INDEX_KEEP_DAYS = 1300     # 테마 지수 산출 구간(약 5년) — 그 이전은 구성종목이 한둘뿐이라 지수가 아니다


def fetch_history(symbol: str, retries: int = 3) -> pd.DataFrame:
    """yfinance 일봉을 받는다(조정 없음). 실패 시 지수적으로 쉬며 재시도."""
    last_err = None
    for attempt in range(1, retries + 1):
        try:
            df = yf.Ticker(symbol).history(
                period=HISTORY_PERIOD, interval="1d", auto_adjust=False
            )
            if df is not None and not df.empty and "Close" in df.columns:
                df = df[df["Close"] > 0]
                if not df.empty:
                    return df
            last_err = f"빈 데이터 (시도 {attempt})"
        except Exception as e:  # noqa: BLE001
            last_err = str(e)
        time.sleep(2 * attempt)
    raise RuntimeError(f"{symbol} 수집 실패: {last_err}")


def _pct(now, then):
    """수익률(%). 기준값이 없으면 None(상장 이력이 짧은 종목)."""
    if then is None or then == 0 or pd.isna(then):
        return None
    return round((float(now) / float(then) - 1) * 100, 2)


def _asof(series: pd.Series, when) -> float:
    """when 이하 마지막 거래일 값. 그보다 이른 데이터가 없으면 None."""
    sub = series[series.index <= when]
    return float(sub.iloc[-1]) if len(sub) else None


def _nth_back(series: pd.Series, n: int) -> float:
    return float(series.iloc[-1 - n]) if len(series) > n else None


def compute_metrics(close: pd.Series, high: pd.Series = None, mode: str = None) -> dict:
    """종가(그리고 있으면 고가) 시리즈에서 표에 쓰는 지표 전부를 만든다.

    high=None이면 고점 계산에도 종가를 쓴다(테마 지수처럼 고가가 없는 시계열).
    """
    mode = mode or PERIOD_MODE
    close = close.dropna()
    if close.empty:
        raise RuntimeError("종가 데이터 없음")

    last_dt = close.index[-1]
    last = float(close.iloc[-1])

    if mode == "calendar":
        r1m = _pct(last, _asof(close, last_dt - pd.DateOffset(months=1)))
        r1y = _pct(last, _asof(close, last_dt - pd.DateOffset(years=1)))
    else:
        r1m = _pct(last, _nth_back(close, TRADING_1M))
        r1y = _pct(last, _nth_back(close, TRADING_1Y))

    peak_src = high.dropna() if high is not None else close
    win = peak_src.index >= (last_dt - pd.DateOffset(years=1))
    peak_52w = peak_src[win]

    def _from_high(peaks):
        if peaks.empty:
            return None, None, None
        hi = float(peaks.max())
        return round((last / hi - 1) * 100, 2), round(hi, 2), peaks.idxmax().strftime("%Y-%m-%d")

    from_52w, high_52w, high_52w_date = _from_high(peak_52w)
    from_all, high_all, high_all_date = _from_high(peak_src)

    return {
        "close": round(last, 2),
        "as_of": last_dt.strftime("%Y-%m-%d"),
        "r1d": _pct(last, _nth_back(close, 1)),
        "r5d": _pct(last, _nth_back(close, 5)),
        "r1m": r1m,
        "r1y": r1y,
        "from_52w_high": from_52w,
        "high_52w": high_52w,
        "high_52w_date": high_52w_date,
        "from_all_high": from_all,
        "high_all": high_all,
        "high_all_date": high_all_date,
        "bars": len(close),
        "first_date": close.index[0].strftime("%Y-%m-%d"),
    }


def equal_weight_index(closes: list) -> pd.Series:
    """구성종목 종가들로 동일가중 지수를 만든다(시작 100).

    단순히 가격을 평균하지 않고 **일간 수익률의 평균을 누적**한다.
    그래야 상장일이 제각각인 테마(우진엔텍 2024 상장 등)에서 신규 편입일에 지수가 튀지 않는다.
    각 날짜에는 그날 수익률을 계산할 수 있는 종목만 참여한다.
    """
    frame = pd.DataFrame({i: s.pct_change() for i, s in enumerate(closes)})
    daily = frame.mean(axis=1).dropna()
    if daily.empty:
        raise RuntimeError("지수 산출 불가 (공통 거래일 없음)")
    return (1 + daily).cumprod() * 100


def average_metrics(rows: list) -> dict:
    """종목 지표들의 단순 평균(역할 그룹 소계용). None은 빼고 평균한다."""
    keys = ["r1d", "r5d", "r1m", "r1y", "from_52w_high", "from_all_high"]
    out = {}
    for k in keys:
        vals = [r[k] for r in rows if r.get(k) is not None]
        out[k] = round(sum(vals) / len(vals), 2) if vals else None
    out["count"] = len(rows)
    return out
