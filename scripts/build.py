#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""테마 맵 드라이버 — data/universe.json을 읽어 테마별 JSON을 만든다.

  python scripts/build.py            # 유니버스에 있는 모든 대테마
  python scripts/build.py 원자력 조선  # 지정한 대테마만

계층은 **대테마 > 역할 > 종목** 이다.
대테마와 역할 그룹은 단순 나열이 아니라 각각 집계값을 갖는다:
  · 대테마 = 구성종목 동일가중 지수(core.equal_weight_index)에서 뽑은 지표 — 테마 자체의 수익률
  · 역할   = 구성종목 지표의 단순 평균 — "오늘은 정비주가 갔고 EPC는 안 갔다"를 보는 축
표시 순서는 별도 필드 없이 정렬순서(숫자)로 정한다. 역할 그룹 순서 = 그룹 내 정렬순서 최솟값.

테마 지수의 **일별 시계열**도 같이 저장한다(data/series.json). 코스피·코스닥을 같은 날짜축에
올려 두어야 '이 테마가 시장을 이기는지'를 화면에서 바로 비교할 수 있다.

시계열은 **적립**이다 — 매 실행마다 전 구간을 다시 계산하지 않고, 이미 저장된 날은 그대로 두고
새 거래일만 이어 붙인다(core.accumulate). 그래야 종목을 하나 넣고 빼도 과거 기록이 흔들리지 않는다.
처음 한 번만 core.BACKFILL_DAYS 만큼 소급해 깐다.

  python scripts/build.py --rebuild-series   # 적립분을 버리고 현재 구성으로 전 구간 다시 계산(비상용)
