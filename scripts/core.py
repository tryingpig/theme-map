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
from datetime import datetime, timedelta, timezone

import pandas as pd
import yfinance as yf

KST = timezone(timedelta(hours=9))
MARKET_CLOSE = (15, 40)    # 정규장 15:30 + 종가 단일가 여유

PERIOD_MODE = "calendar"   # "calendar" = 원본 화면과 동일 / "trading" = 거래일 21·252일
TRADING_1M = 21            # PERIOD_MODE="trading"일 때만 사용
TRADING_1Y = 252
HISTORY_PERIOD = "max"     # 사상 최고가를 잡으려면 전체 기간이 필요하다
BACKFILL_DAYS = 300        # 테마 지수를 **처음 만들 때만** 소급 계산하는 구간(거래일).
                           # 화면 최대 기간이 1년이라 여유를 조금 둔 길이다.
                           # 그 뒤로는 재계산하지 않고 하루치씩 이어 붙인다(accumulate 참고).

# 시장 지수 — 테마가 시장을 이기는지 보려면 같은 축 위에 있어야 한다.
# 야후의 ^KS11/^KQ11은 코스피·코스닥 종가와 같다(2026-08-28 확인).
MARKETS = [("KOSPI", "코스피", "^KS11"), ("KOSDAQ", "코스닥", "^KQ11")]


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
                df = drop_unsettled_today(df)
                if not df.empty:
                    return df
            last_err = f"빈 데이터 (시도 {attempt})"
        except Exception as e:  # noqa: BLE001
            last_err = str(e)
        time.sleep(2 * attempt)
    raise RuntimeError(f"{symbol} 수집 실패: {last_err}")


def drop_unsettled_today(df: pd.DataFrame) -> pd.DataFrame:
    """장 마감 전이면 당일 봉을 버린다.

    야후는 장중에도 그날 봉을 준다. 그대로 쓰면 '종가 기준'이라고 써 놓고 장중 가격을
    보여주게 된다(2026-08-27 11:19에 재현 — 8/27 장중가가 종가 자리에 들어갔다).
    """
    if df.empty:
        return df
    now = datetime.now(KST)
    if df.index[-1].date() == now.date() and (now.hour, now.minute) < MARKET_CLOSE:
        return df.iloc[:-1]
    return df


def fetch_market_cap(symbol: str):
    """시총(원). 화면의 '시총 5천억 이상만' 필터에 쓴다.

    시총은 매일 바뀌므로 노션에 적어 두지 않고 수집할 때 같이 받는다.
    실패해도 수집 전체를 죽이지 않는다 — None이면 프론트에서 필터 대상에서 빠진다.
    """
    try:
        return yf.Ticker(symbol).info.get("marketCap")
    except Exception:  # noqa: BLE001
        return None


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


def align(series: pd.Series, axis: pd.DatetimeIndex) -> list:
    """시계열을 공통 날짜축(시장 거래일)에 맞춘다.

    축에 없는 날은 버리고, 축에는 있는데 그 종목/지수엔 없는 날은 직전 값으로 채운다
    (거래정지·상장 전). 상장 전 구간은 채울 값이 없어 None으로 남고 차트에서 선이 끊긴다.
    """
    s = series.dropna()
    s.index = pd.to_datetime([d.strftime("%Y-%m-%d") for d in s.index])
    r = s.reindex(axis.union(s.index)).ffill().reindex(axis)
    return [None if pd.isna(v) else round(float(v), 2) for v in r]


def rebase(series: pd.Series) -> pd.Series:
    """시작을 100으로 맞춘 지수. 시장 지수(코스피 6,841 vs 코스닥 836)를 한 차트에 올릴 때 쓴다."""
    s = series.dropna()
    return s / float(s.iloc[0]) * 100


def accumulate(prev: dict, fresh: pd.Series, axis_dates: list) -> list:
    """지수를 **적립**한다 — 이미 기록된 날의 값은 절대 다시 계산하지 않는다.

    매 실행마다 전 구간을 다시 계산하면, 오늘 종목 하나를 빼는 순간 3개월 전 수익률까지
    같이 바뀐다. 그러면 "그때 이 테마가 얼마였나"라는 기록이 남지 않는다.
    그래서 이렇게 한다:

      · 저장된 날짜  → 저장된 값 그대로 (구성이 바뀌어도 과거는 그대로 남는다)
      · 새 거래일    → 마지막 지수 × (1 + 그날 구성종목 평균 등락률)
      · 기록이 아예 없을 때(새 테마·최초 실행) → fresh로 그 구간을 한 번 소급해 깔고 100에서 시작

    구성 변경은 이 구조에서 **변경한 날 이후에만** 영향을 준다. 지수 레벨이 이어지므로
    편입·제외로 선이 튀지도 않는다.

    prev: {날짜: 값} — 지금까지 적립된 값
    fresh: 현재 구성종목으로 계산한 동일가중 지수(레벨은 아무 값이나 무방, 등락률만 쓴다)
    """
    ret = {d.strftime("%Y-%m-%d"): v for d, v in fresh.pct_change().items()}
    lvl = {d.strftime("%Y-%m-%d"): float(v) for d, v in fresh.items()}

    base = next((lvl[d] for d in axis_dates if d in lvl), None)
    out, last = [], None
    for d in axis_dates:
        p = prev.get(d)
        if p is not None:
            last = float(p)
        elif last is None:
            # 아직 이어 붙일 앞 값이 없다 → 소급 구간. 구간 첫 거래일을 100으로 둔다.
            last = (lvl[d] / base * 100) if (d in lvl and base) else None
        else:
            r = ret.get(d)
            # 그날 시세가 없으면(전 종목 거래정지 등) 지수를 유지한다 — 0으로 떨어뜨리지 않는다.
            last = last * (1 + float(r)) if r is not None and not pd.isna(r) else last
        # 소수 넷째 자리까지 남긴다 — 저장값에서 다시 곱해 이어 가므로, 두 자리로 자르면
        # 반올림 오차가 매일 조금씩 누적된다(5일 이어 붙였을 때 0.01 어긋나는 걸 확인했다).
        out.append(None if last is None else round(last, 4))
    return out