"""

import io
import json
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

import pandas as pd

import core

# 윈도우 콘솔(cp949)에서 한글·em dash 출력이 UnicodeEncodeError로 죽는 걸 막는다.
for _name in ("stdout", "stderr"):
    _s = getattr(sys, _name)
    if getattr(_s, "encoding", "").lower() not in ("utf-8", "utf8"):
        setattr(sys, _name, io.TextIOWrapper(_s.buffer, encoding="utf-8", errors="replace"))

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
THEMES_DIR = DATA / "themes"
UNIVERSE = DATA / "universe.json"
KST = timezone(timedelta(hours=9))
CAP_THRESHOLD = 5000e8      # 시총 5,000억 — 화면의 '시총 5천억 이상만' 필터 기준

_history_cache = {}


def symbol_of(stock: dict) -> str:
    return f"{stock['code']}.{stock['market']}"


def history(symbol: str):
    """같은 종목이 여러 테마에 걸쳐 있어도 수집은 한 번만 한다."""
    if symbol not in _history_cache:
        _history_cache[symbol] = core.fetch_history(symbol)
    return _history_cache[symbol]


def load_json(path: Path):
    """이미 저장된 JSON을 읽는다. 없거나 깨졌으면 None."""
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None


def summarize(payload: dict) -> dict:
    """테마 JSON에서 index.json에 실을 요약 한 줄을 뽑는다."""
    return {
        "id": payload["theme"]["id"], "name": payload["theme"]["name"],
        "count": payload["index"]["count"],
        "as_of": payload["as_of"],
        **{k: payload["index"].get(k) for k in
           ("r1d", "r5d", "r1m", "r1y", "from_52w_high", "from_all_high")},
    }


def load_universe() -> dict:
    if not UNIVERSE.exists():
        raise SystemExit(
            f"{UNIVERSE} 없음 — 노션 동기화(scripts/sync_from_notion.py)를 먼저 실행하세요."
        )
    return json.loads(UNIVERSE.read_text(encoding="utf-8"))


def collect_markets():
    """코스피·코스닥 지수를 받아 지표와 종가 시계열을 만든다.

    **첫 시장(코스피)의 거래일이 모든 시계열의 공통 날짜축**이다. 테마 지수도 이 축에 맞춰
    붙여야 같은 x축 위에서 "테마가 시장을 이겼나"를 볼 수 있다. 코스닥은 휴장일이 코스피와
    같으므로 축을 따로 두지 않는다(다르면 core.align이 직전 값으로 메운다).
    """
    rows, closes = [], {}
    for mid, name, symbol in core.MARKETS:
        df = core.fetch_history(symbol)
        close = df["Close"].dropna()
        close.index = pd.to_datetime([d.strftime("%Y-%m-%d") for d in close.index])
        m = core.compute_metrics(df["Close"], df.get("High"))
        rows.append({"id": mid, "name": name, "symbol": symbol, **m})
        closes[mid] = close
        print(f"    [OK] {name:6s} {m['close']:>10,.2f}  1일 {m['r1d']:>7}  1년 {m['r1y']:>8}")
    return rows, closes


def load_store() -> dict:
    """지금까지 적립된 시계열(data/series.json). 없으면 빈 상자 — 그때는 소급 구간을 깐다."""
    raw = load_json(DATA / "series.json") or {}
    values = {}
    for row in (raw.get("markets") or []) + (raw.get("themes") or []):
        values[row["id"]] = row["values"]
    return {"dates": raw.get("dates") or [], "values": values, "as_of": raw.get("as_of", "")}


def build_axis(store: dict, market_dates: list, rebuild: bool) -> list:
    """날짜축은 **append-only**다. 이미 적립한 날은 지우지 않고 새 거래일만 뒤에 붙인다.

    처음이거나 --rebuild-series일 때만 최근 BACKFILL_DAYS 거래일로 축을 새로 깐다.
    """
    if rebuild or not store["dates"]:
        return market_dates[-core.BACKFILL_DAYS:]
    last = store["dates"][-1]
    return store["dates"] + [d for d in market_dates if d > last]


def stored_map(dates: list, values: list) -> dict:
    """{날짜: 값} — 적립분을 그대로 다시 쓰기 위한 조회표."""
    return {d: v for d, v in zip(dates or [], values or []) if v is not None}


RS_WINDOW = 20      # 상대강도 이동평균 구간(거래일) — 약 1개월


def rs_signal(values: list, base_values: list, axis_dates: list, window: int = RS_WINDOW):
    """**시장을 이기기 시작한 시점**을 찾는다.

    상대강도 RS = 테마지수 ÷ 코스피. 이 선이 자기 20일 이동평균을 위로 넘은 날이 전환일이다.
    지수 레벨이 아니라 비율이라 기간을 어떻게 잘라 봐도 전환일은 그대로다.

    판정은 **돌파 즉시**다(사용자 선택). 확인 기간을 두지 않으므로 하루 스쳤다 되돌아가는
    신호도 잡힌다 — 대신 반응이 가장 빠르다.

    돌려주는 것: 지금 우위인가(state), 그 상태가 시작된 날(cross_date),
    그날부터 며칠째인가(days), 그동안 코스피를 얼마나 앞섰나(excess_since).
    """
    rs = (pd.Series(values, index=axis_dates, dtype="float64")
          / pd.Series(base_values, index=axis_dates, dtype="float64")).dropna()
    if len(rs) < window + 2:
        return None

    ma = rs.rolling(window).mean()
    above = (rs - ma).dropna() > 0
    if above.empty:
        return None

    # 지금 상태가 시작된 지점 — 뒤에서부터 부호가 바뀐 첫 자리
    start = 0
    for i in range(len(above) - 1, 0, -1):
        if bool(above.iloc[i]) != bool(above.iloc[i - 1]):
            start = i
            break

    at = above.index[start]
    return {
        "state": "above" if bool(above.iloc[-1]) else "below",
        "window": window,
        "cross_date": at if start else None,     # start=0이면 구간 내내 같은 상태였다는 뜻
        "days": len(above) - 1 - start,
        "excess_since": round((float(rs.iloc[-1]) / float(rs.loc[at]) - 1) * 100, 2),
    }


def series_on_axis(payload: dict, axis_dates: list, key: str = "index"):
    """테마 JSON에 저장된 시계열을 현재 축에 다시 맞춘다.

    퇴행방지로 갱신을 건너뛴 테마는 어제 축에 맞춰진 배열을 갖고 있다. 길이로 잘라 붙이면
    하루씩 밀리므로 반드시 **날짜로** 맞춘다.
    """
    ser = (payload or {}).get("series") or {}
    dates, values = ser.get("dates"), ser.get(key)
    if not dates or not values:
        return None
    lut = dict(zip(dates, values))
    return [lut.get(d) for d in axis_dates]


def build_theme(theme: str, stocks: list, axis_dates: list, prev: dict, rebuild: bool) -> dict:
    """대테마 하나를 통째로 계산한다. 실패 종목은 건너뛰고 errors에 남긴다."""
    rows, closes, errors = [], [], []

    for st in sorted(stocks, key=lambda s: (s.get("order") or 9999, s["name"])):
        sym = symbol_of(st)
        try:
            df = history(sym)
            m = core.compute_metrics(df["Close"], df.get("High"))
        except Exception as e:  # noqa: BLE001
            errors.append({"name": st["name"], "symbol": sym, "error": str(e)})
            print(f"    [FAIL] {st['name']}({sym}): {e}", file=sys.stderr)
            continue
        rows.append({
            "name": st["name"], "code": st["code"], "market": st["market"],
            "symbol": sym, "role": st.get("role") or "기타",
            "desc": st.get("desc", ""), "note": st.get("note", ""),
            "order": st.get("order"), "market_cap": core.fetch_market_cap(sym), **m,
        })
        closes.append(df["Close"].dropna())
        print(f"    [OK] {st['name']:10s} {m['close']:>10,.0f}  1일 {m['r1d']:>7}  "
              f"1년 {m['r1y']:>8}  52주고점대비 {m['from_52w_high']:>7}")

    if not rows:
        raise RuntimeError(f"{theme}: 수집 성공 종목이 없음")

    # 역할 그룹 — 순서는 그룹 내 정렬순서 최솟값
    by_role = {}
    for r in rows:
        by_role.setdefault(r["role"], []).append(r)
    groups = []
    for role, members in by_role.items():
        groups.append({
            "role": role,
            "order": min((m["order"] or 9999) for m in members),
            "summary": core.average_metrics(members),
            "stocks": members,
        })
    groups.sort(key=lambda g: g["order"])

    pser = (prev or {}).get("series") or {}
    pdates = pser.get("dates") or []

    def make_index(series_list, count, stored):
        """구성종목 종가들로 동일가중 지수를 만들고, **적립분에 오늘치를 이어 붙인다**.

        지표는 새로 계산한 값이 아니라 적립된 시계열에서 뽑는다 — 그래야 화면의 표와 차트가
        같은 값을 가리킨다."""
        if not series_list:
            return None, None
        fresh = core.equal_weight_index(series_list)
        values = core.accumulate({} if rebuild else stored, fresh, axis_dates)
        kept = [(d, v) for d, v in zip(axis_dates, values) if v is not None]
        if len(kept) < 2:
            return None, None
        s = pd.Series([v for _, v in kept], index=pd.to_datetime([d for d, _ in kept]))
        m = core.compute_metrics(s)
        m["basis"] = "동일가중 지수 (구성종목 일간수익률 평균을 매일 이어 붙인 적립값)"
        m.pop("close", None)          # 지수 레벨은 표에 쓰지 않는다
        # 테마의 '사상 고점'은 구성종목이 계속 바뀌므로 의미가 없다 — 52주만 남긴다.
        for k in ("from_all_high", "high_all", "high_all_date"):
            m[k] = None
        m["count"] = count
        return m, values

    index_metrics, index_series = make_index(
        closes, len(rows), stored_map(pdates, pser.get("index")))

    # 시총 필터를 켰을 때 쓸 지수. 지수는 시계열이 있어야 만들 수 있어 프론트에서 계산할 수 없다.
    large = [(r, c) for r, c in zip(rows, closes)
             if r.get("market_cap") and r["market_cap"] >= CAP_THRESHOLD]
    index_large, index_large_series = make_index(
        [c for _, c in large], len(large), stored_map(pdates, pser.get("index_large")))

    now = datetime.now(KST)
    return {
        "theme": {"id": theme, "name": theme},
        # 종목마다 마지막 거래일이 다를 수 있다(거래정지 등) — 가장 최근 것을 그 테마의 기준일로 본다.
        "as_of": max(r["as_of"] for r in rows),
        "updated_at": now.strftime("%Y-%m-%d %H:%M"),
        "period_mode": core.PERIOD_MODE,
        "index": index_metrics,
        "index_large": index_large,          # 시총 필터를 켰을 때 쓰는 지수
        # 적립된 일별 지수 시계열(시장 거래일 축). 날짜를 같이 넣어 두는 이유는, 어떤 테마가
        # 퇴행방지로 갱신을 건너뛰어도 다음 실행에서 날짜로 다시 맞춰 이어 붙일 수 있어서다.
        "series": {
            "dates": axis_dates,
            "index": index_series,
            "index_large": index_large_series,
        },
        "cap_threshold": CAP_THRESHOLD,
        "groups": groups,
        "errors": errors,
    }


def main(argv: list) -> int:
    rebuild = "--rebuild-series" in argv        # 적립분을 버리고 현재 구성으로 다시 까는 비상용 스위치
    argv = [a for a in argv if not a.startswith("--")]

    universe = load_universe()
    stocks = [s for s in universe.get("stocks", []) if s.get("active", True)]
    if not stocks:
        raise SystemExit("유니버스가 비었습니다.")

    by_theme = {}
    for st in stocks:
        for t in st.get("themes", []):
            by_theme.setdefault(t, []).append(st)

    # 테마 순서는 이름 가나다순이다(한글 음절은 유니코드 순서가 곧 가나다순).
    # 종목의 정렬순서로 정하면 테마를 추가할 때마다 탭 순서가 흔들린다.
    wanted = argv or sorted(by_theme)
    unknown = [t for t in wanted if t not in by_theme]
    if unknown:
        raise SystemExit(f"유니버스에 없는 테마: {', '.join(unknown)}")

    print("  [시장] 코스피·코스닥 수집…")
    markets, market_closes = collect_markets()

    store = load_store()
    market_dates = [d.strftime("%Y-%m-%d") for d in market_closes[core.MARKETS[0][0]].index]
    axis_dates = build_axis(store, market_dates, rebuild)
    axis = pd.to_datetime(axis_dates)
    added = [d for d in axis_dates if d not in set(store["dates"])]
    print(f"    축 {len(axis_dates)}거래일"
          + (f" (신규 {len(added)}일: {', '.join(added[-3:])})" if store["dates"] else " — 최초 적립")
          + (" · --rebuild-series" if rebuild else ""))

    # 시장 지수도 같은 원칙으로 적립한다(지수 종가는 확정값이라 값은 같지만, 저장분을 우선한다).
    market_series = {}
    for m in markets:
        stored = {} if rebuild else stored_map(store["dates"], store["values"].get(m["id"]))
        fresh = core.align(market_closes[m["id"]], axis)
        market_series[m["id"]] = [stored.get(d, v) for d, v in zip(axis_dates, fresh)]

    THEMES_DIR.mkdir(parents=True, exist_ok=True)
    summaries, failed, stale = [], [], []
    kept = {}                      # 테마 → 이번에 사이트가 쓸 payload(신규 또는 기존)
    for theme in wanted:
        print(f"  [{theme}] 수집… ({len(by_theme[theme])}종목)")
        out_path = THEMES_DIR / f"{theme}.json"
        prev = load_json(out_path)

        try:
            payload = build_theme(theme, by_theme[theme], axis_dates, prev, rebuild)
        except Exception as e:  # noqa: BLE001
            failed.append(theme)
            print(f"  [FAIL] {theme}: {e}", file=sys.stderr)
            if prev:
                summaries.append(summarize(prev))   # 기존 값으로 탭은 살려 둔다
                kept[theme] = prev
            continue

        # 데이터 퇴행 방지 — 새로 받은 기준일이 이미 저장된 것보다 이전이면 덮어쓰지 않는다.
        # 야후가 자정 무렵 최신 거래일 봉을 일시적으로 빼고 주는 일이 있어서(2026-08-27 00:03에 재현),
        # 그대로 쓰면 사이트가 하루 뒤로 되돌아간다.
        if prev and payload["as_of"] < prev.get("as_of", ""):
            stale.append(theme)
            print(f"  [SKIP] {theme}: 받은 기준일 {payload['as_of']} < 저장된 {prev['as_of']} "
                  f"— 데이터 퇴행이라 기존 파일 유지", file=sys.stderr)
            summaries.append(summarize(prev))
            kept[theme] = prev
            continue

        out_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        summaries.append(summarize(payload))
        kept[theme] = payload

    if not summaries:
        print("모든 테마 실패 — 기존 JSON을 유지합니다.", file=sys.stderr)
        return 1

    # 시장을 이기기 시작한 시점 — 화면의 '우위 전환' 칸과 텔레그램 알림이 같은 값을 쓰도록
    # 여기서 한 번만 판정한다.
    base_values = market_series[core.MARKETS[0][0]]
    for sm in summaries:
        vals = series_on_axis(kept.get(sm["id"]), axis_dates)
        sm["rs"] = rs_signal(vals, base_values, axis_dates) if vals else None
        if sm["rs"]:
            r = sm["rs"]
            mark = "우위" if r["state"] == "above" else "열위"
            print(f"    [RS] {sm['name']:8s} {mark} D+{r['days']:<4d}"
                  f" (전환 {r['cross_date'] or '구간 이전'}) 이후 {r['excess_since']:+.2f}%p")

    now = datetime.now(KST)
    market_as_of = max(m["as_of"] for m in markets)

    # 표에 실리는 시장 지표(현재가·%1일 등)도 퇴행시키지 않는다 — 야후가 지수의 최신 봉을
    # 빼먹는 일이 있어서, 그대로 쓰면 코스피만 하루 뒤로 간 표가 나온다.
    prev_index = load_json(DATA / "index.json") or {}
    prev_markets = {m["id"]: m for m in (prev_index.get("markets") or [])}
    markets = [prev_markets[m["id"]]
               if prev_markets.get(m["id"], {}).get("as_of", "") > m["as_of"] else m
               for m in markets]
    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / "index.json").write_text(json.dumps({
        "updated_at": now.strftime("%Y-%m-%d %H:%M"),
        "as_of": max(s["as_of"] for s in summaries),
        "period_mode": core.PERIOD_MODE,
        "universe_source": universe.get("source", "unknown"),
        "markets": markets,          # 메인 화면의 비교 기준(코스피·코스닥)
        "themes": summaries,
        "failed_themes": failed,
        "stale_themes": stale,
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    # ── 일별 시계열 (메인 화면의 시장 비교 차트) ──────────────────────────
    # 테마 순서는 index.json과 같다. 프론트의 계열 색은 이 순서로 고정되므로,
    # 화면에서 몇 개를 껐다 켜도 남은 선의 색이 바뀌지 않는다.
    series_path = DATA / "series.json"
    prev_series = load_json(series_path) or {}
    # 시장 기준일이 뒤로 가도 파일을 통째로 건너뛰지 않는다.
    # 적립 구조라 축은 append-only고 시장 값도 저장분이 우선이라, 이미 쌓인 날이 지워질 일이 없다.
    # 통째로 건너뛰면 그날 새로 추가한 테마가 차트에 안 들어간다(2026-08-31에 실제로 그랬다 —
    # 야후가 지수의 8/28 봉을 빼먹어서 새 테마 5개가 통째로 빠졌다).
    if market_as_of < prev_series.get("as_of", ""):
        print(f"  [WARN] 시장 지수 기준일 {market_as_of} < 저장된 {prev_series['as_of']} "
              f"— 시장 값은 저장분을 쓰고 기준일도 유지한다", file=sys.stderr)
    theme_lines = []
    for sm in summaries:
        values = series_on_axis(kept.get(sm["id"]), axis_dates)
        if values:
            theme_lines.append({"id": sm["id"], "name": sm["name"], "values": values})
    series_path.write_text(json.dumps({
        "updated_at": now.strftime("%Y-%m-%d %H:%M"),
        "as_of": max(market_as_of, prev_series.get("as_of", "")),
        "dates": axis_dates,
        "markets": [{"id": m["id"], "name": m["name"], "values": market_series[m["id"]]}
                    for m in markets],
        "themes": theme_lines,
    }, ensure_ascii=False), encoding="utf-8")   # indent 없이 — 1,300일×계열이라 용량이 커진다

    print(f"  완료 — 테마 {len(summaries)}개"
          + (f", 실패 {len(failed)}개" if failed else "")
          + (f", 퇴행방지로 유지 {len(stale)}개" if stale else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
